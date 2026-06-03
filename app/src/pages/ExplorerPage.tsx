import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import ChessboardControl from '../components/ChessboardControl';
import { IDataAccessLayer, createDataAccessLayer } from '../data/DataAccessLayer';
import { RepertoireData } from '../models/RepertoireData';
import {
    ExplorerService,
    Orientation,
    Path,
    Continuation,
    formatPlyLabels,
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
    label: string;
    targetFen: string;
    onJump: (fen: string) => void;
    className?: string;
}

const ClickablePly: React.FC<ClickablePlyProps> = ({ label, targetFen, onJump, className }) => (
    <button
        type="button"
        className={`explorer-ply ${className ?? ''}`}
        onClick={() => onJump(targetFen)}
    >
        {label}
    </button>
);

/**
 * Renders the canonical-form PGN of a path with each ply clickable. Plies
 * land on the position AFTER they are played.
 */
const PathLine: React.FC<{
    path: Path;
    onJump: (fen: string) => void;
}> = ({ path, onJump }) => {
    if (path.length === 0) return <span className="explorer-empty-path">(starting position)</span>;
    const labels = formatPlyLabels(
        path.map((_, i) => i + 1),
        path.map(e => e.san),
    );
    return (
        <span className="explorer-path-line">
            {path.map((edge, i) => (
                <ClickablePly
                    key={i}
                    label={labels[i]}
                    targetFen={edge.to}
                    onJump={onJump}
                />
            ))}
        </span>
    );
};

/** Render the canonical continuation underneath a move row. */
const ContinuationLine: React.FC<{
    continuation: Continuation;
    onJump: (fen: string) => void;
}> = ({ continuation, onJump }) => {
    const { plies, tail } = continuation;
    const elements: React.ReactNode[] = [];

    const labels = formatPlyLabels(
        plies.map(p => p.plyDepth),
        plies.map(p => p.san),
    );

    for (let i = 0; i < plies.length; i++) {
        const p = plies[i];
        elements.push(
            <ClickablePly
                key={`ply-${i}`}
                label={labels[i]}
                targetFen={p.toFen}
                onJump={onJump}
            />
        );
    }

    if (tail.kind === 'branch') {
        elements.push(
            <span key="alt-open" className="explorer-alt-paren">{' ('}</span>
        );
        tail.alternatives.forEach((san, idx) => {
            // Each alternative is a child edge of `tail.afterFen`. We need the
            // afterFen to know "the position AFTER this alternative is played"
            // for navigation. Compute it from afterFen + san.
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
                    label={san}
                    targetFen={childFen}
                    onJump={onJump}
                />
            );
        });
        elements.push(
            <span key="alt-close" className="explorer-alt-paren">{')'}</span>
        );
    } else if (tail.kind === 'end') {
        elements.push(
            <span key="end" className="explorer-end-marker"> (end of line)</span>
        );
    } else if (tail.kind === 'open') {
        // The continuation was truncated by the defensive depth cap. Tell the
        // user the line continues so they don't mistake it for an end-of-line.
        elements.push(
            <span key="open" className="explorer-end-marker"> …</span>
        );
    }

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

    const rowMoveNumber = moveNumberOf(currentDepth + 1);
    const isWhitePly = (currentDepth + 1) % 2 === 1;
    const rowMoveLabel = isWhitePly
        ? `${rowMoveNumber}.${edge.san}`
        : `${rowMoveNumber}\u2026${edge.san}`;

    return (
        <div className={`explorer-move-row ${isUserMove ? '' : 'opponent'}`}>
            <div className="explorer-move-row-head">
                <button
                    type="button"
                    className={`explorer-move-san ${card ? `state-${card.status.toLowerCase()}` : ''}`}
                    onClick={() => onJump(edge.to)}
                    title={`Jump to position after ${edge.san}`}
                >
                    {rowMoveLabel}
                </button>
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
            </div>
            <div className="explorer-move-row-cont">
                <ContinuationLine continuation={continuation} onJump={onJump} />
            </div>
        </div>
    );
};

// ── Main page ─────────────────────────────────────────────────────────

const ExplorerPage: React.FC = () => {
    const navigate = useNavigate();
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

    // Cross-tab freshness: re-fetch when the page regains visibility.
    useEffect(() => {
        const onVis = () => {
            if (document.visibilityState === 'visible') void fetchAll(false);
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, [fetchAll]);

    const service = useMemo(() => {
        if (!data || !openings) return null;
        return new ExplorerService(data, openings);
    }, [data, openings]);

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
                </div>

                <div className="explorer-body">
                    <div
                        className="explorer-board-col"
                        /*
                         * Make the board fully read-only: vendored chess-control
                         * still handles right-click annotation drawing even when
                         * `interactive={false}`. Capture and cancel pointer
                         * events from the right mouse button before they reach
                         * the board so users cannot draw ephemeral arrows on
                         * the Explorer (per EXPLORER.md "Arrows are read-only
                         * in v1").
                         */
                        onPointerDownCapture={(e) => {
                            if (e.button === 2) {
                                e.preventDefault();
                                e.stopPropagation();
                            }
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        <ChessboardControl
                            roundId={`explorer-${resolvedOrientation}-${currentFen}`}
                            fen={currentFen}
                            orientation={resolvedOrientation}
                            movePlayed={() => false}
                            annotations={annotations}
                            interactive={false}
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
                                <div className="explorer-empty-path">
                                    (starting position
                                    {repertoireEmpty
                                        ? ` — no lines in your ${resolvedOrientation} repertoire yet`
                                        : ''}
                                    )
                                </div>
                            ) : summary.shown.length === 0 ? (
                                <div className="explorer-empty-path">(not reachable)</div>
                            ) : (
                                <ul className="explorer-paths">
                                    {summary.shown.map((p, i) => (
                                        <li key={i}>
                                            <PathLine path={p} onJump={fen => jumpTo(fen, undefined, true)} />
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
                                <div className="explorer-moves-empty">{emptyMessage}</div>
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
                                            />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ExplorerPage;
