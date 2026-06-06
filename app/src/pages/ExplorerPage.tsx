import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import ChessboardControl from '../components/ChessboardControl';
import ReviewView from '../components/ReviewView';
import { IDataAccessLayer, DataAccessError, createDataAccessLayer } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import {
    ExplorerService,
    Orientation,
    Path,
    Continuation,
    formatPlyLabelParts,
} from '../services/ExplorerService';
import {
    DatabaseOpening,
    DatabaseOpeningsUtils,
} from '../utils/DatabaseOpeningsUtils';
import {
    isUserTurnForOrientation,
    normalizeFenResetHalfmoveClock,
} from '../utils/FenUtils';
import { GraphEdge } from '../services/RepertoireGraph';
import { Annotation } from '../models/Annotation';
import { PendingEditModel } from '../services/PendingEditModel';
import { PendingEditNotifier } from '../services/PendingEditNotifier';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { extractFsrsCardsFromRepertoires } from '../utils/RepertoiresSerde';
import './ExplorerPage.css';

// ── Constants ────────────────────────────────────────────────────────

const REFRESH_THROTTLE_MS = 2000;

function persistedOrientationKey(): string {
    const u = localStorage.getItem('username') ?? '';
    return `explorer:orientation:${u}`;
}

function readPersistedOrientation(): Orientation | null {
    try {
        const v = localStorage.getItem(persistedOrientationKey());
        if (v === 'white' || v === 'black') return v;
    } catch { /* ignore */ }
    return null;
}

function writePersistedOrientation(orientation: Orientation): void {
    try {
        localStorage.setItem(persistedOrientationKey(), orientation);
    } catch { /* ignore */ }
}

// ── Small helpers ────────────────────────────────────────────────────

/**
 * Render a Date as "due now" / "due in 14d" / "due in 3 mo" / "due in 1d 4h".
 * Coarse-grained, optimized for at-a-glance readability in a dense row.
 */
function formatDueRelative(due: Date, now: Date): string {
    const diffMs = due.getTime() - now.getTime();
    if (diffMs <= 0) return 'due now';
    const sec = Math.round(diffMs / 1000);
    const min = Math.round(sec / 60);
    const hr = Math.round(min / 60);
    const day = Math.round(hr / 24);
    if (sec < 60) return 'due in < 1 min';
    if (min < 60) return `due in ${min} min`;
    if (hr < 48) return `due in ${hr}h`;
    if (day < 60) return `due in ${day}d`;
    const mo = Math.round(day / 30);
    if (mo < 24) return `due in ${mo} mo`;
    const yr = (day / 365).toFixed(1);
    return `due in ${yr} yr`;
}

/** "last 5d ago" / "last 22d ago" / "last 3 mo ago". */
function formatLastReviewed(when: Date, now: Date): string {
    const diffMs = Math.max(0, now.getTime() - when.getTime());
    const day = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
    if (day < 60) return `last ${day}d ago`;
    const mo = Math.round(day / 30);
    if (mo < 24) return `last ${mo} mo ago`;
    const yr = (day / 365).toFixed(1);
    return `last ${yr} yr ago`;
}

/** Move number derived from ply depth (1-based). */
function moveNumberOf(depth: number): number {
    return Math.ceil(depth / 2);
}

// ── Subcomponents ────────────────────────────────────────────────────

interface ClickablePlyProps {
    /** Non-clickable prefix (e.g. "1.", "3…"). Empty string renders nothing. */
    prefix?: string;
    /** Clickable SAN (e.g. "e4", "Nbd7"). */
    san: string;
    targetFen: string;
    onJump: (fen: string) => void;
    className?: string;
}

const ClickablePly: React.FC<ClickablePlyProps> = ({ prefix, san, targetFen, onJump, className }) => (
    <span className="explorer-ply-token">
        {prefix ? <span className="explorer-ply-prefix">{prefix}</span> : null}
        <button
            type="button"
            className={`explorer-ply ${className ?? ''}`}
            onClick={() => onJump(targetFen)}
        >
            {san}
        </button>
    </span>
);

/**
 * Renders the canonical-form PGN of a path with each ply clickable. Plies
 * land on the position AFTER they are played. The move number prefix is
 * rendered as plain text outside the click target.
 */
/**
 * "start" pill — renders as an interactive button when `onJump` is provided
 * (jumps to `rootFen`), or as a static visual badge when the Explorer is
 * already at the starting position.
 */
const StartPill: React.FC<{ onJump?: (fen: string) => void; rootFen?: string }> = ({ onJump, rootFen }) => {
    if (onJump && rootFen) {
        return (
            <button
                type="button"
                className="explorer-path-start"
                onClick={() => onJump(rootFen)}
                aria-label="Go to starting position"
                title="Go to starting position"
            >
                start
            </button>
        );
    }
    return (
        <span
            className="explorer-path-start explorer-path-start-static"
            aria-label="Starting position"
            title="Starting position"
        >
            start
        </span>
    );
};

const PathLine: React.FC<{
    path: Path;
    rootFen: string;
    onJump: (fen: string) => void;
}> = ({ path, rootFen, onJump }) => {
    if (path.length === 0) return <StartPill />;
    const parts = formatPlyLabelParts(
        path.map((_, i) => i + 1),
        path.map(e => e.san),
    );
    return (
        <span className="explorer-path-line">
            <StartPill onJump={onJump} rootFen={rootFen} />
            {path.map((edge, i) => (
                <ClickablePly
                    key={i}
                    prefix={parts[i].prefix}
                    san={parts[i].san}
                    targetFen={edge.to}
                    onJump={onJump}
                />
            ))}
        </span>
    );
};

/**
 * Render the canonical continuation underneath a move row. We deliberately
 * skip the row's own ply (which is already shown in the heading), so the
 * continuation starts with the next ply.
 */
const ContinuationLine: React.FC<{
    continuation: Continuation;
    onJump: (fen: string) => void;
}> = ({ continuation, onJump }) => {
    const { plies, tail } = continuation;
    const elements: React.ReactNode[] = [];

    // Skip plies[0] — it is the row's own move, already shown in the heading.
    const displayPlies = plies.slice(1);
    const parts = formatPlyLabelParts(
        displayPlies.map(p => p.plyDepth),
        displayPlies.map(p => p.san),
    );

    for (let i = 0; i < displayPlies.length; i++) {
        const p = displayPlies[i];
        elements.push(
            <ClickablePly
                key={`ply-${i}`}
                prefix={parts[i].prefix}
                san={parts[i].san}
                targetFen={p.toFen}
                onJump={onJump}
            />
        );
    }

    if (tail.kind === 'branch') {
        // Each alternative is a child edge from `tail.afterFen` and lives at the
        // depth right after the last walked ply. Render each with its own move
        // number prefix so the user can see the depth at a glance.
        const altDepth = plies.length > 0 ? plies[plies.length - 1].plyDepth + 1 : 1;
        const altIsWhite = altDepth % 2 === 1;
        const altMoveNumber = Math.ceil(altDepth / 2);
        const altPrefix = altIsWhite ? `${altMoveNumber}.` : `${altMoveNumber}\u2026`;

        elements.push(
            <span key="alt-open" className="explorer-alt-paren">{'('}</span>
        );
        tail.alternatives.forEach((san, idx) => {
            const chess = new Chess(tail.afterFen);
            try {
                chess.move(san);
            } catch {
                // If the move is illegal (shouldn't happen — edge data drove it),
                // skip the alternative.
                return;
            }
            const childFen = normalizeFenResetHalfmoveClock(chess.fen());
            if (idx > 0) elements.push(<span key={`alt-sep-${idx}`} className="explorer-alt-sep">, </span>);
            elements.push(
                <ClickablePly
                    key={`alt-${idx}`}
                    prefix={altPrefix}
                    san={san}
                    targetFen={childFen}
                    onJump={onJump}
                />
            );
        });
        elements.push(
            <span key="alt-close" className="explorer-alt-paren">{')'}</span>
        );
    } else if (tail.kind === 'open') {
        // The continuation was truncated by the defensive depth cap. Tell the
        // user the line continues so they don't mistake it for an end-of-line.
        elements.push(
            <span key="open" className="explorer-end-marker"> …</span>
        );
    }
    // tail.kind === 'end' renders nothing extra — the absence of a marker is
    // itself the end-of-line signal.

    return <span className="explorer-continuation-line">{elements}</span>;
};

interface MoveRowProps {
    edge: GraphEdge;
    orientation: Orientation;
    isUserMove: boolean;
    onJump: (fen: string) => void;
    service: ExplorerService;
    currentDepth: number;
    currentPgn: string;
    now: Date;
    /** When set, renders a trash button that calls this with (from, san) */
    onDelete?: (from: string, san: string) => void;
}

const MoveRow: React.FC<MoveRowProps> = ({
    edge,
    orientation,
    isUserMove,
    onJump,
    service,
    currentDepth,
    currentPgn,
    now,
    onDelete,
}) => {
    const continuation = useMemo(
        () => service.expandContinuation(currentDepth, edge, orientation),
        [service, currentDepth, edge, orientation],
    );

    const card = isUserMove ? service.cardInfo(edge.from, edge.san, now) : null;

    // Opening label diff: does playing this move change the classification?
    const afterLabel = useMemo(
        () => service.classificationChanges(currentPgn, edge.san),
        [service, currentPgn, edge.san],
    );

    const rowDepth = currentDepth + 1;
    const rowMoveNumber = moveNumberOf(rowDepth);
    const isWhitePly = rowDepth % 2 === 1;
    const rowPrefix = isWhitePly ? `${rowMoveNumber}.` : `${rowMoveNumber}\u2026`;

    return (
        <div className={`explorer-move-row ${isUserMove ? '' : 'opponent'}`}>
            <div className="explorer-move-row-head">
                <span className="explorer-ply-token">
                    <span className="explorer-move-row-prefix">{rowPrefix}</span>
                    <button
                        type="button"
                        className={`explorer-move-san ${card ? `state-${card.status.toLowerCase()}` : ''}`}
                        onClick={() => onJump(edge.to)}
                        title={`Jump to position after ${edge.san}`}
                    >
                        {edge.san}
                    </button>
                </span>
                {card && card.status === 'New' && (
                    <span className="explorer-state-pill state-new">New</span>
                )}
                {card && card.status !== 'New' && (
                    <>
                        <span className={`explorer-state-pill state-${card.status.toLowerCase()}`}>
                            {card.status}
                        </span>
                        <span className="explorer-meta">
                            {card.dueAt ? formatDueRelative(card.dueAt, now) : ''}
                        </span>
                        {card.retrievability !== undefined && (
                            <span className="explorer-meta">R {(card.retrievability * 100).toFixed(0)}%</span>
                        )}
                        <span className="explorer-meta">
                            {card.reps} reps · {card.lapses} {card.lapses === 1 ? 'lapse' : 'lapses'}
                        </span>
                        {card.lastReviewedAt && (
                            <span className="explorer-meta">{formatLastReviewed(card.lastReviewedAt, now)}</span>
                        )}
                    </>
                )}
                {afterLabel && (
                    <span className="explorer-opening-chip" title={`${afterLabel.eco} ${afterLabel.name}`}>
                        → {afterLabel.name}
                    </span>
                )}
                {onDelete && (
                    <button
                        type="button"
                        className="explorer-move-delete"
                        onClick={() => onDelete(edge.from, edge.san)}
                        aria-label={`Delete ${edge.san} from repertoire`}
                        title={`Delete ${edge.san} from repertoire`}
                    >
                        ×
                    </button>
                )}
            </div>
            <div className="explorer-move-row-cont">
                <ContinuationLine continuation={continuation} onJump={onJump} />
            </div>
        </div>
    );
};

// ── Main page ─────────────────────────────────────────────────────────

const ExplorerPage: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    const [data, setData] = useState<RepertoireData | null>(null);
    // Openings start as null while loading. If the static asset fetch fails we
    // fall back to `[]` so the page is still usable (with opening labels omitted).
    const [openings, setOpenings] = useState<DatabaseOpening[] | null>(null);
    const [loading, setLoading] = useState(true);
    // `refreshing` is set on visibility-driven re-fetches so the page can
    // revalidate in the background without flashing the loading state.
    const [, setRefreshing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [snapToast, setSnapToast] = useState<string | null>(null);
    const [findInput, setFindInput] = useState('');
    const [findError, setFindError] = useState<string | null>(null);

    // ── Edit-mode state ─────────────────────────────────────────────
    //
    // `mode`:
    //   - 'read'   — today's behavior, board non-interactive
    //   - 'edit'   — pill toggled to Edit; pendingModel is non-null
    // `view`:
    //   - 'main'   — the board + move list (works in both read and edit)
    //   - 'review' — Review & Save full-page list (edit only)
    //
    // The Cancel/Back rule in EXPLORER-EDIT.md is "return to Edit with the
    // delta intact" — we keep the model alive on the page across Read↔Edit
    // toggles unless the user explicitly Discards or Saves.
    const [mode, setMode] = useState<'read' | 'edit'>('read');
    const [pendingModel, setPendingModel] = useState<PendingEditModel | null>(null);
    // Bump on every mutation to PendingEditModel so derived memos re-run.
    const [pendingTick, setPendingTick] = useState(0);
    const bumpPending = useCallback(() => setPendingTick(t => t + 1), []);

    // The Review view is driven by `?review=1` in the URL so that browser
    // Back from Review pops the param and lands the user back on Edit's
    // main view — the spec calls this out as required ("Cancel and browser
    // Back are equivalent: both return to Edit mode with the delta intact").
    // The param is stripped automatically when the user lands in Read mode
    // (see `enterReviewView`/`exitReviewView`).
    const view: 'main' | 'review' = (mode === 'edit' && searchParams.get('review') === '1')
        ? 'review'
        : 'main';

    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveInFlight, setSaveInFlight] = useState(false);
    const [conflictPrompt, setConflictPrompt] = useState(false);
    const [discardPrompt, setDiscardPrompt] = useState(false);

    // Tick `now` once a minute so the relative due/last labels update.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(id);
    }, []);

    const lastFetchAtRef = useRef<number>(0);
    const fetchSeqRef = useRef<number>(0);
    const openingsRef = useRef<DatabaseOpening[] | null>(null);
    const dataRef = useRef<RepertoireData | null>(null);

    const dal: IDataAccessLayer = useMemo(() => {
        const username = localStorage.getItem('username') ?? '';
        const password = localStorage.getItem('hashedPassword') ?? '';
        return createDataAccessLayer(username, password);
    }, []);

    const fetchAll = useCallback(async (force = false) => {
        const sinceLast = Date.now() - lastFetchAtRef.current;
        if (!force && sinceLast < REFRESH_THROTTLE_MS) return;
        lastFetchAtRef.current = Date.now();
        const seq = ++fetchSeqRef.current;
        const isFirstLoad = !dataRef.current;
        try {
            if (isFirstLoad) setLoading(true); else setRefreshing(true);
            // Fetch openings independently of the repertoire blob — a failure
            // here must not block the Explorer from working (we just lose the
            // opening labels).
            const opsPromise = openingsRef.current
                ? Promise.resolve(openingsRef.current)
                : DatabaseOpeningsUtils.DownloadOpenings()
                    .catch((e) => {
                        console.warn('Failed to load openings.tsv — opening labels disabled:', e);
                        return [] as DatabaseOpening[];
                    });
            const [d, ops] = await Promise.all([
                dal.retrieveRepertoireData(),
                opsPromise,
            ]);
            if (seq !== fetchSeqRef.current) return; // stale
            dataRef.current = d;
            openingsRef.current = ops;
            setData(d);
            setOpenings(ops);
            setLoadError(null);
        } catch (e: any) {
            if (seq !== fetchSeqRef.current) return;
            setLoadError(e?.message ?? String(e));
        } finally {
            if (seq === fetchSeqRef.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, [dal]);

    useEffect(() => {
        void fetchAll(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Cross-tab freshness: re-fetch when the page regains visibility — but
    // ONLY when no Edit session is in flight. Refreshing mid-edit would swap
    // out the DAL's captured ETag (and the page's `data`) under the user's
    // feet, silently defeating the 412 conflict path that protects
    // concurrent edits (see `handleSave`'s catch block). The pending model
    // already holds the snapshot it was started against; surfacing newer
    // server state is deferred until the user finishes or discards the
    // session — same trade-off the spec calls out for ungated background
    // game ingestion ("ETag safety net it would buy").
    useEffect(() => {
        const onVis = () => {
            if (document.visibilityState !== 'visible') return;
            if (pendingModel) return; // edit session active — don't trample the ETag
            void fetchAll(false);
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, [fetchAll, pendingModel]);

    // In Read mode, the ExplorerService reads the persisted blob. In Edit
    // mode it reads the PendingEditModel's working copy so the user sees the
    // effects of their drops/deletes immediately (the move list, "How you got
    // here", and the board's annotations all reflect the pending state).
    const service = useMemo(() => {
        if (!data || !openings) return null;
        if (mode === 'edit' && pendingModel) {
            // pendingTick rebuilds the service on every mutation; it doesn't
            // need to be referenced in the body — the dep array does the work.
            void pendingTick;
            const editData: RepertoireData = {
                repertoires: pendingModel.currentRepertoires,
                // Build an inline flat card map: base cards minus any keys that
                // no longer have a corresponding edge, plus any new cards from
                // this session. The new-card map IS the authority for adds.
                fsrsCards: {
                    ...extractFsrsCardsFromRepertoires(pendingModel.currentRepertoires),
                },
                settings: data.settings,
                activity: data.activity,
                games: data.games,
            };
            return new ExplorerService(editData, openings);
        }
        return new ExplorerService(data, openings);
    }, [data, openings, mode, pendingModel, pendingTick]);

    // Resolve URL parameters into a concrete (orientation, fen).
    const explicitOrientationParam = searchParams.get('o');
    const fenParam = searchParams.get('fen');

    const resolvedOrientation: Orientation = useMemo(() => {
        if (explicitOrientationParam === 'white' || explicitOrientationParam === 'black') {
            return explicitOrientationParam;
        }
        return readPersistedOrientation() ?? 'white';
    }, [explicitOrientationParam]);

    const [currentFen, setCurrentFen] = useState<string | null>(null);

    // When data + URL settle, resolve the FEN (snap to root if necessary).
    useEffect(() => {
        if (!service) return;

        const root = service.getRootFen();
        const desiredFen = fenParam ? fenParam : root;

        if (service.isInRepertoire(desiredFen, resolvedOrientation)) {
            setCurrentFen(desiredFen);
            // Canonicalize URL with explicit ?o= when missing.
            if (!explicitOrientationParam) {
                const next = new URLSearchParams(searchParams);
                next.set('o', resolvedOrientation);
                setSearchParams(next, { replace: true });
            }
            return;
        }

        // Off-repertoire: snap to root, emit toast, replace URL.
        setCurrentFen(root);
        setSnapToast(`That position isn't in your ${resolvedOrientation} repertoire — opened the starting position instead.`);
        const next = new URLSearchParams(searchParams);
        next.set('o', resolvedOrientation);
        next.delete('fen');
        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [service, fenParam, resolvedOrientation, explicitOrientationParam]);

    // Persist orientation whenever it changes.
    useEffect(() => {
        writePersistedOrientation(resolvedOrientation);
    }, [resolvedOrientation]);

    // Auto-dismiss the off-repertoire snap toast after a few seconds so it
    // doesn't linger (position: sticky) as the user navigates the repertoire.
    useEffect(() => {
        if (!snapToast) return;
        const id = window.setTimeout(() => setSnapToast(null), 4000);
        return () => window.clearTimeout(id);
    }, [snapToast]);

    const jumpTo = useCallback((fen: string, orientation?: Orientation, push = true) => {
        const next = new URLSearchParams(searchParams);
        const targetOrientation = orientation ?? resolvedOrientation;
        next.set('o', targetOrientation);
        if (fen) next.set('fen', fen); else next.delete('fen');
        setSearchParams(next, { replace: !push });
        setFindInput('');
        setFindError(null);
    }, [searchParams, setSearchParams, resolvedOrientation]);

    const handleToggleOrientation = () => {
        if (!service || !currentFen) return;
        const other: Orientation = resolvedOrientation === 'white' ? 'black' : 'white';
        if (service.isInRepertoire(currentFen, other)) {
            jumpTo(currentFen, other, true);
        } else {
            // Snap to root of the other orientation.
            jumpTo(service.getRootFen(), other, true);
        }
    };

    const handleFindSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!service) return;
        const result = service.findPosition(findInput, resolvedOrientation);
        if (!result) {
            setFindError(`Not in your ${resolvedOrientation} repertoire.`);
            return;
        }
        setFindError(null);
        jumpTo(result.fen, result.orientation, true);
    };

    // ── Edit mode: enter/exit, mutations, save/discard ───────────────

    /**
     * Enter Edit mode: snapshot the current persisted blob into a
     * PendingEditModel. Preserves the model across orientation toggles and
     * navigations inside `/explorer` — only Save, Discard, hard navigation,
     * or page reload destroys it.
     */
    /**
     * Helper: pop the `?review=1` flag off the URL (replace, no history push)
     * so a sub-flow that lands the user back on the main view doesn't leave
     * a stray review entry behind that browser Back could re-enter.
     */
    const stripReviewParam = useCallback(() => {
        if (searchParams.get('review') === '1') {
            const next = new URLSearchParams(searchParams);
            next.delete('review');
            setSearchParams(next, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    /** Open the Review view by pushing a `?review=1` history entry. */
    const enterReviewView = useCallback(() => {
        if (searchParams.get('review') === '1') return;
        const next = new URLSearchParams(searchParams);
        next.set('review', '1');
        setSearchParams(next); // push — so browser Back returns to main
    }, [searchParams, setSearchParams]);

    /** Cancel/back from Review explicitly — go through the same back-stack pop. */
    const exitReviewView = useCallback(() => {
        if (searchParams.get('review') === '1') {
            // Walk history one step back so browser Back and the Cancel
            // button produce the same URL trail. If for some reason that
            // overshoots (rare — would mean the user manually deep-linked
            // to ?review=1), fall back to stripping the param.
            window.history.back();
        }
    }, [searchParams]);

    const enterEditMode = useCallback(() => {
        if (!data) return;
        if (!pendingModel) {
            const reps = data.repertoires ?? [];
            const cards = data.fsrsCards ?? extractFsrsCardsFromRepertoires(reps);
            setPendingModel(new PendingEditModel(reps, cards));
        }
        setMode('edit');
        stripReviewParam();
    }, [data, pendingModel, stripReviewParam]);

    /**
     * Read-mode toggle. Does NOT clear the pending model — the user can flip
     * back to Edit and continue where they left off. The Read view simply
     * shows the persisted blob (via the read-mode service) while the model
     * is parked.
     */
    const exitToReadMode = useCallback(() => {
        setMode('read');
        stripReviewParam();
    }, [stripReviewParam]);

    /**
     * Memoized delta so the sticky bar + Review view re-render only when the
     * pending model actually changes. Also drives `isDirty` below — keep it
     * the single source of truth to avoid recomputing the delta twice per
     * render (once here, once via `isEmpty()`).
     */
    const delta = useMemo(() => {
        void pendingTick;
        return pendingModel ? pendingModel.computeDelta() : null;
    }, [pendingModel, pendingTick]);

    /** True when the model holds at least one staged change. */
    const isDirty = !!delta &&
        (delta.counts.added + delta.counts.removed + delta.counts.changed) > 0;

    // Reflect dirty state into the cross-page notifier so Training (and the
    // header eventually) can prompt the user.
    useEffect(() => {
        PendingEditNotifier.setPending(isDirty);
        return () => PendingEditNotifier.setPending(false);
    }, [isDirty]);

    // beforeunload warning when the user has unsaved edits. Tab close, hard
    // refresh, and navigation to non-/explorer routes trigger this; in-page
    // hash navigation does not.
    useEffect(() => {
        if (!isDirty) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Most browsers ignore the returned string today, but Chrome
            // still requires setting returnValue to fire the dialog.
            e.returnValue = '';
            return '';
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [isDirty]);

    // SPA navigation gate. HashRouter `<Link>` clicks do NOT fire
    // `beforeunload`, so a header click would silently destroy the pending
    // delta on unmount. Intercept anchor clicks on the document while dirty
    // and prompt the user — same destructive-action confirm wording as the
    // sticky-bar Discard. If the user confirms, we strip dirty state via
    // confirmDiscard and let the click proceed on the second invocation.
    //
    // Companion guards:
    //   - Header.tsx intercepts the imperative `navigate('/settings')` and
    //     `navigate('/')` (logout) flows by consulting the same notifier.
    //   - The `popstate` listener below catches browser Back/Forward when
    //     the URL leaves `/explorer` mid-edit and bounces back if the user
    //     cancels.
    useEffect(() => {
        if (!isDirty) return;
        const handler = (e: MouseEvent) => {
            // Honor modifier-clicks (new tab/window) — the user is opening
            // the target in a new context, not abandoning this one.
            if (e.defaultPrevented || e.button !== 0
                || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            // Find the anchor ancestor of the click target.
            let el = e.target as HTMLElement | null;
            while (el && el.tagName !== 'A') el = el.parentElement;
            if (!el) return;
            const anchor = el as HTMLAnchorElement;
            // Only intercept in-app hash links that go to a DIFFERENT route.
            const href = anchor.getAttribute('href') ?? '';
            if (!href.startsWith('#/')) return;
            // Compare just the route segment (before any query string).
            const targetRoute = href.replace(/^#/, '').split('?')[0];
            if (targetRoute.startsWith('/explorer')) return; // staying inside Explorer
            const confirmed = window.confirm(
                'You have unsaved repertoire edits. Leaving this page will discard them. Continue?',
            );
            if (!confirmed) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // User chose to abandon — clear the model so beforeunload (and
            // the next click) don't re-prompt.
            setDiscardPrompt(false);
            setConflictPrompt(false);
            setPendingModel(null);
            setMode('read');
            // The synchronous click will proceed and React Router will
            // navigate; nothing else for us to do.
        };
        document.addEventListener('click', handler, true);
        return () => document.removeEventListener('click', handler, true);
    }, [isDirty]);

    // Update the global popstate guard's "last safe URL" tracker whenever
    // the explorer URL settles. The notifier holds a window-level popstate
    // listener that bounces the user back to this URL on a cancel — see
    // PendingEditNotifier for why it's a module-level listener.
    useEffect(() => {
        if (window.location.hash.startsWith('#/explorer')) {
            PendingEditNotifier.setLastSafeHash(window.location.hash);
        }
    });

    /** Board-driven "Add move" handler in Edit mode. */
    const handleBoardMove = useCallback((from: string, to: string): boolean => {
        if (mode !== 'edit' || !pendingModel || !currentFen || !service) return false;

        // Translate (from, to) squares into a SAN string via chess.js.
        // We attempt every legal move from the current FEN to find the SAN
        // that matches — chess.js' UCI parsing is rigid about promotions.
        try {
            const chess = new Chess(currentFen);
            const moves = chess.moves({ verbose: true });
            const match = moves.find(m => m.from === from && m.to === to);
            if (!match) return false;
            const san = match.san;
            const newFen = pendingModel.addEdge(currentFen, san, resolvedOrientation);
            if (!newFen) return false;
            bumpPending();
            // Auto-navigate to the new position so the user can keep building.
            jumpTo(newFen, undefined, true);
            return true;
        } catch {
            return false;
        }
    }, [mode, pendingModel, currentFen, service, resolvedOrientation, bumpPending, jumpTo]);

    /** Per-row delete handler. */
    const handleDeleteEdge = useCallback((from: string, san: string) => {
        if (!pendingModel) return;
        pendingModel.deleteEdge(from, san, resolvedOrientation);
        bumpPending();
    }, [pendingModel, resolvedOrientation, bumpPending]);

    /** Annotation gesture (right-click arrow / square highlight). */
    const handleAnnotationsChanged = useCallback((fen: string, anns: Annotation[]) => {
        if (mode !== 'edit' || !pendingModel) return;
        pendingModel.setAnnotations(fen, resolvedOrientation, anns);
        bumpPending();
    }, [mode, pendingModel, resolvedOrientation, bumpPending]);

    /** Sticky-bar Save handler. */
    const handleSave = useCallback(async () => {
        if (!pendingModel || !data) return;
        setSaveInFlight(true);
        setSaveError(null);
        try {
            // Build the in-memory blob to save. The model owns repertoires +
            // any new cards; combine with the base FSRS cards (still in
            // `data.fsrsCards`) and let `prepareDataForSave` project the
            // result into the position-centric wire shape.
            const baseCards = data.fsrsCards ?? {};
            // Cards we keep: every card that still has a corresponding edge
            // in the working repertoires. `extractFsrsCardsFromRepertoires`
            // gives us exactly that view, with both base-resurrected and
            // newly-minted cards reachable from the dict.
            const liveCards = extractFsrsCardsFromRepertoires(pendingModel.currentRepertoires);
            // Merge: live takes precedence (it already holds the new cards
            // attached to fresh edges). Base contributes nothing the dict
            // doesn't already carry, but we keep the merge so any unrelated
            // legacy bookkeeping survives.
            const mergedCards = { ...baseCards, ...liveCards };

            const blobInMemory: RepertoireData = {
                repertoires: pendingModel.currentRepertoires,
                fsrsCards: mergedCards,
                settings: data.settings,
                activity: data.activity,
                games: data.games,
            };
            const wire = RepertoireDataUtils.prepareDataForSave(blobInMemory);
            await dal.storeRepertoireData(wire);
            // Reload to the canonical persisted state so the in-memory model
            // and the persisted blob agree.
            dataRef.current = null;
            setPendingModel(null);
            setMode('read');
            stripReviewParam();
            await fetchAll(true);
        } catch (err: unknown) {
            if (err instanceof DataAccessError && err.statusCode === 412) {
                setConflictPrompt(true);
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                setSaveError(`Save failed: ${msg}`);
            }
        } finally {
            setSaveInFlight(false);
        }
    }, [pendingModel, data, dal, fetchAll, stripReviewParam]);

    /** Conflict prompt: "Refresh" discards local edits and re-fetches. */
    const handleConflictRefresh = useCallback(async () => {
        setConflictPrompt(false);
        setPendingModel(null);
        setMode('read');
        stripReviewParam();
        dataRef.current = null;
        await fetchAll(true);
    }, [fetchAll, stripReviewParam]);

    /** Sticky-bar Discard handler (always prompts when delta non-empty). */
    const requestDiscard = useCallback(() => {
        if (!pendingModel || pendingModel.isEmpty()) {
            // Trivial discard: nothing to confirm.
            setPendingModel(null);
            setMode('read');
            stripReviewParam();
            return;
        }
        setDiscardPrompt(true);
    }, [pendingModel, stripReviewParam]);

    const confirmDiscard = useCallback(() => {
        setDiscardPrompt(false);
        setPendingModel(null);
        setMode('read');
        stripReviewParam();
    }, [stripReviewParam]);

    // ── Render guards ────────────────────────────────────────────────

    if (loadError) {
        return (
            <div className="explorer-page">
                <div className="explorer-error">Failed to load repertoire: {loadError}</div>
            </div>
        );
    }
    if (loading || !service || !currentFen) {
        return (
            <div className="explorer-page">
                <div className="explorer-loading">Loading repertoire…</div>
            </div>
        );
    }

    // ── Derived state for the page body ───────────────────────────────

    const canonical = service.canonicalPath(currentFen, resolvedOrientation) ?? [];
    const currentPgn = service.pathToPgn(canonical);
    const currentDepth = canonical.length;
    const summary = service.summarizePaths(currentFen, resolvedOrientation);
    const edges = service.getEdges(currentFen, resolvedOrientation);
    const annotations = service.getAnnotations(currentFen, resolvedOrientation);
    const currentLabel = service.classifyPath(canonical);
    const isUserTurn = isUserTurnForOrientation(currentFen, resolvedOrientation);
    const movesHeading = isUserTurn ? 'Your moves from here' : "Opponent's replies";
    const emptyMessage = isUserTurn
        ? 'No move in your repertoire from here yet.'
        : 'No prepared reply from here yet.';
    const repertoireEmpty = service.getEdges(service.getRootFen(), resolvedOrientation).length === 0;

    return (
        <div className="explorer-page">
            <div className="explorer-card">
                {snapToast && (
                    <div className="explorer-toast" role="status">
                        <span>{snapToast}</span>
                        <button
                            type="button"
                            className="explorer-toast-dismiss"
                            aria-label="Dismiss"
                            onClick={() => setSnapToast(null)}
                        >
                            ×
                        </button>
                    </div>
                )}

                <div className="explorer-orientation-bar">
                    <button
                        type="button"
                        className={`explorer-toggle ${resolvedOrientation === 'white' ? 'active' : ''}`}
                        onClick={() => resolvedOrientation !== 'white' && handleToggleOrientation()}
                        aria-pressed={resolvedOrientation === 'white'}
                    >
                        White
                    </button>
                    <span className="explorer-toggle-sep">⇄</span>
                    <button
                        type="button"
                        className={`explorer-toggle ${resolvedOrientation === 'black' ? 'active' : ''}`}
                        onClick={() => resolvedOrientation !== 'black' && handleToggleOrientation()}
                        aria-pressed={resolvedOrientation === 'black'}
                    >
                        Black
                    </button>
                    {/* Read / Edit mode pill. Visible from any Explorer state,
                        including the empty repertoire. The Read button is
                        always non-destructive — it just parks the model. The
                        Edit button captures a snapshot if one isn't already
                        live. */}
                    <span className="explorer-mode-sep" aria-hidden="true">·</span>
                    <button
                        type="button"
                        className={`explorer-toggle explorer-mode-toggle ${mode === 'read' ? 'active' : ''}`}
                        onClick={() => mode !== 'read' && exitToReadMode()}
                        aria-pressed={mode === 'read'}
                        title="Read mode — browse the repertoire"
                    >
                        Read
                    </button>
                    <button
                        type="button"
                        className={`explorer-toggle explorer-mode-toggle ${mode === 'edit' ? 'active' : ''}`}
                        onClick={() => mode !== 'edit' && enterEditMode()}
                        aria-pressed={mode === 'edit'}
                        title="Edit mode — add or remove moves and annotations"
                    >
                        Edit
                    </button>
                </div>

                {view === 'main' && (
                <div className="explorer-body">
                    <div
                        className="explorer-board-col"
                        /*
                         * Read mode: vendored chess-control still handles
                         * right-click annotation drawing even when
                         * `interactive={false}`. Capture and cancel pointer
                         * events from the right mouse button before they
                         * reach the board so users cannot draw ephemeral
                         * arrows in Read mode (per EXPLORER.md "Arrows are
                         * read-only").
                         *
                         * Edit mode: pass-through — the user is encouraged
                         * to drop arrows; we route them via the model.
                         */
                        onPointerDownCapture={mode === 'read' ? (e) => {
                            if (e.button === 2) {
                                e.preventDefault();
                                e.stopPropagation();
                            }
                        } : undefined}
                        onContextMenu={mode === 'read' ? (e) => e.preventDefault() : undefined}
                    >
                        <ChessboardControl
                            roundId={`explorer-${mode}-${resolvedOrientation}-${currentFen}`}
                            fen={currentFen}
                            orientation={resolvedOrientation}
                            movePlayed={mode === 'edit' ? handleBoardMove : () => false}
                            annotationsChanged={mode === 'edit' ? handleAnnotationsChanged : undefined}
                            annotations={annotations}
                            interactive={mode === 'edit'}
                        />
                    </div>

                    <form className="explorer-find" onSubmit={handleFindSubmit}>
                        <input
                            type="text"
                            value={findInput}
                            onChange={e => {
                                setFindInput(e.target.value);
                                if (findError) setFindError(null);
                            }}
                            placeholder="Paste FEN or PGN to jump…"
                            aria-label="Paste FEN or PGN to jump"
                            className="explorer-find-input"
                        />
                        <button type="submit" className="explorer-find-submit">Go</button>
                        {findError && (
                            <div className="explorer-find-error" role="alert">{findError}</div>
                        )}
                    </form>

                    <div className="explorer-right-col">
                        <section className="explorer-how-you-got-here">
                            <div className="explorer-section-title">How you got here</div>
                            {currentFen === service.getRootFen() ? (
                                <ul className="explorer-paths">
                                    <li>
                                        <span className="explorer-path-line">
                                            <StartPill />
                                            {repertoireEmpty && (
                                                <span className="explorer-empty-path">
                                                    — no lines in your {resolvedOrientation} repertoire yet
                                                </span>
                                            )}
                                        </span>
                                    </li>
                                </ul>
                            ) : summary.shown.length === 0 ? (
                                <div className="explorer-empty-path">(not reachable)</div>
                            ) : (
                                <ul className="explorer-paths">
                                    {summary.shown.map((p, i) => (
                                        <li key={i}>
                                            <PathLine path={p} rootFen={service.getRootFen()} onJump={fen => jumpTo(fen, undefined, true)} />
                                        </li>
                                    ))}
                                    {summary.moreCount > 0 && (
                                        <li className="explorer-paths-more">
                                            {summary.moreIsLowerBound
                                                ? `… ${summary.moreCount}+ more ways`
                                                : `… ${summary.moreCount} more ${summary.moreCount === 1 ? 'way' : 'ways'}`}
                                        </li>
                                    )}
                                </ul>
                            )}
                        </section>

                        {currentLabel && (
                            <div className="explorer-opening-current">
                                <span className="explorer-opening-eco">{currentLabel.eco}</span>
                                <span className="explorer-opening-name">{currentLabel.name}</span>
                            </div>
                        )}

                        <section className="explorer-moves">
                            <div className="explorer-section-title">{movesHeading}</div>
                            {edges.length === 0 ? (
                                <div className="explorer-moves-empty">
                                    {emptyMessage}
                                    {mode === 'edit' && (
                                        <div className="explorer-moves-empty-hint">
                                            Drag a piece on the board to add a move.
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <ul className="explorer-moves-list">
                                    {edges.map(e => (
                                        <li key={`${e.from}::${e.san}`}>
                                            <MoveRow
                                                edge={e}
                                                orientation={resolvedOrientation}
                                                isUserMove={isUserTurn}
                                                onJump={fen => jumpTo(fen, undefined, true)}
                                                service={service}
                                                currentDepth={currentDepth}
                                                currentPgn={currentPgn}
                                                now={now}
                                                onDelete={mode === 'edit' ? handleDeleteEdge : undefined}
                                            />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    </div>
                </div>
                )}

                {view === 'review' && delta && pendingModel && (
                    <ReviewView
                        delta={delta}
                        rootFen={pendingModel.root}
                        onCancel={exitReviewView}
                        onSave={handleSave}
                        onDiscard={requestDiscard}
                        saveInFlight={saveInFlight}
                    />
                )}

                {/* Sticky save bar — visible only in edit mode with a non-empty delta. */}
                {mode === 'edit' && delta && (delta.counts.added > 0 || delta.counts.removed > 0 || delta.counts.changed > 0) && view === 'main' && (
                    <div className="explorer-save-bar" role="region" aria-label="Pending edits">
                        <span className="explorer-save-bar-counts">
                            {[
                                delta.counts.added > 0 ? `${delta.counts.added} added` : null,
                                delta.counts.removed > 0 ? `${delta.counts.removed} removed` : null,
                                delta.counts.changed > 0 ? `${delta.counts.changed} changed` : null,
                            ].filter(Boolean).join(' · ')}
                        </span>
                        <div className="explorer-save-bar-actions">
                            <button
                                type="button"
                                className="explorer-save-bar-review"
                                onClick={enterReviewView}
                                disabled={saveInFlight}
                            >
                                Review &amp; Save
                            </button>
                            <button
                                type="button"
                                className="explorer-save-bar-discard"
                                onClick={requestDiscard}
                                disabled={saveInFlight}
                            >
                                Discard
                            </button>
                        </div>
                    </div>
                )}

                {saveError && (
                    <div className="explorer-error explorer-save-error" role="alert">
                        {saveError}
                        <button
                            type="button"
                            className="explorer-toast-dismiss"
                            aria-label="Dismiss"
                            onClick={() => setSaveError(null)}
                        >
                            ×
                        </button>
                    </div>
                )}

                {discardPrompt && (
                    <div className="explorer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="discard-prompt-title">
                        <div className="explorer-modal">
                            <h2 id="discard-prompt-title">Discard pending edits?</h2>
                            <p>
                                Your unsaved changes — {delta?.counts.added ?? 0} added,
                                {' '}{delta?.counts.removed ?? 0} removed,
                                {' '}{delta?.counts.changed ?? 0} changed — will be lost.
                                This cannot be undone.
                            </p>
                            <div className="explorer-modal-actions">
                                <button
                                    type="button"
                                    className="explorer-modal-cancel"
                                    onClick={() => setDiscardPrompt(false)}
                                >
                                    Keep editing
                                </button>
                                <button
                                    type="button"
                                    className="explorer-modal-confirm"
                                    onClick={confirmDiscard}
                                >
                                    Discard
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {conflictPrompt && (
                    <div className="explorer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-prompt-title">
                        <div className="explorer-modal">
                            <h2 id="conflict-prompt-title">Repertoire changed elsewhere</h2>
                            <p>
                                Another writer (another tab, a training session, or game
                                ingestion) updated your repertoire while you were editing.
                                Saving now would overwrite their changes.
                            </p>
                            <p>
                                <strong>Refresh</strong> discards your local edits and
                                re-loads the latest state.
                            </p>
                            <div className="explorer-modal-actions">
                                <button
                                    type="button"
                                    className="explorer-modal-cancel"
                                    onClick={() => setConflictPrompt(false)}
                                >
                                    Keep editing
                                </button>
                                <button
                                    type="button"
                                    className="explorer-modal-confirm"
                                    onClick={handleConflictRefresh}
                                >
                                    Refresh
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ExplorerPage;
