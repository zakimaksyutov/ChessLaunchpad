import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getSessionStore } from '../data/SessionStore';
import { DataAccessError } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import { getExplorerEvals } from '../models/ExplorerEvals';
import { getEmptyRepertoireColors } from '../services/DashboardActions';
import { PendingEditModel, PendingDelta } from '../services/PendingEditModel';
import {
    BootstrapAccount,
    BootstrapColor,
    BootstrapGame,
    BootstrapSelection,
    collectBootstrapGames,
    selectRepertoire,
    serializeBootstrapGames,
    BOOTSTRAP_TARGET_GAMES,
} from '../services/RepertoireBootstrapService';
import { extractFsrsCardsFromRepertoires } from '../utils/RepertoiresSerde';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import ReviewView from '../components/ReviewView';
import { trackEvent } from '../AppInsights';
import './BootstrapPage.css';

type Stage =
    | 'running'
    | 'review'
    | 'empty'
    | 'no-accounts'
    | 'nothing-empty'
    | 'error';

type RunProgress =
    | { phase: 'downloading'; done: number; total: number }
    | { phase: 'analyzing'; done: number; total: number }
    | { phase: 'discovering' };

const PHASE_ORDER: RunProgress['phase'][] = ['downloading', 'analyzing', 'discovering'];

/** Apply a selection's edges to a model in the order produced (BFS, parent-first). */
function applySelection(model: PendingEditModel, selection: BootstrapSelection): void {
    for (const color of ['white', 'black'] as BootstrapColor[]) {
        for (const edge of selection[color]) {
            model.addEdge(edge.from, edge.san, edge.orientation);
        }
    }
}

function yieldToPaint(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

const BootstrapPage: React.FC = () => {
    const navigate = useNavigate();
    const dal = useMemo(() => getSessionStore().createDataAccessProxyLayer(), []);

    const [stage, setStage] = useState<Stage>('running');
    const [progress, setProgress] = useState<RunProgress>({ phase: 'downloading', done: 0, total: BOOTSTRAP_TARGET_GAMES });
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const [games, setGames] = useState<BootstrapGame[] | null>(null);
    const [selection, setSelection] = useState<BootstrapSelection | null>(null);
    const [delta, setDelta] = useState<PendingDelta | null>(null);
    const [reviewModel, setReviewModel] = useState<PendingEditModel | null>(null);

    const [saveInFlight, setSaveInFlight] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);

    // StrictMode-safe single run (see DashboardPage's deferred-abort note).
    const startedRef = useRef(false);
    const mountedRef = useRef(true);
    const abortRef = useRef<AbortController | null>(null);
    const pendingAbortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const proposedCount = selection ? selection.white.length + selection.black.length : 0;

    const run = useCallback(async () => {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        trackEvent('BootstrapStarted');
        try {
            const data = await dal.retrieveRepertoireData();
            if (ctrl.signal.aborted || !mountedRef.current) return;

            const emptyColors = getEmptyRepertoireColors(data.repertoires);
            if (emptyColors.length === 0) {
                setStage('nothing-empty');
                return;
            }
            const accounts: BootstrapAccount[] = (data.settings?.linkedAccounts ?? []).map(a => ({
                platform: a.platform || 'lichess',
                username: a.username.toLowerCase(),
            }));
            if (accounts.length === 0) {
                setStage('no-accounts');
                return;
            }

            const evals = await getExplorerEvals();
            if (ctrl.signal.aborted || !mountedRef.current) return;

            const collected = await collectBootstrapGames(
                accounts,
                evals,
                p => { if (mountedRef.current) setProgress(p); },
                ctrl.signal,
            );
            if (ctrl.signal.aborted || !mountedRef.current) return;
            setGames(collected);

            setProgress({ phase: 'discovering' });
            await yieldToPaint();
            if (ctrl.signal.aborted || !mountedRef.current) return;

            const sel = selectRepertoire(collected, emptyColors);
            const count = sel.white.length + sel.black.length;
            trackEvent('BootstrapCompleted', {
                gamesAnalyzed: collected.length,
                linesProposed: count,
            });
            if (count === 0) {
                setStage('empty');
                return;
            }

            const model = new PendingEditModel(data.repertoires ?? [], data.fsrsCards ?? {});
            applySelection(model, sel);
            if (!mountedRef.current) return;
            setSelection(sel);
            setReviewModel(model);
            setDelta(model.computeDelta());
            setStage('review');
        } catch (err: unknown) {
            if (ctrl.signal.aborted || !mountedRef.current) return;
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg);
            setStage('error');
        }
    }, [dal]);

    useEffect(() => {
        if (pendingAbortTimerRef.current) {
            clearTimeout(pendingAbortTimerRef.current);
            pendingAbortTimerRef.current = null;
        }
        mountedRef.current = true;
        if (!startedRef.current) {
            startedRef.current = true;
            void run();
        }
        return () => {
            mountedRef.current = false;
            // Defer the abort so a StrictMode synthetic remount can cancel it
            // before it fires (avoids killing the single in-flight run).
            pendingAbortTimerRef.current = setTimeout(() => {
                abortRef.current?.abort();
            }, 0);
        };
    }, [run]);

    const handleCancel = useCallback(() => {
        abortRef.current?.abort();
        navigate('/');
    }, [navigate]);

    const handleDownloadRaw = useCallback(() => {
        setMenuOpen(false);
        if (!games) return;
        const ndjson = serializeBootstrapGames(games);
        const blob = new Blob([ndjson], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bootstrap-input-${Date.now()}.ndjson`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, [games]);

    const handleSave = useCallback(async () => {
        if (!selection) return;
        setSaveInFlight(true);
        setSaveError(null);
        try {
            // Own proxy + fresh retrieve so the data and If-Match etag are taken
            // together (mirrors the Dashboard import flow's concurrency safety).
            const saveDal = getSessionStore().createDataAccessProxyLayer();
            const current = await saveDal.retrieveRepertoireData();
            const model = new PendingEditModel(current.repertoires ?? [], current.fsrsCards ?? {});
            applySelection(model, selection);

            const blob: RepertoireData = {
                repertoires: model.currentRepertoires,
                fsrsCards: extractFsrsCardsFromRepertoires(model.currentRepertoires),
                settings: current.settings,
                activity: current.activity,
                games: current.games,
                audit: current.audit,
            };
            await saveDal.storeRepertoireData(RepertoireDataUtils.prepareDataForSave(blob));
            trackEvent('BootstrapSaved', { linesSaved: proposedCount });
            navigate('/');
        } catch (err: unknown) {
            if (err instanceof DataAccessError && err.statusCode === 412) {
                // The app-root <ConflictModal> owns the reload prompt on a 412.
            } else if (mountedRef.current) {
                const msg = err instanceof Error ? err.message : String(err);
                setSaveError(`Save failed: ${msg}`);
            }
        } finally {
            if (mountedRef.current) setSaveInFlight(false);
        }
    }, [selection, proposedCount, navigate]);

    const handleDiscard = useCallback(() => {
        trackEvent('BootstrapDiscarded', { linesProposed: proposedCount });
        navigate('/');
    }, [navigate, proposedCount]);

    return (
        <div className="bootstrap-page">
            <div className="bootstrap-topbar">
                {stage !== 'review' && (
                    <Link className="bootstrap-back-link" to="/">← Dashboard</Link>
                )}
                {games && (
                    <div className="bootstrap-menu">
                        <button
                            type="button"
                            className="bootstrap-menu-btn"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label="More options"
                            title="More options"
                            onClick={() => setMenuOpen(o => !o)}
                        >
                            …
                        </button>
                        {menuOpen && (
                            <div className="bootstrap-menu-popover" role="menu">
                                <button type="button" role="menuitem" onClick={handleDownloadRaw}>
                                    Download raw input
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {stage === 'running' && (
                <ProgressPanel progress={progress} onCancel={handleCancel} />
            )}

            {stage === 'review' && delta && reviewModel && (
                <ReviewView
                    delta={delta}
                    rootFen={reviewModel.root}
                    onCancel={handleDiscard}
                    onSave={handleSave}
                    onDiscard={handleDiscard}
                    saveInFlight={saveInFlight}
                    backLabel="← Back to dashboard"
                    backAriaLabel="Discard and return to the dashboard"
                />
            )}

            {stage === 'empty' && (
                <div className="bootstrap-message">
                    <div className="bootstrap-message-emoji" aria-hidden="true">🌱</div>
                    <h1>No starter lines yet</h1>
                    <p>
                        We couldn&apos;t find enough consistent, engine-sound lines in your recent
                        games to seed a repertoire — when in doubt, we leave it out. Play a few more
                        games and try again, or import a PGN to get started.
                    </p>
                    <Link className="bootstrap-cta" to="/">Back to dashboard</Link>
                </div>
            )}

            {stage === 'no-accounts' && (
                <div className="bootstrap-message">
                    <div className="bootstrap-message-emoji" aria-hidden="true">🔗</div>
                    <h1>Link a chess account first</h1>
                    <p>
                        Building a starter repertoire reads the games you&apos;ve actually played.
                        Link a Lichess or Chess.com account, then come back here.
                    </p>
                    <Link className="bootstrap-cta" to="/settings">Go to Settings</Link>
                </div>
            )}

            {stage === 'nothing-empty' && (
                <div className="bootstrap-message">
                    <div className="bootstrap-message-emoji" aria-hidden="true">✅</div>
                    <h1>Your repertoire is already started</h1>
                    <p>Both colors already have positions, so there&apos;s nothing to seed.</p>
                    <Link className="bootstrap-cta" to="/">Back to dashboard</Link>
                </div>
            )}

            {stage === 'error' && (
                <div className="bootstrap-message">
                    <div className="bootstrap-message-emoji" aria-hidden="true">⚠️</div>
                    <h1>Something went wrong</h1>
                    <p>We couldn&apos;t build your starter repertoire{errorMsg ? `: ${errorMsg}` : ''}.</p>
                    <Link className="bootstrap-cta" to="/">Back to dashboard</Link>
                </div>
            )}

            {saveError && (
                <div className="bootstrap-save-error" role="alert">{saveError}</div>
            )}
        </div>
    );
};

export default BootstrapPage;

// ── Progress panel ───────────────────────────────────────────────────

const PHASE_LABELS: Record<RunProgress['phase'], string> = {
    downloading: 'Downloading your last games',
    analyzing: 'Analyzing games',
    discovering: 'Discovering sound lines',
};

const ProgressPanel: React.FC<{
    progress: RunProgress;
    onCancel: () => void;
}> = ({ progress, onCancel }) => {
    const currentIndex = PHASE_ORDER.indexOf(progress.phase);
    return (
        <div className="bootstrap-progress">
            <h1>Building your starter repertoire</h1>
            <p className="bootstrap-progress-sub">
                Reading your recent games, checking each move against a strong engine, and keeping
                only the lines you play consistently. This runs entirely in your browser.
            </p>
            <ul className="bootstrap-phases">
                {PHASE_ORDER.map((phase, i) => {
                    const status = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
                    return (
                        <li key={phase} className={`bootstrap-phase bootstrap-phase--${status}`}>
                            <span className="bootstrap-phase-marker" aria-hidden="true">
                                {status === 'done' ? '✓' : status === 'active'
                                    ? <span className="bootstrap-spinner" /> : '○'}
                            </span>
                            <span className="bootstrap-phase-label">{PHASE_LABELS[phase]}</span>
                            <span className="bootstrap-phase-count">
                                {status === 'active' && progress.phase === 'downloading' &&
                                    `${progress.done} / up to ${progress.total}`}
                                {status === 'active' && progress.phase === 'analyzing' &&
                                    `${progress.done} / ${progress.total}`}
                                {status === 'done' && '✓'}
                            </span>
                        </li>
                    );
                })}
            </ul>
            <button type="button" className="bootstrap-cancel" onClick={onCancel}>
                Cancel
            </button>
        </div>
    );
};
