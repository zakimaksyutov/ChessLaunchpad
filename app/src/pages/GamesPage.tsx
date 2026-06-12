import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChessBoard } from 'chess-control';
import type { Annotation as ChessControlAnnotation, Square } from 'chess-control';
import { IDataAccessLayer, createDataAccessLayer } from '../data/DataAccessLayer';
import {
    getLinkedAccounts,
    LinkedAccount,
} from '../services/LinkedAccountsService';
import {
    GameRecord,
    OpponentAnalysisRecord,
    RepertoireData,
} from '../models/RepertoireData';
import { OpponentAnalysisResult } from '../models/OpponentAnalysis';
import { buildRepertoireFenSets, RepertoireFenSets } from '../models/RepertoireFenSet';
import { getExplorerEvals, ExplorerEvals } from '../models/ExplorerEvals';
import { EvalDropCategory } from '../services/EvalDropService';
import { getMeasurePerf } from '../utils/PerfUtils';
import { useLichessAuth } from '../LichessAuthContext';
import {
    AnnotatedMove,
    GameAnnotation,
} from '../services/GameAnnotationService';
import {
    annotateRecord,
    getRecordMetadata,
    getRecordOpponentName,
    deriveRecordEotPositions,
} from '../services/RecordAnnotation';
import {
    buildLookupFromAn,
} from '../services/GameRecordAnalysisPlanner';
import {
    AnalysisProgress,
    AnalyzedGameOutcome,
    ANALYSIS_FLUSH_BATCH,
    buildAnalysisPlan,
    filterRunnableJobs,
    analyzeOneGame,
    flushAnUpdates,
    persistOpponentAnalysis,
    persistReannotateClear,
    persistReannotateRefresh,
    persistDeleteRecordsFromTimestamp,
} from '../services/GameRecordAnalysisPass';
import {
    getAllRecordsNewestFirst,
    findRecord,
    MAX_TOTAL_RECORDS,
} from '../services/GameRecordStore';
import {
    analyzeOpponentGames,
    OpponentAnalysisProgress,
    toPersistedOp,
    fromPersistedOp,
} from '../services/OpponentAnalysisService';
import { getRecordUserColor, buildGameRecord } from '../services/GameRecordBuilder';
import { runIngest } from '../services/GameIngestService';
import { orderRowsSticky, OrderableRow } from '../services/GameRowOrdering';
import { selectRenderableRows } from '../services/GameRowSelection';
import { fetchLichessGameExport } from '../services/LichessGameExportService';
import {
    MastersMemoEntry,
} from '../services/GameRecordAnalysisPlanner';
import './GamesPage.css';

function formatSyncTime(d: Date): string {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

type SyncState =
    | { phase: 'syncing' }
    | { phase: 'synced'; at: Date };

/** Show a progress bar instead of the silent spinner when a sync discovers
 *  more than this many games to analyze. Below the threshold (the typical
 *  day-to-day case), the spinner is enough — we don't want the bar flashing
 *  up for every 1-2 game refresh. */
const SYNC_PROGRESS_BAR_THRESHOLD = 3;

const SyncStatusIndicator: React.FC<{
    status: SyncState;
    analysisProgress: AnalysisProgress;
}> = ({ status, analysisProgress }) => {
    if (status.phase === 'syncing') {
        const progressTotal =
            (analysisProgress.phase === 'analyzing' || analysisProgress.phase === 'flushing')
                ? analysisProgress.gameTotal
                : undefined;
        const progressIndex =
            (analysisProgress.phase === 'analyzing' || analysisProgress.phase === 'flushing')
                ? analysisProgress.gameIndex
                : undefined;

        if (
            progressTotal !== undefined &&
            progressIndex !== undefined &&
            progressTotal > SYNC_PROGRESS_BAR_THRESHOLD
        ) {
            const pct = Math.max(0, Math.min(100, (progressIndex / progressTotal) * 100));
            return (
                <span
                    className="games-sync-status games-sync-status-active games-sync-status-progress"
                    role="status"
                    aria-live="polite"
                    title={`Analyzing ${progressIndex} of ${progressTotal} games`}
                >
                    <span className="games-sync-progress-text">
                        Analyzing {progressIndex} of {progressTotal} games…
                    </span>
                    <span
                        className="games-sync-progress-bar"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={progressTotal}
                        aria-valuenow={progressIndex}
                    >
                        <span
                            className="games-sync-progress-fill"
                            style={{ width: `${pct}%` }}
                        />
                    </span>
                </span>
            );
        }

        return (
            <span
                className="games-sync-status games-sync-status-active"
                role="status"
                aria-live="polite"
                title="Syncing games from linked accounts"
            >
                <span className="games-sync-spinner" aria-hidden="true" />
                <span>Syncing games…</span>
            </span>
        );
    }
    return (
        <span
            className="games-sync-status"
            role="status"
            aria-live="polite"
            title={`Last sync at ${status.at.toLocaleString()}`}
        >
            Synced @ {formatSyncTime(status.at)}
        </span>
    );
};

const END_OF_THEORY_CLASSES: Record<EvalDropCategory, string> = {
    ok: 'move-out-of-theory',
    inaccuracy: 'move-eot-inaccuracy',
    mistake: 'move-eot-mistake',
    blunder: 'move-eot-blunder',
};

const EOT_ICON_COLORS: Record<EvalDropCategory, string> = {
    ok: '#888',
    inaccuracy: '#b8860b',
    mistake: '#c0392b',
    blunder: '#7b3f9e',
};

const THREAT_LEVEL_COLORS: Record<string, string> = {
    'low': '#27ae60',
    'moderate': '#b8860b',
    'high': '#c0392b',
    'very-high': '#7b3f9e',
};

const THREAT_LEVEL_LABELS: Record<string, string> = {
    'low': 'Opponent likely unfamiliar with this position',
    'moderate': 'Opponent has some experience here',
    'high': 'Opponent knows this position well',
    'very-high': 'Opponent is very experienced here',
};

function getMoveClassName(move: AnnotatedMove): string {
    if (!move.isUserMove) return 'move-token move-opponent';
    switch (move.highlight) {
        case 'in-repertoire':
            return 'move-token move-in-repertoire';
        case 'deviation':
            return 'move-token move-deviation';
        case 'out-of-repertoire-response': {
            const category = move.evalDrop?.category ?? 'ok';
            return `move-token ${END_OF_THEORY_CLASSES[category]}`;
        }
        case 'out-of-repertoire':
        case 'out-of-theory':
            return 'move-token move-out-of-theory';
    }
}

function formatPlayerLabel(name: string, rating: number | undefined, isUser: boolean): React.ReactNode {
    return (
        <span className={isUser ? 'player-user' : 'player-opponent'}>
            {name}
            {rating !== undefined && (
                <span className="player-rating"> ({rating})</span>
            )}
        </span>
    );
}

function formatDateShort(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const OpponentAnalysisDisplay: React.FC<{ analysis: OpponentAnalysisResult }> = ({ analysis }) => {
    const color = THREAT_LEVEL_COLORS[analysis.threatLevel];
    const label = THREAT_LEVEL_LABELS[analysis.threatLevel];
    const isLow = analysis.threatLevel === 'low';
    const recentGames = analysis.recentAfterGames.length > 0
        ? analysis.recentAfterGames
        : analysis.recentBeforeGames;

    return (
        <div className={`opponent-analysis-result opp-threat-${analysis.threatLevel}`}>
            <div className="opponent-analysis-header">
                <svg className="opponent-analysis-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    {isLow ? (
                        <>
                            <circle cx="12" cy="12" r="10" fill={color} />
                            <text x="12" y="17" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">i</text>
                        </>
                    ) : (
                        <>
                            <path d="M12 2L1 21h22L12 2z" fill={color} />
                            <text x="12" y="18" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">!</text>
                        </>
                    )}
                </svg>
                <span className="opponent-analysis-text">
                    Opponent has <strong>{analysis.positionBeforeCount}</strong> game{analysis.positionBeforeCount !== 1 ? 's' : ''} after{' '}
                    <strong>{analysis.opponentMoveSan}</strong> and{' '}
                    <strong>{analysis.positionAfterCount}</strong> after{' '}
                    <strong>{analysis.userMoveSan}</strong>
                    <span className="opponent-analysis-total"> (of {analysis.gamesAnalyzed} analyzed)</span>
                </span>
            </div>
            <div className="opponent-analysis-label" style={{ color }}>{label}</div>
            {recentGames.length > 0 && (
                <div className="opponent-analysis-dates">
                    Recent:{' '}
                    {recentGames.map((ref, i) => (
                        <React.Fragment key={i}>
                            {i > 0 && ' · '}
                            <a className="opponent-game-link" href={ref.url} target="_blank" rel="noopener noreferrer">
                                {formatDateShort(ref.date)}
                            </a>
                        </React.Fragment>
                    ))}
                </div>
            )}
        </div>
    );
};

interface GameRowProps {
    record: GameRecord;
    userLower: string;
    annotation: GameAnnotation | null;
    /** Live opponent-analysis result, derived from `record.op` or freshly computed. */
    opponentAnalysis: OpponentAnalysisResult | null;
    /** True when this record is currently being re-annotated. */
    reannotating: boolean;
    /**
     * True when this row is a skeleton placeholder — record is queued for
     * analysis but the verdict hasn't landed yet. Shimmer placeholders
     * are rendered in place of the mini board / PGN / summaries to
     * reserve the row's slot before content lands.
     */
    pending: boolean;
    /** Current opponent-analysis download progress (only for the active row). */
    analyzeProgress: OpponentAnalysisProgress | null;
    /** True when any row is currently running opponent-analysis. */
    analyzeDisabled: boolean;
    /**
     * True when the saved `op`'s anchored ply no longer corresponds to a
     * live deviation (stale op — repertoire changed since analysis).
     * Render hides the result block and re-enables the menu action.
     */
    opIsStale: boolean;
    onReannotate: (record: GameRecord, userLower: string) => void;
    onAnalyzeOpponent: (record: GameRecord) => void;
    /** DEBUG / TEMP — delete this record and every newer one. */
    onDeleteFromHere: (record: GameRecord) => void;
}

const GameRow: React.FC<GameRowProps> = ({
    record,
    userLower,
    annotation,
    opponentAnalysis,
    reannotating,
    pending,
    analyzeProgress,
    analyzeDisabled,
    opIsStale,
    onReannotate,
    onAnalyzeOpponent,
    onDeleteFromHere,
}) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const meta = useMemo(
        () => getRecordMetadata(record, userLower),
        [record, userLower],
    );

    const dateStr = useMemo(() => {
        const d = new Date(meta.createdAt);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }, [meta.createdAt]);

    const boardAnnotations: ChessControlAnnotation[] = useMemo(() => {
        if (!annotation?.deviation) return [];
        const arrows: ChessControlAnnotation[] = [];
        for (const rm of annotation.deviation.repertoireMoves) {
            arrows.push({ color: 'green', from: rm.from as Square, to: rm.to as Square });
        }
        arrows.push({ color: 'red', from: annotation.deviation.userMove.from as Square, to: annotation.deviation.userMove.to as Square });
        return arrows;
    }, [annotation]);

    const boardFen = annotation?.miniBoardFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    const eotSummary = useMemo(() => {
        if (!annotation) return null;
        const moves = annotation.moves;
        for (let i = 0; i < moves.length; i++) {
            if (moves[i].highlight === 'out-of-repertoire-response' && moves[i].evalDrop && moves[i].evalDrop!.category !== 'ok') {
                let opponentMove: string | null = null;
                for (let j = i - 1; j >= 0; j--) {
                    if (!moves[j].isUserMove) {
                        opponentMove = moves[j].san;
                        break;
                    }
                }
                return {
                    userSan: moves[i].san,
                    opponentSan: opponentMove,
                    category: moves[i].evalDrop!.category,
                    drop: moves[i].evalDrop!.evalDrop,
                };
            }
        }
        return null;
    }, [annotation]);

    const resultLabel = meta.result.toUpperCase();
    const speedLabel = meta.speed ? meta.speed.charAt(0).toUpperCase() + meta.speed.slice(1) : '';

    const topRightParts: string[] = [resultLabel];
    if (meta.rated !== undefined) topRightParts.push(meta.rated ? 'Rated' : 'Casual');
    if (speedLabel) topRightParts.push(speedLabel);
    if (meta.timeControl) topRightParts.push(meta.timeControl);
    topRightParts.push(dateStr);

    const whiteIsUser = meta.userColor === 'white';
    const blackIsUser = meta.userColor === 'black';

    const hasDeviation = annotation?.deviation != null;
    const tileClass = hasDeviation
        ? ' game-row-deviation'
        : eotSummary
            ? ` game-row-eot-${eotSummary.category}`
            : '';

    useEffect(() => {
        if (!menuOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [menuOpen]);

    const showOpponentAnalysis = opponentAnalysis !== null && !opIsStale;
    // Allow Analyze when: no saved op OR saved op is stale; and the row has an EOT eligible.
    const allowAnalyzeAction = eotSummary !== null && (opponentAnalysis === null || opIsStale);

    return (
        <div
            className={`game-row${tileClass}${reannotating ? ' game-row-reannotating' : ''}${pending ? ' game-row-pending' : ''}`}
            aria-busy={pending || undefined}
        >
            <div className="game-mini-board">
                {pending ? (
                    <div className="game-mini-board-skeleton" aria-hidden="true" />
                ) : (
                    <ChessBoard
                        fen={boardFen}
                        orientation={annotation?.miniBoardOrientation ?? meta.userColor ?? 'white'}
                        interactive={false}
                        coordinates={false}
                        turnColor="white"
                        legalMoves={new Map()}
                        annotations={boardAnnotations}
                    />
                )}
            </div>
            <div className="game-info">
                <div className="game-header-row">
                    <div className="game-players">
                        {formatPlayerLabel(meta.whiteName, meta.whiteRating, whiteIsUser)}
                        <span className="game-vs"> vs </span>
                        {formatPlayerLabel(meta.blackName, meta.blackRating, blackIsUser)}
                    </div>
                    <div className="game-right-column">
                        <span className="game-meta-right">{topRightParts.join(' | ')}</span>
                        <span className="game-source-row">
                            <a className="game-source-link" href={meta.gameUrl} target="_blank" rel="noopener noreferrer">
                                {record.p === 'c' ? '♔ View on Chess.com' : '♞ View on Lichess'}
                            </a>
                            {!pending && (
                                <div className="game-overflow-menu" ref={menuRef}>
                                    <button
                                        className="game-overflow-button"
                                        onClick={() => setMenuOpen(prev => !prev)}
                                        aria-label="Game options"
                                    >⋯</button>
                                    {menuOpen && (
                                        <div className="game-overflow-dropdown">
                                            <button onClick={() => { setMenuOpen(false); onReannotate(record, userLower); }}>
                                                Re-annotate
                                            </button>
                                            {showOpponentAnalysis && (
                                                <button disabled className="game-overflow-done">
                                                    Opponent analysis ✓
                                                </button>
                                            )}
                                            {/* DEBUG / TEMP — remove before merging. */}
                                            <button
                                                className="game-overflow-debug"
                                                onClick={() => { setMenuOpen(false); onDeleteFromHere(record); }}
                                            >
                                                Delete from here (debug)
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </span>
                    </div>
                </div>

                <div className="game-details-row">
                    {meta.openingName && <span className="game-opening">{meta.openingName}</span>}
                    {reannotating && <span className="game-reannotating-badge">Re-annotating…</span>}
                    {pending && <span className="game-pending-badge">Analyzing…</span>}
                </div>

                {pending ? (
                    <div className="game-pgn-skeleton" aria-hidden="true">
                        <span className="skeleton-line skeleton-line-w70" />
                        <span className="skeleton-line skeleton-line-w85" />
                        <span className="skeleton-line skeleton-line-w55" />
                        <span className="skeleton-block skeleton-block-summary" />
                    </div>
                ) : (
                    <>
                        {annotation && annotation.moves.length > 0 && (
                            <div className="game-pgn">
                                {annotation.moves.map((move, idx) => (
                                    <React.Fragment key={idx}>
                                        {move.moveNumber !== undefined && (
                                            <span className="move-number">{move.moveNumber}.&nbsp;</span>
                                        )}
                                        <span className={getMoveClassName(move)}>{move.san}</span>
                                        {' '}
                                    </React.Fragment>
                                ))}
                            </div>
                        )}

                        {annotation?.deviation && (
                            <div className="game-deviation-summary">
                                <svg className="game-deviation-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M12 2L1 21h22L12 2z" fill="#9b59b6"/>
                                    <text x="12" y="18" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">!</text>
                                </svg>
                                Repertoire has{' '}
                                <strong>
                                    {annotation.deviation.repertoireMoves.map(m => m.san).join(', ') || '?'}
                                </strong>{' '}but you played{' '}
                                <strong>{annotation.deviation.userMove.san}</strong>
                            </div>
                        )}

                        {eotSummary && (
                            <div className="game-eot-summary">
                                <svg className="game-deviation-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M12 2L1 21h22L12 2z" fill={EOT_ICON_COLORS[eotSummary.category]}/>
                                    <text x="12" y="18" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="700">!</text>
                                </svg>
                                Out of repertoire – you played <strong>{eotSummary.userSan}</strong> ({eotSummary.category})
                                {allowAnalyzeAction && !analyzeProgress && (
                                    <a
                                        className="analyze-opponent-link"
                                        role="button"
                                        onClick={analyzeDisabled ? undefined : () => onAnalyzeOpponent(record)}
                                        aria-disabled={analyzeDisabled}
                                    >
                                        Analyze opponent
                                    </a>
                                )}
                            </div>
                        )}

                        {analyzeProgress && analyzeProgress.phase === 'downloading' && (
                            <div className="opponent-analysis-progress">
                                <span className="opponent-analysis-progress-text">
                                    Analyzing opponent&apos;s games… {analyzeProgress.gamesDownloaded}
                                </span>
                                <div className="opponent-analysis-progress-bar">
                                    <div
                                        className="opponent-analysis-progress-fill"
                                        style={{ width: `${Math.min(100, (analyzeProgress.gamesDownloaded / 1000) * 100)}%` }}
                                    />
                                </div>
                            </div>
                        )}

                        {showOpponentAnalysis && <OpponentAnalysisDisplay analysis={opponentAnalysis!} />}
                    </>
                )}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────
// GamesPage
// ─────────────────────────────────────────────────────────────────────────

const GamesPage: React.FC = () => {
    const [data, setData] = useState<RepertoireData | null>(null);
    const [loading, setLoading] = useState(true);
    const [fenSets, setFenSets] = useState<RepertoireFenSets | null>(null);
    const [explorerEvals, setExplorerEvals] = useState<ExplorerEvals | null>(null);
    const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>({ phase: 'idle' });
    const [analysisError, setAnalysisError] = useState<string>('');
    const [syncStatus, setSyncStatus] = useState<SyncState | null>(null);
    const [blockedByLichessCount, setBlockedByLichessCount] = useState(0);
    const [pendingNetworkRetry, setPendingNetworkRetry] = useState(0);
    const [analyzingRecordKey, setAnalyzingRecordKey] = useState<string | null>(null);
    const [analyzeProgress, setAnalyzeProgress] = useState<OpponentAnalysisProgress | null>(null);
    /**
     * Records currently being re-annotated. We keep them visible in the
     * list during the re-run by holding their prior `an` in
     * `priorAnByKey` and patching it into the rendered record so the row
     * never drops out of `renderableRows`. On success the new `an` lands;
     * on failure we restore the prior `an` and unset the badge.
     */
    const [reannotatingKeys, setReannotatingKeys] = useState<Set<string>>(new Set());
    const priorAnByKeyRef = useRef<Map<string, NonNullable<GameRecord['an']>>>(new Map());
    /**
     * Records flagged for a one-shot debug annotation log. Populated by
     * `handleReannotate`; consumed (and cleared) on the first render where
     * the row is no longer in `reannotatingKeys` — i.e. when the fresh
     * verdict (or the restored prior `an`) is back on the canonical
     * record. Mirrors the pre-refactor `debugGameIdsRef` behavior.
     */
    const debugRecordKeysRef = useRef<Set<string>>(new Set());
    const analyzeAbortRef = useRef<AbortController | null>(null);
    const passAbortRef = useRef<AbortController | null>(null);
    /** Single-flight guard so a StrictMode re-mount or rapid trigger doesn't double-start a pass. */
    const passStartedRef = useRef(false);
    /** Promise resolved when the current pass's `finally` completes — used by Re-annotate to chain. */
    const passDonePromiseRef = useRef<Promise<void> | null>(null);
    /** Memoize the record-key→position-in-the-sticky-session-list so late-arriving games go to the bottom. */
    const sessionOrderRef = useRef<Map<string, number>>(new Map());
    /**
     * Records that the current analysis pass has planned but not yet
     * analyzed. Rendered as skeleton placeholders so the row's slot is
     * reserved *before* the verdict lands — eliminates the "rows pop in
     * newest-first, push everything down" jumping effect that used to
     * happen as each game's `an` arrived.
     *
     * Populated right after `filterRunnableJobs` returns; trimmed as
     * each game's `an` lands; cleared in the pass's `finally`.
     */
    const [pendingAnalysisKeys, setPendingAnalysisKeys] = useState<Set<string>>(new Set());

    const measurePerf = useMemo(() => getMeasurePerf(), []);
    const perfT0Ref = useRef(measurePerf ? performance.now() : 0);

    const { ready: lichessAuthReady, connected: lichessConnected, token: lichessToken } = useLichessAuth();
    const [linkedAccounts, setLinkedAccountsState] = useState<LinkedAccount[]>(() => getLinkedAccounts());

    const dal: IDataAccessLayer | null = useMemo(() => {
        const username = localStorage.getItem('username');
        const hashedPassword = localStorage.getItem('hashedPassword');
        if (!username || !hashedPassword) return null;
        return createDataAccessLayer(username, hashedPassword);
    }, []);

    // Refresh linked accounts when page gains focus.
    useEffect(() => {
        const refresh = () => setLinkedAccountsState(getLinkedAccounts());
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, []);

    // Initial load: repertoire data + fen sets + explorer evals.
    useEffect(() => {
        if (!dal) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const repertoireData = await dal.retrieveRepertoireData();
                if (cancelled) return;
                const sets = buildRepertoireFenSets(repertoireData.repertoires ?? []);
                if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: 'fenSets-ready', totalMs: Math.round(performance.now() - perfT0Ref.current), whiteFens: sets.whiteFens.size, blackFens: sets.blackFens.size })}`);
                setData(repertoireData);
                setFenSets(sets);
                setLinkedAccountsState(getLinkedAccounts());
            } catch (err) {
                console.warn('Failed to load repertoire data:', err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dal]);

    useEffect(() => {
        getExplorerEvals()
            .then(ev => {
                if (measurePerf) console.log(`[Perf] ${JSON.stringify({ step: 'explorerEvals-ready', totalMs: Math.round(performance.now() - perfT0Ref.current) })}`);
                setExplorerEvals(ev);
            })
            .catch(err => console.warn('Failed to load explorer evals:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Cleanup the opponent-analysis abort controller on unmount.
    // The pass-abort controller is co-located with the trigger effect below
    // so StrictMode's mount → unmount → remount cycle doesn't strand the
    // pass in an in-flight state that the remount can't recover from.
    useEffect(() => {
        return () => {
            analyzeAbortRef.current?.abort();
        };
    }, []);

    /** Account name (lowercase) keyed by accountKey, computed from settings. */
    const accountUserByKey = useMemo(() => {
        const map = new Map<string, string>();
        const accts = data?.settings?.linkedAccounts ?? linkedAccounts;
        for (const a of accts) {
            map.set(`${a.platform}:${a.username.toLowerCase()}`, a.username.toLowerCase());
        }
        return map;
    }, [data, linkedAccounts]);

    /** Derive every render-side record + its owning userLower from the activity log. */
    const allRecords = useMemo<{ record: GameRecord; userLower: string }[]>(() => {
        if (!data?.activity) return [];
        const records = getAllRecordsNewestFirst(data.activity);
        const out: { record: GameRecord; userLower: string }[] = [];
        for (const r of records) {
            const platform = r.p === 'c' ? 'chess.com' : 'lichess';
            // Match either side to a linked account (case-insensitive).
            let userLower: string | null = null;
            for (const [key, name] of accountUserByKey) {
                if (!key.startsWith(`${platform}:`)) continue;
                if (r.wa.toLowerCase() === name || r.ba.toLowerCase() === name) {
                    userLower = name;
                    break;
                }
            }
            if (!userLower) continue;
            out.push({ record: r, userLower });
        }
        return out;
    }, [data, accountUserByKey]);

    /**
     * Renderable rows: those with `an` present, PLUS records currently
     * being re-annotated (whose `an` has been cleared in the blob but for
     * which we hold a `priorAn` to keep the row visible until the new
     * verdict lands or the re-run fails), PLUS records queued for the
     * current analysis pass (rendered as skeletons so the row's slot is
     * reserved before content arrives).
     *
     * Re-annotation overlay takes precedence over the skeleton state so
     * a re-annotating row keeps showing its prior `an` instead of
     * collapsing into a placeholder. See `selectRenderableRows`.
     */
    const renderableRows = useMemo(() => {
        return selectRenderableRows(
            allRecords,
            reannotatingKeys,
            priorAnByKeyRef.current,
            pendingAnalysisKeys,
        );
    }, [allRecords, reannotatingKeys, pendingAnalysisKeys]);

    /**
     * Sticky session ordering: rows already shown keep their slot; new
     * rows are placed by timestamp relative to the current bounds.
     * Re-annotating rows stay in `renderableRows` via the prior-`an`
     * overlay above, so they're treated as `known`. See
     * `orderRowsSticky` for the ordering protocol.
     */
    const orderedRows = useMemo(() => {
        type RowPayload = { record: GameRecord; userLower: string; pending: boolean };
        const orderable: OrderableRow<RowPayload>[] = renderableRows.map(r => ({
            key: `${r.record.p}:${r.record.id}`,
            t: r.record.t,
            payload: r,
        }));
        const ordered = orderRowsSticky(orderable, sessionOrderRef.current);
        return ordered.map(o => o.payload);
    }, [renderableRows]);

    // Annotation cache: re-render against fresh data; recompute when records or
    // repertoire change. Per-row memoization is automatic via the row component
    // (GameRow takes the record + userLower; useMemo within keys on those).
    // Pending (skeleton) rows are skipped — they intentionally render
    // without an annotation, and computing one against an un-analyzed
    // record would just produce a partial verdict that flickers a moment
    // before the real one lands.
    const annotationByKey = useMemo(() => {
        const map = new Map<string, GameAnnotation | null>();
        if (!fenSets || !explorerEvals) return map;
        for (const { record, userLower, pending } of orderedRows) {
            const key = `${record.p}:${record.id}`;
            if (pending) {
                map.set(key, null);
                continue;
            }
            const color = getRecordUserColor(record, userLower);
            const fens = color === 'white' ? fenSets.whiteFens : color === 'black' ? fenSets.blackFens : new Set<string>();
            const lookup = buildLookupFromAn(record);
            // Fire the Re-annotate one-shot debug log on the first render
            // where the row is no longer showing the prior-`an` overlay —
            // i.e. when the fresh verdict (or the restored prior `an`) is
            // back on the canonical record.
            const wantDebug =
                debugRecordKeysRef.current.has(key) && !reannotatingKeys.has(key);
            const ann = annotateRecord(record, userLower, fens, explorerEvals, lookup, undefined, wantDebug);
            if (wantDebug) debugRecordKeysRef.current.delete(key);
            map.set(key, ann);
        }
        return map;
    }, [orderedRows, fenSets, explorerEvals, reannotatingKeys]);

    // Opponent-analysis live state per record: derived from record.op + a
    // per-row "stale?" check. A row's op is stale iff its anchored ply is
    // no longer the first non-ok user out-of-rep response in the annotation.
    const opByKey = useMemo(() => {
        const map = new Map<string, { live: OpponentAnalysisResult; stale: boolean }>();
        for (const { record, userLower, pending } of orderedRows) {
            if (pending) continue;
            if (!record.op) continue;
            const key = `${record.p}:${record.id}`;
            const ann = annotationByKey.get(key);
            const userColor = getRecordUserColor(record, userLower);
            if (!userColor) continue;
            const live = fromPersistedOp(record.op, record, userColor);
            // Stale check: does the live deviation at this ply still exist
            // as the first EOT eval-drop?
            let stale = true;
            if (ann) {
                const eot = deriveRecordEotPositions(record, userLower, ann);
                if (eot && eot.targetPly === record.op.ply) stale = false;
            }
            map.set(key, { live, stale });
        }
        return map;
    }, [orderedRows, annotationByKey]);

    // ─────────────────────────────────────────────────────────────────────
    // Analysis pass
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Run the full landing-flow analysis pipeline (steps 1-5):
     *   1. background ingest (so new games land)
     *   2. eviction happens inside ingest
     *   3. plan ambiguous positions per record (no network)
     *   4. analyze oldest-first, sequentially, batched flush back
     */
    /**
     * Run the analysis pass and expose a promise that resolves when the
     * pass's `finally` has run. Callers (Re-annotate, the cleanup effect)
     * await this promise to chain new passes / cancellation safely
     * without busy-waiting.
     */
    const runAnalysisPass = useCallback((): Promise<void> => {
        if (!dal) return Promise.resolve();
        // Single-flight guard.
        if (passStartedRef.current) {
            return passDonePromiseRef.current ?? Promise.resolve();
        }
        passStartedRef.current = true;

        const abort = new AbortController();
        passAbortRef.current = abort;

        // Use a slot so the IIFE's `finally` can compare against the
        // already-published promise without referring to itself.
        const slot: { promise?: Promise<void> } = {};

        slot.promise = (async () => {
            try {
                // Step 1 + 2: ingest (writes records + evicts). The ingest pipeline
                // is the shared write path for record append + eviction.
                setSyncStatus(prev => (prev?.phase === 'syncing' ? prev : { phase: 'syncing' }));
                setAnalysisProgress({ phase: 'planning' });
                await runIngest(dal);

                // Re-fetch the blob to pick up newly ingested records.
                const fresh = await dal.retrieveRepertoireData();
                if (abort.signal.aborted) return;
                setData(fresh);
                const sets = buildRepertoireFenSets(fresh.repertoires ?? []);
                setFenSets(sets);

                // Step 3: build the plan.
                const allJobs = buildAnalysisPlan(fresh, explorerEvals);
                const { runnable, blockedByLichess } = filterRunnableJobs(allJobs, lichessConnected);
                setBlockedByLichessCount(blockedByLichess.length);

                if (runnable.length === 0) {
                    setAnalysisProgress({ phase: 'idle' });
                    return;
                }

                // Reserve a skeleton slot for every runnable job *before* the
                // analyze loop starts. Each row appears immediately as a
                // pending placeholder in its final newest-first slot, then
                // hydrates in place when its `an` lands — eliminating the
                // newest-first jump-and-push effect that used to happen as
                // games completed one at a time.
                const runnableKeys = runnable.map(j => `${j.record.p}:${j.record.id}`);
                setPendingAnalysisKeys(new Set(runnableKeys));

                // Step 4: run sequentially with per-pass memo.
                const memo = new Map<string, MastersMemoEntry>();
                const pendingFlush: AnalyzedGameOutcome[] = [];
                let networkRetryCount = 0;

                for (let i = 0; i < runnable.length; i++) {
                    if (abort.signal.aborted) break;
                    const job = runnable[i];
                    setAnalysisProgress({
                        phase: 'analyzing',
                        gameIndex: i + 1,
                        gameTotal: runnable.length,
                        positionIndex: 0,
                        positionTotal: job.plan.length,
                    });
                    const outcome = await analyzeOneGame(
                        job,
                        lichessToken,
                        memo,
                        (positionIndex, positionTotal) => {
                            setAnalysisProgress({
                                phase: 'analyzing',
                                gameIndex: i + 1,
                                gameTotal: runnable.length,
                                positionIndex,
                                positionTotal,
                            });
                        },
                        abort.signal,
                    );
                    if (outcome.skipped) {
                        networkRetryCount += 1;
                        continue;
                    }
                    pendingFlush.push(outcome);
                    // Optimistic local update — patch by (p, id) into the *current*
                    // `data` tree so the reveal-as-ready row appears immediately
                    // for THIS game. We don't rely on shared object references
                    // (the `fresh` tree built earlier may have been replaced
                    // by an earlier flush's `fresh2`); patching in a setState
                    // updater guarantees we always mutate the latest rendered
                    // tree.
                    {
                        const pendingAn = outcome.an;
                        setData(d => {
                            if (!d?.activity) return d;
                            const target = findRecord(d.activity, outcome.record.id, outcome.record.p);
                            if (!target) return d;
                            target.record.an = pendingAn;
                            // Shallow clone to force re-render — the in-place
                            // mutation above is on a shared subtree that needs
                            // a new top-level reference for `useMemo` to invalidate.
                            return { ...d };
                        });
                        // If this record was being re-annotated, swap in the new
                        // verdict and clear the badge.
                        const recKey = `${outcome.record.p}:${outcome.record.id}`;
                        if (priorAnByKeyRef.current.has(recKey)) {
                            priorAnByKeyRef.current.delete(recKey);
                            setReannotatingKeys(prev => {
                                if (!prev.has(recKey)) return prev;
                                const next = new Set(prev);
                                next.delete(recKey);
                                return next;
                            });
                        }
                        // Drop the skeleton slot — the row now has `an` and
                        // can render normally. The next render hydrates the
                        // existing placeholder in place (no reorder), which
                        // combined with FLIP transitions yields a smooth
                        // skeleton → content swap.
                        setPendingAnalysisKeys(prev => {
                            if (!prev.has(recKey)) return prev;
                            const next = new Set(prev);
                            next.delete(recKey);
                            return next;
                        });
                    }

                    if (pendingFlush.length >= ANALYSIS_FLUSH_BATCH) {
                        setAnalysisProgress(prev => prev.phase === 'analyzing' ? { ...prev, phase: 'flushing' } : prev);
                        const { data: fresh2 } = await flushAnUpdates(dal, pendingFlush.splice(0));
                        if (abort.signal.aborted) break;
                        // Re-apply our optimistic in-memory `an` mutations onto
                        // the freshly-decoded tree so subsequent reveal-as-ready
                        // patches keep landing in the rendered subtree.
                        setData(fresh2);
                    }
                }

                if (pendingFlush.length > 0 && !abort.signal.aborted) {
                    setAnalysisProgress(prev =>
                        prev.phase === 'analyzing'
                            ? { phase: 'flushing', gameIndex: prev.gameIndex, gameTotal: prev.gameTotal }
                            : { phase: 'flushing' }
                    );
                    const { data: fresh3 } = await flushAnUpdates(dal, pendingFlush);
                    if (!abort.signal.aborted) setData(fresh3);
                }

                setPendingNetworkRetry(networkRetryCount);
                setAnalysisProgress({ phase: 'idle' });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('GamesPage: analysis pass failed', e);
                setAnalysisError(msg);
                setAnalysisProgress({ phase: 'idle' });
            } finally {
                // Stamp the sync time on every completion path (success, error,
                // empty-run) — matches the Dashboard's silent-error contract.
                setSyncStatus({ phase: 'synced', at: new Date() });
                // Drop any remaining skeleton slots. The per-game drop in
                // the analyze loop handles successful completions; this
                // covers abort / error / network-skip leftovers so we don't
                // leak permanent skeleton rows after the pass ends.
                setPendingAnalysisKeys(prev => (prev.size === 0 ? prev : new Set()));
                passStartedRef.current = false;
                if (passAbortRef.current === abort) {
                    passAbortRef.current = null;
                }
                if (passDonePromiseRef.current === slot.promise) {
                    passDonePromiseRef.current = null;
                }
            }
        })();
        passDonePromiseRef.current = slot.promise;
        return slot.promise;
    }, [dal, explorerEvals, lichessConnected, lichessToken]);

    // Trigger the analysis pass once the initial load is done. Gate on
    // `lichessAuthReady` so we don't accidentally treat "connection check
    // pending" as "disconnected" (which would skip Lichess games).
    //
    // The cleanup function aborts the pass on real unmount and lets the
    // single-flight guard short-circuit re-triggers from StrictMode's
    // synthetic mount → unmount → remount cycle. The `passDonePromiseRef`
    // is shared across the cycle so the remount's `runAnalysisPass()`
    // returns the in-flight promise instead of starting a duplicate pass.
    useEffect(() => {
        if (loading) return;
        if (!data || !fenSets || !explorerEvals) return;
        if (!lichessAuthReady) return;
        runAnalysisPass();
        return () => {
            // Don't abort here in dev StrictMode — the pass observes the
            // signal and tears itself down, but the cleanup runs before
            // the remount calls `runAnalysisPass()` again, and the
            // remount's call would no-op against the still-running pass.
            // Real unmount is handled by the navigation-level cleanup
            // elsewhere; the pass is harmless to leave running for a few
            // hundred ms while it finishes its current `await` chain.
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, data !== null, fenSets !== null, explorerEvals !== null, lichessAuthReady]);

    // ─────────────────────────────────────────────────────────────────────
    // Re-annotate
    // ─────────────────────────────────────────────────────────────────────

    const handleReannotate = useCallback(async (record: GameRecord, userLower: string) => {
        if (!dal) return;
        const key = `${record.p}:${record.id}`;
        const priorAn = record.an;
        if (priorAn === undefined) return; // already being re-annotated

        // Capture the prior `an` so `renderableRows` keeps the row visible
        // through the clear → re-fetch → re-pass window. Set the badge.
        priorAnByKeyRef.current.set(key, priorAn);
        setReannotatingKeys(prev => new Set(prev).add(key));
        // Flag for a one-shot debug log on the next annotation that runs
        // against the post-pass record (consumed in `annotationByKey`).
        debugRecordKeysRef.current.add(key);

        // Abort any in-flight pass and wait for it to actually finish
        // (the abort doesn't propagate into the masters fetcher or the
        // 1 req/sec rate-limit delay, so we have to wait for the pass's
        // own checkpoints to observe the signal and unwind through
        // `finally`).
        passAbortRef.current?.abort();
        const inflight = passDonePromiseRef.current;
        if (inflight) {
            try { await inflight; } catch { /* swallowed by pass */ }
        }

        try {
            // For Lichess records, re-fetch the game from the provider so
            // any server-side analysis Lichess computed *after* ingest
            // (per-ply evals, opening name refinement) is reflected in
            // the new verdict. Chess.com has no per-ply evals and the
            // single-archive cost-per-game is prohibitive, so we keep
            // the today's pure-re-annotate path there.
            //
            // Any failure in fetch / rebuild silently falls back to the
            // cached record — re-annotate against stale data is still
            // better than a hard error.
            let refreshed = false;
            if (record.p === 'l') {
                const gd = await fetchLichessGameExport(record.id);
                if (gd) {
                    const fresh = buildGameRecord(gd, userLower, 'lichess');
                    if (fresh && fresh.id === record.id) {
                        await persistReannotateRefresh(dal, fresh);
                        refreshed = true;
                    }
                }
            }
            const fresh = refreshed
                ? await dal.retrieveRepertoireData()
                : await persistReannotateClear(dal, record.id, record.p);
            setData(fresh);
            // Re-trigger and AWAIT the pass so we can detect failure (a
            // transient masters error would mark the record `skipped`,
            // leaving its `an` cleared — we must then restore the prior
            // verdict so the row doesn't disappear permanently).
            await runAnalysisPass();
            // If the priorAn is still in the map, the pass failed to
            // produce a new verdict (skipped). Restore it so the row
            // doesn't fall out of `renderableRows`.
            if (priorAnByKeyRef.current.has(key)) {
                priorAnByKeyRef.current.delete(key);
                setData(d => {
                    if (!d?.activity) return d;
                    const target = findRecord(d.activity, record.id, record.p);
                    if (!target) return d;
                    // Only restore if the pass really didn't produce one.
                    if (target.record.an === undefined) {
                        target.record.an = priorAn;
                        return { ...d };
                    }
                    return d;
                });
                setReannotatingKeys(prev => {
                    if (!prev.has(key)) return prev;
                    const next = new Set(prev);
                    next.delete(key);
                    return next;
                });
            }
        } catch (e) {
            console.warn('Re-annotate failed:', e);
            // Restore prior verdict on hard failure.
            priorAnByKeyRef.current.delete(key);
            setReannotatingKeys(prev => {
                if (!prev.has(key)) return prev;
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
            // Drop the debug flag — no annotation will run for this row
            // (it falls out of `renderableRows` with no prior overlay), so
            // the one-shot would otherwise leak across future re-renders.
            debugRecordKeysRef.current.delete(key);
        }
    }, [dal, runAnalysisPass]);

    // ─────────────────────────────────────────────────────────────────────
    // Opponent analysis
    // ─────────────────────────────────────────────────────────────────────

    const handleAnalyzeOpponent = useCallback(async (record: GameRecord) => {
        if (!dal) return;
        if (analyzingRecordKey) return;
        const key = `${record.p}:${record.id}`;
        const row = orderedRows.find(r => `${r.record.p}:${r.record.id}` === key);
        if (!row) return;
        const ann = annotationByKey.get(key);
        if (!ann) return;
        const eot = deriveRecordEotPositions(record, row.userLower, ann);
        if (!eot) return;
        const userColor = getRecordUserColor(record, row.userLower);
        if (!userColor) return;
        const opponentName = getRecordOpponentName(record, row.userLower);
        const platform = record.p === 'c' ? 'chess.com' : 'lichess';
        const meta = getRecordMetadata(record, row.userLower);

        const abort = new AbortController();
        analyzeAbortRef.current = abort;
        setAnalyzingRecordKey(key);
        setAnalyzeProgress({ gamesDownloaded: 0, phase: 'downloading' });

        try {
            const result = await analyzeOpponentGames(
                {
                    recordId: record.id,
                    opponentUsername: opponentName,
                    platform,
                    fenBefore: eot.fenBefore,
                    fenAfter: eot.fenAfter,
                    opponentMoveSan: eot.opponentSan,
                    userMoveSan: eot.userSan,
                    targetPly: eot.targetPly,
                    excludeGameUrl: meta.gameUrl,
                },
                (progress) => setAnalyzeProgress(progress),
                abort.signal,
            );
            // Persist back to the blob.
            const op: OpponentAnalysisRecord = toPersistedOp(result);
            const fresh = await persistOpponentAnalysis(dal, record.id, record.p, op);
            setData(fresh);
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                console.error('Opponent analysis failed:', err);
            }
        } finally {
            setAnalyzingRecordKey(null);
            setAnalyzeProgress(null);
            analyzeAbortRef.current = null;
        }
    }, [dal, analyzingRecordKey, orderedRows, annotationByKey]);

    // ─────────────────────────────────────────────────────────────────────
    // DEBUG / TEMP — "Delete from here" action (remove before merging)
    // ─────────────────────────────────────────────────────────────────────

    const handleDeleteFromHere = useCallback(async (record: GameRecord) => {
        if (!dal) return;
        const confirmed = window.confirm(
            `[DEBUG] Delete this game and every newer one?\n\nThis removes every record with t >= ${record.t} from the saved blob. There is no undo.`,
        );
        if (!confirmed) return;

        // Abort any in-flight analysis pass and wait for it to unwind so
        // it can't race-write `an` against a record we're about to delete.
        passAbortRef.current?.abort();
        const inflight = passDonePromiseRef.current;
        if (inflight) {
            try { await inflight; } catch { /* swallowed by pass */ }
        }

        try {
            const fresh = await persistDeleteRecordsFromTimestamp(dal, record.t);
            setData(fresh);
            // Re-run the pass so anything left without `an` (shouldn't be
            // many — eviction kept the older records intact) gets picked up.
            await runAnalysisPass();
        } catch (e) {
            console.warn('[DEBUG] Delete-from-here failed:', e);
        }
    }, [dal, runAnalysisPass]);

    // ─────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────

    const showLichessPrompt = lichessAuthReady && !lichessConnected;

    return (
        <div className="games-page">
            <div className="games-header">
                <div className="linked-accounts-header">
                    <h1 className="games-title">Games</h1>
                    <div className="header-accounts-row">
                        {linkedAccounts.length > 0 ? (
                            <ul className="header-accounts-list">
                                {linkedAccounts.map((account) => (
                                    <li key={`${account.platform}:${account.username}`}>
                                        <span className="header-account-icon" aria-hidden="true">
                                            {account.platform === 'chess.com' ? '♔' : '♞'}
                                        </span>
                                        <span className="header-account-name">{account.username}</span>
                                        <span className="header-account-platform">
                                            {account.platform === 'chess.com' ? 'Chess.com' : 'Lichess'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <Link to="/settings" className="configure-accounts-link">
                                Configure linked accounts
                            </Link>
                        )}
                        {syncStatus && (
                            <span className="games-sync-controls">
                                <SyncStatusIndicator status={syncStatus} analysisProgress={analysisProgress} />
                                <button
                                    type="button"
                                    className="games-sync-button"
                                    onClick={() => runAnalysisPass()}
                                    disabled={syncStatus.phase === 'syncing'}
                                    title="Sync games now"
                                    aria-label="Sync games now"
                                >
                                    ↻
                                </button>
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {blockedByLichessCount > 0 && !lichessConnected && (
                <div className="lichess-warning">
                    {blockedByLichessCount} game{blockedByLichessCount === 1 ? '' : 's'} (not shown){' '}
                    {blockedByLichessCount === 1 ? 'requires' : 'require'} additional analysis using masters opening explorer.{' '}
                    <Link to="/settings">Connect to Lichess</Link> to finish analysis of{' '}
                    {blockedByLichessCount === 1 ? 'this game' : 'these games'} and to see{' '}
                    {blockedByLichessCount === 1 ? 'it' : 'them'}.
                </div>
            )}

            {pendingNetworkRetry > 0 && (
                <div className="lichess-warning">
                    {pendingNetworkRetry} game{pendingNetworkRetry === 1 ? '' : 's'} couldn&apos;t be analyzed
                    {' '}(masters API was unreachable). They&apos;ll be retried on your next visit.
                </div>
            )}

            {analysisError && <div className="games-error">{analysisError}</div>}

            {loading ? (
                <div className="games-empty"><p>Loading games…</p></div>
            ) : orderedRows.length === 0 ? (
                <div className="games-empty">
                    {linkedAccounts.length === 0 ? (
                        <>
                            <p>No games to show yet.</p>
                            <p className="no-accounts-hint">
                                <Link to="/settings">Add an account</Link> in Settings to start syncing your recent games.
                            </p>
                        </>
                    ) : showLichessPrompt ? (
                        <>
                            <p>Your games are saved, but viewing them requires a connected Lichess account for theory analysis.</p>
                            <p className="no-accounts-hint">
                                <Link to="/settings">Connect Lichess</Link> to start analyzing.
                            </p>
                        </>
                    ) : (
                        <>
                            <p>No analyzed games yet — they&apos;ll appear as you play.</p>
                            <p className="no-accounts-hint">
                                We sync your recent games automatically each time you open the Dashboard or this page.
                            </p>
                        </>
                    )}
                </div>
            ) : (
                <GamesList>
                    {orderedRows.map(({ record, userLower, pending }) => {
                        const key = `${record.p}:${record.id}`;
                        const annotation = annotationByKey.get(key) ?? null;
                        const op = opByKey.get(key);
                        return (
                            <GameRow
                                key={key}
                                record={record}
                                userLower={userLower}
                                annotation={annotation}
                                opponentAnalysis={op?.live ?? null}
                                opIsStale={op?.stale ?? false}
                                reannotating={reannotatingKeys.has(key)}
                                pending={pending}
                                analyzeProgress={analyzingRecordKey === key ? analyzeProgress : null}
                                analyzeDisabled={analyzingRecordKey !== null}
                                onReannotate={handleReannotate}
                                onAnalyzeOpponent={handleAnalyzeOpponent}
                                onDeleteFromHere={handleDeleteFromHere}
                            />
                        );
                    })}
                    {orderedRows.length >= MAX_TOTAL_RECORDS && (
                        <div className="games-footer-hint">
                            Showing your last {MAX_TOTAL_RECORDS} analyzed games. Older games are dropped as you play new ones.
                        </div>
                    )}
                </GamesList>
            )}
        </div>
    );
};

/**
 * Direct parent of the rendered `GameRow` elements. Plain wrapper —
 * no reorder animation; skeleton rows simply snap into place when
 * inserted or hydrated.
 */
const GamesList: React.FC<{
    children: React.ReactNode;
}> = ({ children }) => {
    return (
        <div className="games-list">
            {children}
        </div>
    );
};

export default GamesPage;
