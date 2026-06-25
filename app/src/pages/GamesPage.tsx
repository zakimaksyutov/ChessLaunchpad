import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChessBoard } from 'chess-control';
import type { Annotation as ChessControlAnnotation, Square } from 'chess-control';
import { getSessionStore } from '../data/SessionStore';
import { DataAccessError } from '../data/DataAccessLayer';
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
    annotateRecordFromFrozen,
    getRecordMetadata,
    getRecordOpponentName,
    deriveRecordEotPositions,
} from '../services/RecordAnnotation';
import {
    MastersMemoEntry,
} from '../services/GameRecordAnalysisPlanner';
import {
    AnalysisProgress,
    AnalyzedGameOutcome,
    ANALYSIS_FLUSH_BATCH,
    buildAnalysisPlan,
    analyzeOneGame,
    flushFanUpdates,
    persistOpponentAnalysis,
    persistGameReviewed,
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
import {
    computeSuggestion,
    SuggestionResult,
    SuggestionPly,
    MastersProvider,
    CloudEvalCpProvider,
} from '../services/GameSuggestionService';
import { fetchMastersOutcome } from '../services/MastersExplorerService';
import { fetchCloudCpOutcome } from '../services/LichessCloudEvalService';
import { buildLichessAnalysisUrl } from '../utils/LichessUrl';
import { runIngest } from '../services/GameIngestService';
import { isSyncThrottled, markSyncedNow, getLastSyncAt } from '../services/SyncThrottle';
import { orderRowsSticky, OrderableRow } from '../services/GameRowOrdering';
import { selectRenderableRows } from '../services/GameRowSelection';
import { fetchLichessGameExport } from '../services/LichessGameExportService';
import { composeSignals } from '../utils/composeSignals';
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

/**
 * Game list filter. The default `unreviewed` is the "review queue" — mistake
 * games the user hasn't yet marked reviewed. `reviewed` and `mistakes` are the
 * other mistake views; `all` shows every game (clean ones too).
 */
type GameFilter = 'unreviewed' | 'reviewed' | 'mistakes' | 'all';

/** Coerce a stored filter value to a valid `GameFilter`, migrating the legacy
 *  two-way toggle (`with-issues`/`all`) onto the new set. */
function normalizeStoredFilter(stored: string | null): GameFilter {
    switch (stored) {
        case 'all':
        case 'reviewed':
        case 'mistakes':
        case 'unreviewed':
            return stored;
        case 'with-issues': // legacy: "hide clean games"
            return 'unreviewed';
        default:
            return 'unreviewed';
    }
}

/** Message shown when the active filter selects no games. */
function filterEmptyMessage(
    filter: GameFilter,
    counts: { mistakes: number },
): string {
    switch (filter) {
        case 'reviewed':
            return 'No games marked as reviewed yet.';
        case 'unreviewed':
            return counts.mistakes === 0
                ? 'No mistakes — every game followed your repertoire. 🎉'
                : 'All mistakes reviewed — your queue is clear. 🎉';
        case 'mistakes':
            return 'No mistakes — every game followed your repertoire. 🎉';
        case 'all':
            return 'No games to show.';
    }
}

/** True when a game annotation contains a repertoire deviation or an EOT eval-drop issue. */
function gameRowHasIssue(ann: GameAnnotation): boolean {
    if (ann.deviation != null) return true;
    for (const m of ann.moves) {
        if (m.highlight === 'out-of-repertoire-response' && m.evalDrop && m.evalDrop.category !== 'ok') {
            return true;
        }
    }
    return false;
}

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

/**
 * Per-row state for the "Suggest a fix" feature. Recomputed on each click,
 * not persisted. `need-lichess` is shown when the user clicks with no Lichess
 * token (the masters explorer the algorithm depends on requires OAuth).
 */
type SuggestionState =
    | { status: 'loading' }
    | { status: 'need-lichess' }
    | { status: 'error' }
    | { status: 'ready'; result: SuggestionResult };

function suggestionMoveClass(ply: SuggestionPly): string {
    if (ply.inRepertoire) return 'move-token move-in-repertoire';
    if (!ply.isUserMove) return 'move-token move-opponent';
    return 'move-token';
}

const SuggestionDisplay: React.FC<{
    state: SuggestionState;
    orientation: 'white' | 'black';
}> = ({ state, orientation }) => {
    if (state.status === 'loading') {
        return (
            <div className="suggest-fix-result suggest-fix-loading" role="status" aria-live="polite">
                <span className="games-sync-spinner" aria-hidden="true" />
                <span>Finding a line to add…</span>
            </div>
        );
    }
    if (state.status === 'need-lichess') {
        return (
            <div className="suggest-fix-result suggest-fix-connect">
                Suggesting a fix needs the masters opening explorer.{' '}
                <Link to="/settings">Connect Lichess</Link> to enable it.
            </div>
        );
    }
    if (state.status === 'error') {
        return (
            <div className="suggest-fix-result suggest-fix-error">
                Couldn&apos;t build a suggestion right now — please try again.
            </div>
        );
    }

    const { result } = state;
    if (result.plies.length === 0) {
        return (
            <div className="suggest-fix-result suggest-fix-error">
                No suggestion available for this position.
            </div>
        );
    }
    const lichessUrl = buildLichessAnalysisUrl(result.pgn, orientation);
    const addUrl = `/explorer?o=${orientation}&addpgn=${encodeURIComponent(result.pgn)}`;
    return (
        <div className="suggest-fix-result suggest-fix-ready">
            <div className="suggest-fix-label">Suggested line</div>
            <div className="game-pgn suggest-fix-pgn">
                {result.plies.map((ply, idx) => (
                    <React.Fragment key={idx}>
                        {ply.moveNumber !== undefined && (
                            <span className="move-number">{ply.moveNumber}.&nbsp;</span>
                        )}
                        <span className={suggestionMoveClass(ply)}>{ply.san}</span>
                        {' '}
                    </React.Fragment>
                ))}
            </div>
            <div className="suggest-fix-actions">
                <a
                    className="suggest-fix-action"
                    href={lichessUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Open in Lichess Opening Explorer
                </a>
                <Link className="suggest-fix-action" to={addUrl}>
                    Add to repertoire
                </Link>
            </div>
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
    /** True when the user has marked this game reviewed (`record.rv === 1`). */
    reviewed: boolean;
    onReannotate: (record: GameRecord, userLower: string) => void;
    onAnalyzeOpponent: (record: GameRecord) => void;
    /** Toggle this game's reviewed flag. Only offered on mistake rows. */
    onToggleReviewed: (record: GameRecord) => void;
    /** DEBUG / TEMP — delete this record and every newer one. */
    onDeleteFromHere: (record: GameRecord) => void;
    /** Current "Suggest a fix" state for this row (null when not yet requested). */
    suggestion: SuggestionState | null;
    /** Compute (or recompute) a repertoire-fix suggestion for this row. */
    onSuggestFix: (record: GameRecord, userLower: string) => void;
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
    reviewed,
    onReannotate,
    onAnalyzeOpponent,
    onToggleReviewed,
    onDeleteFromHere,
    suggestion,
    onSuggestFix,
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
    // A "mistake" row — has a deviation or an EOT eval-drop. Mirrors
    // `gameRowHasIssue`. Only mistake rows offer the reviewed toggle.
    const isMistake = hasDeviation || eotSummary !== null;
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
            className={`game-row${tileClass}${pending ? ' game-row-pending' : ''}`}
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
                    {!pending && isMistake && (
                        <button
                            type="button"
                            className={`game-review-toggle${reviewed ? ' game-review-toggle-done' : ''}`}
                            onClick={() => onToggleReviewed(record)}
                            title={reviewed
                                ? 'Marked as reviewed — click to move back to your review queue'
                                : 'Mark this game as reviewed'}
                        >
                            {reviewed ? '✓ Reviewed' : 'Mark reviewed'}
                        </button>
                    )}
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
                                {annotation.moves.map((move, idx) => {
                                    const explorerLink =
                                        move.isUserMove &&
                                        move.highlight === 'in-repertoire' &&
                                        move.fenAfter
                                            ? `?o=${meta.userColor}&fen=${encodeURIComponent(move.fenAfter)}`
                                            : null;
                                    return (
                                        <React.Fragment key={idx}>
                                            {move.moveNumber !== undefined && (
                                                <span className="move-number">{move.moveNumber}.&nbsp;</span>
                                            )}
                                            {explorerLink ? (
                                                <Link
                                                    className={`${getMoveClassName(move)} move-link`}
                                                    to={{ pathname: '/explorer', search: explorerLink }}
                                                    title="Open in Explorer"
                                                >
                                                    {move.san}
                                                </Link>
                                            ) : (
                                                <span className={getMoveClassName(move)}>{move.san}</span>
                                            )}
                                            {' '}
                                        </React.Fragment>
                                    );
                                })}
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
                                {suggestion?.status !== 'loading' && !hasDeviation && (
                                    <>
                                        {allowAnalyzeAction && !analyzeProgress && (
                                            <span className="game-action-sep" aria-hidden="true">|</span>
                                        )}
                                        <a
                                            className="analyze-opponent-link suggest-fix-link"
                                            role="button"
                                            onClick={() => onSuggestFix(record, userLower)}
                                            title="Propose a line to add to your repertoire"
                                        >
                                            Suggest a fix
                                        </a>
                                    </>
                                )}
                            </div>
                        )}

                        {eotSummary && !hasDeviation && suggestion && (
                            <SuggestionDisplay state={suggestion} orientation={meta.userColor ?? 'white'} />
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
    const [syncStatus, setSyncStatus] = useState<SyncState | null>(() => {
        // Seed from the shared last-sync time so a throttled visit shows the
        // real "Synced @ HH:MM" immediately (shared with the Dashboard).
        const last = getLastSyncAt();
        return last !== null ? { phase: 'synced', at: new Date(last) } : null;
    });
    const [awaitingMastersCount, setAwaitingMastersCount] = useState(0);
    const [pendingNetworkRetry, setPendingNetworkRetry] = useState(0);
    const [analyzingRecordKey, setAnalyzingRecordKey] = useState<string | null>(null);
    const [analyzeProgress, setAnalyzeProgress] = useState<OpponentAnalysisProgress | null>(null);
    /**
     * Per-row "Suggest a fix" state, keyed by `${p}:${id}`. Recomputed on each
     * click (not persisted). Entries live for the page visit and are released
     * on unmount; growth is bounded by the number of distinct rows clicked.
     */
    const [suggestionByKey, setSuggestionByKey] = useState<Map<string, SuggestionState>>(new Map());
    /** Per-row abort controllers for in-flight suggestion computations. */
    const suggestAbortByKeyRef = useRef<Map<string, AbortController>>(new Map());
    /**
     * Records currently being re-annotated. We keep them visible in the
     * list during the re-run by holding their prior `fan` in
     * `priorFanByKey` and patching it into the rendered record so the row
     * never drops out of `renderableRows`. On success the new `fan` lands;
     * on failure we restore the prior `fan` and unset the badge.
     */
    const [reannotatingKeys, setReannotatingKeys] = useState<Set<string>>(new Set());
    const priorFanByKeyRef = useRef<Map<string, NonNullable<GameRecord['fan']>>>(new Map());
    /**
     * Records flagged for a one-shot debug annotation trace. Populated by
     * `handleReannotate`; threaded into the analysis pass (`buildAnalysisPlan`)
     * so the engine emits its ply-by-ply trace while re-annotating, then
     * cleared when the pass completes. (Render no longer runs the engine, so
     * the trace lives on the analysis path now.)
     */
    const debugRecordKeysRef = useRef<Set<string>>(new Set());
    const passAbortRef = useRef<AbortController | null>(null);
    /**
     * Page-scoped AbortController composed into every long-running
     * background write on this page so navigation away cancels them
     * before their next PUT — eliminates the sync-vs-training 412 race.
     *
     * StrictMode caveat: cleanup defers `.abort()` by a tick so the
     * synthetic remount's effect run can clear the timer before it fires.
     */
    const pageAbortRef = useRef<AbortController | null>(null);
    const pendingPageAbortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Single-flight guard so a StrictMode re-mount or rapid trigger doesn't double-start a pass. */
    const passStartedRef = useRef(false);
    /** Promise resolved when the current pass's `finally` completes — used by Re-annotate to chain. */
    const passDonePromiseRef = useRef<Promise<void> | null>(null);
    /** Memoize the record-key→position-in-the-sticky-session-list so late-arriving games go to the bottom. */
    const sessionOrderRef = useRef<Map<string, number>>(new Map());
    /**
     * Records that the current analysis pass has planned but not yet
     * analyzed. Rendered as skeleton placeholders so the row's slot is
     * reserved *before* the annotation lands — eliminates the "rows pop in
     * newest-first, push everything down" jumping effect that used to
     * happen as each game's `fan` arrived.
     *
     * Populated right after `buildAnalysisPlan` returns; trimmed as
     * each game's `fan` lands; cleared in the pass's `finally`.
     */
    const [pendingAnalysisKeys, setPendingAnalysisKeys] = useState<Set<string>>(new Set());

    // Filter: show the unreviewed-mistakes "review queue" by default.
    // Persisted per-user in localStorage.
    const filterKey = useMemo(
        () => `games:filter:${localStorage.getItem('username') ?? ''}`,
        [],
    );
    const [gameFilter, setGameFilter] = useState<GameFilter>(
        () => normalizeStoredFilter(localStorage.getItem(filterKey)),
    );
    const selectGameFilter = useCallback((next: GameFilter) => {
        setGameFilter(next);
        localStorage.setItem(filterKey, next);
    }, [filterKey]);

    const measurePerf = useMemo(() => getMeasurePerf(), []);
    const perfT0Ref = useRef(measurePerf ? performance.now() : 0);

    const { ready: lichessAuthReady, connected: lichessConnected, token: lichessToken } = useLichessAuth();
    const [linkedAccounts, setLinkedAccountsState] = useState<LinkedAccount[]>(() => getLinkedAccounts());

    const dal = useMemo(() => getSessionStore().createDataAccessProxyLayer(), []);

    // Refresh linked accounts when page gains focus.
    useEffect(() => {
        const refresh = () => setLinkedAccountsState(getLinkedAccounts());
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, []);

    // Initial load: repertoire data + fen sets + explorer evals.
    useEffect(() => {
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

    // Page-scoped abort lifecycle — see `pageAbortRef` declaration
    // above for the full rationale. Cleanup defers `.abort()` by a
    // tick so React's StrictMode synthetic remount can clear the
    // timer before it fires.
    useEffect(() => {
        if (pendingPageAbortTimerRef.current) {
            clearTimeout(pendingPageAbortTimerRef.current);
            pendingPageAbortTimerRef.current = null;
        }
        if (!pageAbortRef.current) {
            pageAbortRef.current = new AbortController();
        }
        const controller = pageAbortRef.current;
        return () => {
            pendingPageAbortTimerRef.current = setTimeout(() => {
                pendingPageAbortTimerRef.current = null;
                controller.abort();
                if (pageAbortRef.current === controller) {
                    pageAbortRef.current = null;
                }
            }, 0);
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
     * Renderable rows: those with `fan` present, PLUS records currently
     * being re-annotated (whose `fan` has been cleared in the blob but for
     * which we hold a `priorFan` to keep the row visible until the new
     * annotation lands or the re-run fails), PLUS records queued for the
     * current analysis pass (rendered as skeletons so the row's slot is
     * reserved before content arrives).
     *
     * Re-annotation overlay takes precedence over the skeleton state so
     * a re-annotating row keeps showing its prior `fan` instead of
     * collapsing into a placeholder. See `selectRenderableRows`.
     */
    const renderableRows = useMemo(() => {
        return selectRenderableRows(
            allRecords,
            reannotatingKeys,
            priorFanByKeyRef.current,
            pendingAnalysisKeys,
        );
    }, [allRecords, reannotatingKeys, pendingAnalysisKeys]);

    /**
     * Sticky session ordering: rows already shown keep their slot; new
     * rows are placed by timestamp relative to the current bounds.
     * Re-annotating rows stay in `renderableRows` via the prior-`fan`
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

    // Annotation cache: per-record WeakMap memo so the reveal-as-ready
    // loop (which fires `setData(d => ({...d}))` per analyzed game) only
    // reconstructs rows whose `record.fan` actually changed — avoiding
    // repeated chess.js replay on large row counts. Reuse a cached entry
    // only when `fan` identity still matches (`record.fan` is replaced
    // wholesale by the reveal patch, so identity is a precise invalidation
    // signal). Pending rows skip reconstruction.
    //
    // Render is a pure read of `fan` (+ replaying `m`): no repertoire FEN
    // sets, no ExplorerEvals, no masters lookups. This fixes the retroactive
    // false-mistake (editing the repertoire later can't change a frozen
    // verdict) and the eval-resource load-order flash (rows paint correctly
    // on first render).
    const annotationCacheRef = useRef<WeakMap<GameRecord, {
        fan: GameRecord['fan'];
        annotation: GameAnnotation | null;
    }>>(new WeakMap());
    const annotationByKey = useMemo(() => {
        const map = new Map<string, GameAnnotation | null>();
        const cache = annotationCacheRef.current;
        for (const { record, userLower, pending } of orderedRows) {
            const key = `${record.p}:${record.id}`;
            if (pending) {
                map.set(key, null);
                continue;
            }
            const cached = cache.get(record);
            if (cached && cached.fan === record.fan) {
                map.set(key, cached.annotation);
                continue;
            }
            const ann = annotateRecordFromFrozen(record, userLower);
            cache.set(record, { fan: record.fan, annotation: ann });
            map.set(key, ann);
        }
        return map;
    }, [orderedRows]);

    // Opponent-analysis live state per record: derived from record.op + a
    // per-row "stale?" check. A row's op is stale iff its anchored ply is
    // no longer the first non-ok user out-of-rep response in the annotation.
    const opByKey = useMemo(() => {
        const map = new Map<string, { live: OpponentAnalysisResult; stale: boolean }>();
        for (const { record, pending } of orderedRows) {
            if (pending) continue;
            if (!record.op) continue;
            const key = `${record.p}:${record.id}`;
            const ann = annotationByKey.get(key);
            const live = fromPersistedOp(record.op);
            // Stale check: does the live deviation at this ply still exist
            // as the first EOT eval-drop?
            let stale = true;
            if (ann) {
                const eot = deriveRecordEotPositions(record, ann);
                if (eot && eot.targetPly === record.op.ply) stale = false;
            }
            map.set(key, { live, stale });
        }
        return map;
    }, [orderedRows, annotationByKey]);

    // ─────────────────────────────────────────────────────────────────────
    // Filter: separate rows with issues from clean rows
    // ─────────────────────────────────────────────────────────────────────

    // Annotations are reconstructed synchronously from each record's frozen
    // `fan`, so classification is available as soon as the row is renderable
    // (a record either has `fan` and is annotated, or has none and isn't a
    // content row). No external resource (ExplorerEvals) gates the filter.
    const filterReady = data != null;

    /**
     * Per-bucket counts across non-pending, annotated rows. A "mistake" is a
     * row with a deviation or EOT eval-drop issue; mistakes split into
     * `reviewed` (`record.rv === 1`) vs `unreviewed`. `clean` rows have no
     * issue. These drive the filter-bar chip counts.
     */
    const filterCounts = useMemo(() => {
        let clean = 0;
        let unreviewed = 0;
        let reviewed = 0;
        if (filterReady) {
            for (const row of orderedRows) {
                if (row.pending) continue;
                const key = `${row.record.p}:${row.record.id}`;
                const ann = annotationByKey.get(key);
                if (!ann) continue; // unannotated ≠ a counted game
                if (gameRowHasIssue(ann)) {
                    if (row.record.rv === 1) reviewed++;
                    else unreviewed++;
                } else {
                    clean++;
                }
            }
        }
        const mistakes = unreviewed + reviewed;
        return { clean, unreviewed, reviewed, mistakes, total: clean + mistakes };
    }, [orderedRows, annotationByKey, filterReady]);

    const visibleRows = useMemo(() => {
        if (!filterReady || gameFilter === 'all') return orderedRows;
        const visible: typeof orderedRows = [];
        for (const row of orderedRows) {
            // Pending rows are still being analyzed — we don't yet know if
            // they're mistakes, so keep them visible regardless of filter.
            if (row.pending) {
                visible.push(row);
                continue;
            }
            const key = `${row.record.p}:${row.record.id}`;
            const ann = annotationByKey.get(key);
            // Show rows whose annotation hasn't been computed yet (unannotated ≠ clean).
            if (!ann) {
                visible.push(row);
                continue;
            }
            const issue = gameRowHasIssue(ann);
            const reviewed = row.record.rv === 1;
            const show =
                gameFilter === 'mistakes' ? issue
                    : gameFilter === 'reviewed' ? issue && reviewed
                        : /* unreviewed */ issue && !reviewed;
            if (show) visible.push(row);
        }
        return visible;
    }, [orderedRows, annotationByKey, gameFilter, filterReady]);

    // ─────────────────────────────────────────────────────────────────────
    // Analysis pass
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Run the full landing-flow analysis pipeline (steps 1-5):
     *   1. background ingest (so new games land)
     *   2. eviction happens inside ingest
     *   3. plan ambiguous positions per record (no network)
     *   4. analyze oldest-first, sequentially, batched flush back
     *
     * Returns a promise that resolves when the pass's `finally` has run.
     * Callers (Re-annotate, the cleanup effect) await this promise to
     * chain new passes / cancellation safely without busy-waiting.
     */
    const runAnalysisPass = useCallback((force = false): Promise<void> => {
        // Single-flight guard.
        if (passStartedRef.current) {
            return passDonePromiseRef.current ?? Promise.resolve();
        }
        passStartedRef.current = true;

        const abort = new AbortController();
        passAbortRef.current = abort;
        // Combine the page-scoped abort signal with the local pass
        // controller so navigation away from /games (page abort) and
        // explicit pass cancellation (handleReannotate, delete-from-here)
        // both unwind the same pass.
        const signal = composeSignals(abort.signal, pageAbortRef.current?.signal);

        // Use a slot so the IIFE's `finally` can compare against the
        // already-published promise without referring to itself.
        const slot: { promise?: Promise<void> } = {};

        slot.promise = (async () => {
            try {
                // Clear any prior pass's error so a successful re-run
                // doesn't leave a stale banner from an earlier failure.
                setAnalysisError('');
                // Step 1 + 2: ingest (writes records + evicts). The ingest pipeline
                // is the shared write path for record append + eviction.
                //
                // Throttle the provider game-download: skip the auto ingest when
                // we queried the providers < SYNC_THROTTLE_MS ago. The analysis
                // steps below still run, so already-stored but not-yet-annotated
                // games (e.g. just ingested from the Dashboard) are still
                // annotated. The ↻ button passes `force` to bypass this. See
                // services/SyncThrottle.ts.
                setSyncStatus(prev => (prev?.phase === 'syncing' ? prev : { phase: 'syncing' }));
                setAnalysisProgress({ phase: 'planning' });
                if (force || !isSyncThrottled()) {
                    // Stamp at commit-to-fetch (start) so rapid navigation
                    // between pages doesn't re-query the providers.
                    markSyncedNow();
                    await runIngest(dal, undefined, signal);
                }

                // Re-fetch the blob to pick up newly ingested records.
                const fresh = await dal.retrieveRepertoireData();
                if (signal.aborted) return;
                setData(fresh);
                const sets = buildRepertoireFenSets(fresh.repertoires ?? []);
                setFenSets(sets);

                // Step 3: build the plan. Debug keys (set by Re-annotate)
                // make the engine emit its one-shot ply-by-ply trace for the
                // targeted record while it's analyzed. Every queued game runs;
                // the walk itself defers any that need masters with no token.
                const runnable = buildAnalysisPlan(fresh, debugRecordKeysRef.current);
                // Reset the "awaiting Lichess" banner; it re-accumulates below as
                // games defer on reaching an ambiguous position with no token.
                setAwaitingMastersCount(0);

                if (runnable.length === 0) {
                    setAnalysisProgress({ phase: 'idle' });
                    return;
                }

                // Reserve a skeleton slot for every runnable job *before* the
                // analyze loop starts. Each row appears immediately as a
                // pending placeholder in its final newest-first slot, then
                // hydrates in place when its `fan` lands — eliminating the
                // newest-first jump-and-push effect that used to happen as
                // games completed one at a time.
                const runnableKeys = runnable.map(j => `${j.record.p}:${j.record.id}`);
                setPendingAnalysisKeys(new Set(runnableKeys));

                // Step 4: run sequentially with per-pass memos. The engine
                // resolves cloud evals and masters verdicts on demand as it
                // walks each game; both memos dedup those lookups across games.
                const memo = new Map<string, MastersMemoEntry>();
                const cloudMemo = new Map<string, number | null>();
                const pendingFlush: AnalyzedGameOutcome[] = [];
                let networkRetryCount = 0;

                for (let i = 0; i < runnable.length; i++) {
                    if (signal.aborted) break;
                    const job = runnable[i];
                    setAnalysisProgress({
                        phase: 'analyzing',
                        gameIndex: i + 1,
                        gameTotal: runnable.length,
                    });
                    const outcome = await analyzeOneGame(
                        job,
                        lichessToken,
                        memo,
                        cloudMemo,
                        explorerEvals,
                        signal,
                    );
                    if (outcome.skipped) {
                        if (outcome.awaitingMasters) {
                            // Deferred for lack of a Lichess token. Count it for
                            // the banner and queue its cloud-eval back-fill so a
                            // later connect re-runs without re-fetching.
                            setAwaitingMastersCount(c => c + 1);
                            if (outcome.evUpdate && outcome.evUpdate.size > 0) {
                                pendingFlush.push(outcome);
                            }
                        } else {
                            networkRetryCount += 1;
                        }
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
                        const pendingFan = outcome.fan;
                        setData(d => {
                            if (!d?.activity) return d;
                            const target = findRecord(d.activity, outcome.record.id, outcome.record.p);
                            if (!target) return d;
                            target.record.fan = pendingFan;
                            // Drop any legacy masters-verdict field still on an
                            // old in-memory record so it doesn't linger.
                            delete (target.record as { an?: unknown }).an;
                            // Shallow clone to force re-render — the in-place
                            // mutation above is on a shared subtree that needs
                            // a new top-level reference for `useMemo` to invalidate.
                            return { ...d };
                        });
                        // If this record was being re-annotated, swap in the new
                        // annotation and clear the badge.
                        const recKey = `${outcome.record.p}:${outcome.record.id}`;
                        if (priorFanByKeyRef.current.has(recKey)) {
                            priorFanByKeyRef.current.delete(recKey);
                            setReannotatingKeys(prev => {
                                if (!prev.has(recKey)) return prev;
                                const next = new Set(prev);
                                next.delete(recKey);
                                return next;
                            });
                        }
                        // Drop the skeleton slot — the row now has `fan` and
                        // can render normally. The next render hydrates the
                        // existing placeholder in place (no reorder).
                        setPendingAnalysisKeys(prev => {
                            if (!prev.has(recKey)) return prev;
                            const next = new Set(prev);
                            next.delete(recKey);
                            return next;
                        });
                    }

                    if (pendingFlush.length >= ANALYSIS_FLUSH_BATCH) {
                        setAnalysisProgress(prev => prev.phase === 'analyzing' ? { ...prev, phase: 'flushing' } : prev);
                        const { data: fresh2 } = await flushFanUpdates(dal, pendingFlush.splice(0), signal);
                        if (signal.aborted) break;
                        // Re-apply our optimistic in-memory `fan` mutations onto
                        // the freshly-decoded tree so subsequent reveal-as-ready
                        // patches keep landing in the rendered subtree.
                        setData(fresh2);
                    }
                }

                if (pendingFlush.length > 0 && !signal.aborted) {
                    setAnalysisProgress(prev =>
                        prev.phase === 'analyzing'
                            ? { phase: 'flushing', gameIndex: prev.gameIndex, gameTotal: prev.gameTotal }
                            : { phase: 'flushing' }
                    );
                    const { data: fresh3 } = await flushFanUpdates(dal, pendingFlush, signal);
                    if (!signal.aborted) setData(fresh3);
                }

                setPendingNetworkRetry(networkRetryCount);
                setAnalysisProgress({ phase: 'idle' });
            } catch (e: unknown) {
                // Abort = user clicked Re-annotate / Delete-from-here
                // or navigated away. Clean unwind, not a failure.
                if (signal.aborted || (e as { name?: string })?.name === 'AbortError') {
                    setAnalysisProgress({ phase: 'idle' });
                    return;
                }
                // 412 = the app-root <ConflictModal> already fired (via
                // SessionStore.save's notifyConflict) and is showing the
                // Reload prompt. Don't surface an inline analysis-error
                // banner under the modal — the modal owns recovery.
                if (e instanceof DataAccessError && e.statusCode === 412) {
                    setAnalysisProgress({ phase: 'idle' });
                    return;
                }
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('GamesPage: analysis pass failed', e);
                setAnalysisError(msg);
                setAnalysisProgress({ phase: 'idle' });
            } finally {
                // Stamp the sync time on every completion path (success, error,
                // empty-run) — matches the Dashboard's silent-error contract.
                // Source it from the shared throttle stamp so both pages agree
                // on "last sync" (falls back to now if we've never synced, e.g.
                // an analysis-only pass with no linked accounts).
                setSyncStatus({ phase: 'synced', at: new Date(getLastSyncAt() ?? Date.now()) });
                // Drop any remaining skeleton slots. The per-game drop in
                // the analyze loop handles successful completions; this
                // covers abort / error / network-skip leftovers so we don't
                // leak permanent skeleton rows after the pass ends.
                setPendingAnalysisKeys(prev => (prev.size === 0 ? prev : new Set()));
                // One-shot debug traces have fired (or the pass aborted) —
                // clear the flags so they don't re-trigger on a later pass.
                if (debugRecordKeysRef.current.size > 0) {
                    debugRecordKeysRef.current.clear();
                }
                passStartedRef.current = false;
                if (passAbortRef.current === abort) {
                    passAbortRef.current = null;
                }
                if (passDonePromiseRef.current === slot.promise) {
                    passDonePromiseRef.current = null;
                }
                // Abort the per-pass controller so composeSignals' cleanup
                // removes the listener it attached to the long-lived
                // pageAbortRef signal — otherwise dead listeners would
                // accumulate across successful passes.
                abort.abort();
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
        const key = `${record.p}:${record.id}`;
        const priorFan = record.fan;
        if (priorFan === undefined) return; // already being re-annotated

        // Capture the prior `fan` so `renderableRows` keeps the row visible
        // through the clear → re-fetch → re-pass window. Set the badge.
        priorFanByKeyRef.current.set(key, priorFan);
        setReannotatingKeys(prev => new Set(prev).add(key));
        // Flag for a one-shot debug trace from the analysis pass that runs
        // against the cleared record (consumed in `runAnalysisPass`).
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
            // Page-scoped signal so navigating away while a Re-annotate
            // is in flight stops the underlying persist call before its
            // PUT (and unwinds the analysis pass we re-trigger below).
            const pageSignal = pageAbortRef.current?.signal;
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
                        await persistReannotateRefresh(dal, fresh, pageSignal);
                        refreshed = true;
                    }
                }
            }
            const fresh = refreshed
                ? await dal.retrieveRepertoireData()
                : await persistReannotateClear(dal, record.id, record.p, pageSignal);
            setData(fresh);
            // Re-trigger and AWAIT the pass so we can detect failure (a
            // transient masters error would mark the record `skipped`,
            // leaving its `fan` cleared — we must then restore the prior
            // annotation so the row doesn't disappear permanently).
            await runAnalysisPass();
            // If the priorFan is still in the map, the pass failed to
            // produce a new annotation (skipped). Restore it so the row
            // doesn't fall out of `renderableRows`.
            if (priorFanByKeyRef.current.has(key)) {
                priorFanByKeyRef.current.delete(key);
                setData(d => {
                    if (!d?.activity) return d;
                    const target = findRecord(d.activity, record.id, record.p);
                    if (!target) return d;
                    // Only restore if the pass really didn't produce one.
                    if (target.record.fan === undefined) {
                        target.record.fan = priorFan;
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
            // Abort = navigation away or new Re-annotate / Delete-from-here
            // request. Not a "real" failure — don't log, don't reset the
            // re-annotate UI state (the component is unmounting or the
            // newer action will manage its own cleanup).
            if ((e as { name?: string })?.name === 'AbortError'
                || pageAbortRef.current?.signal.aborted) {
                return;
            }
            // 412 = the app-root <ConflictModal> already fired and owns
            // recovery. Skip the warn to keep log noise consistent with
            // the other 412 catches; still restore local UI state below
            // (harmless on the imminent reload).
            const isConflict = e instanceof DataAccessError && e.statusCode === 412;
            if (!isConflict) {
                console.warn('Re-annotate failed:', e);
            }
            // Restore prior annotation on hard failure.
            priorFanByKeyRef.current.delete(key);
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
        if (analyzingRecordKey) return;
        const key = `${record.p}:${record.id}`;
        const row = orderedRows.find(r => `${r.record.p}:${r.record.id}` === key);
        if (!row) return;
        const ann = annotationByKey.get(key);
        if (!ann) return;
        const eot = deriveRecordEotPositions(record, ann);
        if (!eot) return;
        const userColor = getRecordUserColor(record, row.userLower);
        if (!userColor) return;
        const opponentName = getRecordOpponentName(record, row.userLower);
        const platform = record.p === 'c' ? 'chess.com' : 'lichess';
        const meta = getRecordMetadata(record, row.userLower);

        const abort = new AbortController();
        // Compose with the page signal so navigation away from /games
        // aborts the in-flight analyze + the subsequent persist call.
        const signal = composeSignals(abort.signal, pageAbortRef.current?.signal);
        setAnalyzingRecordKey(key);
        setAnalyzeProgress({ gamesDownloaded: 0, phase: 'downloading' });

        try {
            const result = await analyzeOpponentGames(
                {
                    opponentUsername: opponentName,
                    platform,
                    fenBefore: eot.fenBefore,
                    fenAfter: eot.fenAfter,
                    opponentMoveSan: eot.opponentSan,
                    userMoveSan: eot.userSan,
                    targetPly: eot.targetPly,
                    excludeGameUrl: meta.gameUrl.replace(/\/(white|black)$/, ''),
                },
                (progress) => setAnalyzeProgress(progress),
                signal,
            );
            // Persist back to the blob.
            const op: OpponentAnalysisRecord = toPersistedOp(result);
            const fresh = await persistOpponentAnalysis(dal, record.id, record.p, op, signal);
            setData(fresh);
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                console.error('Opponent analysis failed:', err);
            }
        } finally {
            setAnalyzingRecordKey(null);
            setAnalyzeProgress(null);
            // Same listener-leak guard as the analysis-pass finally above.
            abort.abort();
        }
    }, [dal, analyzingRecordKey, orderedRows, annotationByKey]);

    // ─────────────────────────────────────────────────────────────────────
    // Suggest a fix
    // ─────────────────────────────────────────────────────────────────────

    const handleSuggestFix = useCallback(async (record: GameRecord, userLower: string) => {
        const key = `${record.p}:${record.id}`;

        // The suggestion algorithm depends on the masters explorer (OAuth-gated);
        // with no token, prompt to connect instead of computing.
        if (!lichessToken) {
            setSuggestionByKey(prev => new Map(prev).set(key, { status: 'need-lichess' }));
            return;
        }
        const userColor = getRecordUserColor(record, userLower);
        // `fenSets` can still be loading on a very early click; `userColor` should
        // never be null for a rendered row. Either way, surface feedback rather
        // than swallowing the click silently.
        if (!fenSets || !userColor) {
            setSuggestionByKey(prev => new Map(prev).set(key, { status: 'error' }));
            return;
        }

        // Abort any prior in-flight computation for this row (re-click recomputes).
        suggestAbortByKeyRef.current.get(key)?.abort();
        const abort = new AbortController();
        suggestAbortByKeyRef.current.set(key, abort);
        const signal = composeSignals(abort.signal, pageAbortRef.current?.signal);

        setSuggestionByKey(prev => new Map(prev).set(key, { status: 'loading' }));

        const token = lichessToken;
        const masters: MastersProvider = async (fen) => {
            const outcome = await fetchMastersOutcome(fen, token);
            // Transient masters failure (429 / network / non-2xx): abort the
            // suggestion rather than emit a truncated "no master games" line.
            if (outcome.kind === 'error') throw new Error('masters explorer unavailable');
            return outcome.result;
        };
        const cloudEvalCp: CloudEvalCpProvider = async (fen) => {
            const outcome = await fetchCloudCpOutcome(fen);
            if (outcome.kind === 'ok') return outcome.cp;
            if (outcome.kind === 'no_eval') return null; // genuine 404 → eval-missing fallback
            throw new Error('cloud-eval unavailable');   // transient → abort the suggestion
        };

        const repertoireFens = userColor === 'white' ? fenSets.whiteFens : fenSets.blackFens;
        const sans = record.m.split(/\s+/).filter(Boolean);

        // Grouped, one-shot console trace of every masters / cloud-eval request
        // and the move-scoring values behind this suggestion (mirrors the
        // Re-annotate debug log). The group is owned here so it always closes.
        console.groupCollapsed(`[suggest-fix] ${record.p}/${record.id} — ${userColor}`);
        try {
            const result = await computeSuggestion({
                sans,
                userColor,
                repertoireFens,
                explorerEvals,
                embeddedEvals: record.ev,
                masters,
                cloudEvalCp,
                signal,
                debug: true,
            });
            if (signal.aborted) return;
            setSuggestionByKey(prev => new Map(prev).set(key, { status: 'ready', result }));
        } catch (err) {
            if ((err as Error).name === 'AbortError' || signal.aborted) return;
            console.error('Suggest a fix failed:', err);
            setSuggestionByKey(prev => new Map(prev).set(key, { status: 'error' }));
        } finally {
            if (suggestAbortByKeyRef.current.get(key) === abort) {
                suggestAbortByKeyRef.current.delete(key);
            }
            console.groupEnd();
            // Abort the per-click controller so composeSignals removes the
            // listener it attached to the long-lived pageAbortRef signal —
            // otherwise dead listeners accumulate across successful clicks
            // (mirrors runAnalysisPass's finally).
            abort.abort();
        }
    }, [lichessToken, fenSets, explorerEvals]);

    // ─────────────────────────────────────────────────────────────────────
    // Mark reviewed
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Toggle a game's `rv` (reviewed) flag. Patches the in-memory tree
     * optimistically so the row reacts instantly (and drops out of the
     * "to review" filter), then persists. We deliberately patch `rv` in
     * place rather than swapping in the persisted blob — that would clobber
     * any `fan` the analysis pass has written optimistically but not yet
     * flushed. Rolls back the patch on a hard failure.
     */
    const handleToggleReviewed = useCallback(async (record: GameRecord) => {
        const nextReviewed = record.rv !== 1;
        const applyLocal = (reviewed: boolean) => {
            setData(d => {
                if (!d?.activity) return d;
                const target = findRecord(d.activity, record.id, record.p);
                if (!target) return d;
                if (reviewed) target.record.rv = 1;
                else delete target.record.rv;
                return { ...d };
            });
        };
        applyLocal(nextReviewed);
        try {
            await persistGameReviewed(
                dal, record.id, record.p, nextReviewed, pageAbortRef.current?.signal,
            );
        } catch (e) {
            // Abort = navigation away; 412 = the app-root <ConflictModal>
            // owns recovery. Neither is a real failure to surface here.
            if ((e as { name?: string })?.name === 'AbortError'
                || pageAbortRef.current?.signal.aborted) {
                return;
            }
            if (e instanceof DataAccessError && e.statusCode === 412) return;
            console.warn('Mark-reviewed failed:', e);
            applyLocal(!nextReviewed); // roll back
        }
    }, [dal]);

    // ─────────────────────────────────────────────────────────────────────
    // DEBUG / TEMP — "Delete from here" action (remove before merging)
    // ─────────────────────────────────────────────────────────────────────

    const handleDeleteFromHere = useCallback(async (record: GameRecord) => {
        const confirmed = window.confirm(
            `[DEBUG] Delete this game and every newer one?\n\nThis removes every record with t >= ${record.t} from the saved blob. There is no undo.`,
        );
        if (!confirmed) return;

        // Abort any in-flight analysis pass and wait for it to unwind so
        // it can't race-write `fan` against a record we're about to delete.
        passAbortRef.current?.abort();
        const inflight = passDonePromiseRef.current;
        if (inflight) {
            try { await inflight; } catch { /* swallowed by pass */ }
        }

        try {
            const fresh = await persistDeleteRecordsFromTimestamp(dal, record.t, pageAbortRef.current?.signal);
            setData(fresh);
            // Re-run the pass so anything left without `fan` (shouldn't be
            // many — eviction kept the older records intact) gets picked up.
            await runAnalysisPass();
        } catch (e) {
            // Abort = navigation away. Not a real failure.
            if ((e as { name?: string })?.name === 'AbortError'
                || pageAbortRef.current?.signal.aborted) {
                return;
            }
            // 412 = the app-root <ConflictModal> already fired and
            // owns recovery. Skip the warn for log-noise consistency
            // with the other 412 catches.
            if (e instanceof DataAccessError && e.statusCode === 412) {
                return;
            }
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
                                    onClick={() => runAnalysisPass(true)}
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

            {awaitingMastersCount > 0 && !lichessConnected && (
                <div className="lichess-warning">
                    {awaitingMastersCount} game{awaitingMastersCount === 1 ? '' : 's'} (not shown){' '}
                    {awaitingMastersCount === 1 ? 'requires' : 'require'} additional analysis using masters opening explorer.{' '}
                    <Link to="/settings">Connect to Lichess</Link> to finish analysis of{' '}
                    {awaitingMastersCount === 1 ? 'this game' : 'these games'} and to see{' '}
                    {awaitingMastersCount === 1 ? 'it' : 'them'}.
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
                <div className="games-list">
                    {filterReady && (
                        <div className="games-filter-bar" role="group" aria-label="Filter games">
                            {([
                                ['unreviewed', 'To review', filterCounts.unreviewed],
                                ['reviewed', 'Reviewed', filterCounts.reviewed],
                                ['mistakes', 'All mistakes', filterCounts.mistakes],
                                ['all', 'All games', filterCounts.total],
                            ] as [GameFilter, string, number][]).map(([value, label, count]) => (
                                <button
                                    key={value}
                                    type="button"
                                    className={`games-filter-chip${gameFilter === value ? ' games-filter-chip-active' : ''}`}
                                    aria-pressed={gameFilter === value}
                                    onClick={() => selectGameFilter(value)}
                                >
                                    {label}
                                    <span className="games-filter-chip-count">{count}</span>
                                    {value === 'all' && orderedRows.length >= MAX_TOTAL_RECORDS && (
                                        <span
                                            className="games-filter-chip-info"
                                            role="img"
                                            aria-label={`Only your most recent ${MAX_TOTAL_RECORDS} games are kept. Older games are dropped as you play new ones.`}
                                            title={`Only your most recent ${MAX_TOTAL_RECORDS} games are kept. Older games are dropped as you play new ones.`}
                                        >
                                            ⓘ
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                    {filterReady && visibleRows.length === 0 && (
                        <div className="games-empty">
                            <p>{filterEmptyMessage(gameFilter, filterCounts)}</p>
                        </div>
                    )}
                    {visibleRows.map(({ record, userLower, pending }) => {
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
                                reviewed={record.rv === 1}
                                reannotating={reannotatingKeys.has(key)}
                                pending={pending}
                                analyzeProgress={analyzingRecordKey === key ? analyzeProgress : null}
                                analyzeDisabled={analyzingRecordKey !== null}
                                onReannotate={handleReannotate}
                                onAnalyzeOpponent={handleAnalyzeOpponent}
                                onToggleReviewed={handleToggleReviewed}
                                onDeleteFromHere={handleDeleteFromHere}
                                suggestion={suggestionByKey.get(key) ?? null}
                                onSuggestFix={handleSuggestFix}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default GamesPage;
