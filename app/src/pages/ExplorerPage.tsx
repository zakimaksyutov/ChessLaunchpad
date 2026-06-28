import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import ChessboardControl from '../components/ChessboardControl';
import ReviewView from '../components/ReviewView';
import { DataAccessError } from '../data/DataAccessLayer';
import { getSessionStore } from '../data/SessionStore';
import { RepertoireData } from '../models/RepertoireData';
import { findRecord } from '../services/GameRecordStore';
import { takeBootstrapHandoff } from '../services/BootstrapHandoff';
import { BootstrapSelection } from '../services/RepertoireBootstrapService';
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
import { isExplorerHash, isExplorerRoute } from '../utils/Routes';
import { formatDueRelative, formatLastReviewed } from '../utils/ExplorerRelativeTime';
import { mergePathsAsVariations, mergedPathsToPgn } from '../utils/MergedPathsRender';
import { buildLichessAnalysisUrl } from '../utils/LichessUrl';
import {
    encodeRepertoirePgn,
    decodeRepertoirePgn,
    RepertoirePgnError,
} from '../utils/RepertoirePgn';
import { findRepertoire } from '../models/Repertoires';
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

/** Move number derived from ply depth (1-based). */
function moveNumberOf(depth: number): number {
    return Math.ceil(depth / 2);
}

/**
 * True iff the ply at `plyDepth` (1-based) is played by the studying side.
 * Odd plies are white moves; even plies are black moves.
 */
function isUserPlyForDepth(plyDepth: number, orientation: Orientation): boolean {
    const isWhitePly = plyDepth % 2 === 1;
    return isWhitePly === (orientation === 'white');
}

// ── Subcomponents ────────────────────────────────────────────────────

interface ClickablePlyProps {
    /** Non-clickable prefix (e.g. "1.", "3…"). Empty string renders nothing. */
    prefix?: string;
    /** Clickable SAN (e.g. "e4", "Nbd7"). */
    san: string;
    targetFen: string;
    onJump: (fen: string) => void;
    /**
     * Hover/focus preview callback. Called with `targetFen` when the pointer
     * enters or focus arrives on the SAN button, and with `null` when it
     * leaves/blurs. The page uses this to drive the board into a "preview"
     * state showing the hovered position without actually navigating.
     */
    onHover?: (fen: string | null) => void;
    className?: string;
    /**
     * When defined, marks this ply as belonging to the studying side
     * (true) or the opponent (false). Adds `.explorer-ply-token--user`
     * (or `--opponent`) on the wrapper so CSS can render the side cue
     * (currently: a soft tinted pill behind the user's plies covering
     * the move-number prefix and the SAN as one unit). Leave undefined
     * to render with no side-specific styling.
     */
    isUserPly?: boolean;
}

const ClickablePly: React.FC<ClickablePlyProps> = ({ prefix, san, targetFen, onJump, onHover, className, isUserPly }) => {
    const tokenSideClass = isUserPly === undefined
        ? ''
        : isUserPly ? 'explorer-ply-token--user' : 'explorer-ply-token--opponent';
    return (
        <span className={`explorer-ply-token ${tokenSideClass}`}>
            {prefix ? <span className="explorer-ply-prefix">{prefix}</span> : null}
            <button
                type="button"
                className={`explorer-ply ${className ?? ''}`}
                onClick={() => onJump(targetFen)}
                onMouseEnter={onHover ? () => onHover(targetFen) : undefined}
                onMouseLeave={onHover ? () => onHover(null) : undefined}
                onFocus={onHover ? () => onHover(targetFen) : undefined}
                onBlur={onHover ? () => onHover(null) : undefined}
            >
                {san}
            </button>
        </span>
    );
};

/**
 * Home · Back · Forward toolbar that leads the "How you got here" line.
 * Home jumps to the start position; Back/Forward step through the Explorer's
 * own in-page position history (see the history stack in `ExplorerPage`).
 * Each button disables at the relevant end of the stack. `onHoverHome`
 * previews the root position on the board, mirroring the old start pill.
 */
const HistoryNav: React.FC<{
    rootFen: string;
    canHome: boolean;
    canBack: boolean;
    canForward: boolean;
    onHome: () => void;
    onBack: () => void;
    onForward: () => void;
    onHoverHome?: (fen: string | null) => void;
}> = ({ rootFen, canHome, canBack, canForward, onHome, onBack, onForward, onHoverHome }) => {
    const homeHover = onHoverHome && canHome
        ? {
            onMouseEnter: () => onHoverHome(rootFen),
            onMouseLeave: () => onHoverHome(null),
            onFocus: () => onHoverHome(rootFen),
            onBlur: () => onHoverHome(null),
        }
        : {};
    // Use `aria-disabled` rather than the native `disabled` attribute: a
    // button can disable itself as a direct result of being activated (e.g.
    // Home → land on root → Home greys out), and native `disabled` would drop
    // keyboard focus to <body>. Keeping the button focusable preserves the
    // user's place in the toolbar; the onClick guards no-op when inactive.
    return (
        <div className="explorer-history-nav" role="group" aria-label="Position history">
            <button
                type="button"
                className="explorer-history-btn explorer-history-home"
                onClick={() => { if (canHome) onHome(); }}
                aria-disabled={!canHome}
                aria-label="Go to starting position"
                title="Go to starting position"
                {...homeHover}
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 10.2 12 3l9 7.2" />
                    <path d="M5 9v11h5v-6h4v6h5V9" />
                </svg>
            </button>
            <button
                type="button"
                className="explorer-history-btn explorer-history-back"
                onClick={() => { if (canBack) onBack(); }}
                aria-disabled={!canBack}
                aria-label="Back to previous position"
                title="Back to previous position"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 5l-7 7 7 7" />
                </svg>
            </button>
            <button
                type="button"
                className="explorer-history-btn explorer-history-forward"
                onClick={() => { if (canForward) onForward(); }}
                aria-disabled={!canForward}
                aria-label="Forward to next position"
                title="Forward to next position"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 5l7 7-7 7" />
                </svg>
            </button>
        </div>
    );
};

/**
 * Renders one or more "How you got here" paths as a single PGN-with-variations
 * line. The shortest/canonical path (`shown[0]`) is the main line; subsequent
 * paths contribute parenthesized variations branching off the main line at
 * their divergence point and stopping at the first position they share with
 * the main line again (rejoin). Every ply — main or variation — remains
 * clickable.
 */
const MergedPathsLine: React.FC<{
    shown: Path[];
    rootFen: string;
    orientation: Orientation;
    onJump: (fen: string) => void;
    onHover?: (fen: string | null) => void;
    /** Optional element rendered as the last item of the line (e.g. an action icon). */
    trailing?: React.ReactNode;
}> = ({ shown, rootFen, orientation, onJump, onHover, trailing }) => {
    if (shown.length === 0) return null;
    if (shown[0].length === 0) return null;
    const tokens = mergePathsAsVariations(shown, rootFen);

    // Walk the flat token stream, grouping each (open-var … close-var) into a
    // single `.explorer-path-variation` span. This lets the parens hug their
    // contents without being pushed apart by the parent flex gap.
    type Frame = { isMain: boolean; nodes: React.ReactNode[] };
    const stack: Frame[] = [{ isMain: true, nodes: [] }];
    let key = 0;

    const renderPly = (
        prefix: string,
        edge: GraphEdge,
        isMain: boolean,
        plyDepth: number,
        k: number,
    ): React.ReactNode => (
        <ClickablePly
            key={k}
            prefix={prefix}
            san={edge.san}
            targetFen={edge.to}
            onJump={onJump}
            onHover={onHover}
            className={isMain ? '' : 'explorer-ply-variation'}
            isUserPly={isUserPlyForDepth(plyDepth, orientation)}
        />
    );

    for (const t of tokens) {
        if (t.kind === 'open-var') {
            stack.push({ isMain: false, nodes: [] });
        } else if (t.kind === 'close-var') {
            const frame = stack.pop();
            if (!frame) continue;
            const parent = stack[stack.length - 1];
            parent.nodes.push(
                <span key={key++} className="explorer-path-variation">
                    <span className="explorer-path-paren">(</span>
                    {frame.nodes}
                    <span className="explorer-path-paren">)</span>
                </span>,
            );
        } else {
            const top = stack[stack.length - 1];
            top.nodes.push(renderPly(t.prefix, t.edge, t.isMain, t.plyDepth, key++));
        }
    }

    return (
        <span className="explorer-path-line">
            {stack[0].nodes}
            {trailing}
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
    orientation: Orientation;
    onJump: (fen: string) => void;
    onHover?: (fen: string | null) => void;
}> = ({ continuation, orientation, onJump, onHover }) => {
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
                onHover={onHover}
                isUserPly={isUserPlyForDepth(p.plyDepth, orientation)}
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
        const altIsUser = isUserPlyForDepth(altDepth, orientation);

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
                    onHover={onHover}
                    isUserPly={altIsUser}
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
    onHover?: (fen: string | null) => void;
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
    onHover,
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
                        onMouseEnter={onHover ? () => onHover(edge.to) : undefined}
                        onMouseLeave={onHover ? () => onHover(null) : undefined}
                        onFocus={onHover ? () => onHover(edge.to) : undefined}
                        onBlur={onHover ? () => onHover(null) : undefined}
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
                <ContinuationLine continuation={continuation} orientation={orientation} onJump={onJump} onHover={onHover} />
            </div>
        </div>
    );
};

// ── Overflow menu (Export PGN) ────────────────────────────────────────

interface ExplorerOverflowMenuProps {
    open: boolean;
    onToggle: () => void;
    onExport: () => void;
    /** When true, Export PGN is rendered disabled (Edit-mode behaviour). */
    exportDisabled: boolean;
    /** Required when `exportDisabled` is true — surfaced as the menu item's
     *  hint text and `title`. Read-mode call sites pass `exportDisabled=false`
     *  and may omit this. */
    exportDisabledReason?: string;
    /** Disables the menu item while a PGN import is in flight. */
    busy: boolean;
    /** "White" / "Black" — labels the menu item so users always know which
     *  repertoire they're acting on. */
    colorLabel: 'White' | 'Black';
    /** Ref the parent populates with the trigger button so it can restore
     *  focus after an Esc-driven close. */
    triggerRefCallback: (el: HTMLButtonElement | null) => void;
    /** When provided, renders a "FSRS cards" item that opens the `/fsrs`
     *  diagnostic page. Omitted in Edit mode so navigation can't drop
     *  pending repertoire edits. */
    onOpenFsrs?: () => void;
}

/**
 * `⋯` overflow button + popover menu. Currently exposes a single
 * Export PGN item; PGN import lives in the Edit-mode paste section
 * (see render below).
 *
 * Keyboard: parent registers Esc-to-close and restores focus to the
 * trigger on dismissal (see `menuOpen` effect). On open we move focus
 * into the first non-disabled item so keyboard/screen-reader users can
 * operate the menu without an extra Tab.
 */
const ExplorerOverflowMenu: React.FC<ExplorerOverflowMenuProps> = ({
    open, onToggle, onExport, exportDisabled, exportDisabledReason, busy,
    colorLabel, triggerRefCallback, onOpenFsrs,
}) => {
    const menuRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!open) return;
        const first = menuRef.current?.querySelector<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
        );
        first?.focus();
    }, [open]);

    return (
        <div className="explorer-menu-wrap">
            <button
                type="button"
                ref={triggerRefCallback}
                className="explorer-menu-trigger explorer-btn explorer-btn--sm explorer-btn--neutral-ghost"
                onClick={onToggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="More repertoire actions"
                title="More repertoire actions"
            >
                ⋯
            </button>
            {open && (
                <div className="explorer-menu" role="menu" ref={menuRef}>
                    <button
                        type="button"
                        role="menuitem"
                        className="explorer-menu-item"
                        onClick={onExport}
                        disabled={exportDisabled || busy}
                        title={exportDisabled ? exportDisabledReason : undefined}
                    >
                        <span className="explorer-menu-item-label">
                            Export <strong>{colorLabel}</strong> PGN
                        </span>
                        {exportDisabled && exportDisabledReason && (
                            <span className="explorer-menu-item-hint">
                                {exportDisabledReason}
                            </span>
                        )}
                    </button>
                    {onOpenFsrs && (
                        <button
                            type="button"
                            role="menuitem"
                            className="explorer-menu-item"
                            onClick={onOpenFsrs}
                        >
                            <span className="explorer-menu-item-label">
                                FSRS cards
                            </span>
                            <span className="explorer-menu-item-hint">
                                Diagnostic list of every scheduled card
                            </span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

// ── Main page ─────────────────────────────────────────────────────────

const ExplorerPage: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();

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
    // The Cancel/Back rule in EXPLORER.md is "return to Edit with the
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
    const [discardPrompt, setDiscardPrompt] = useState(false);

    // ── PGN export/import ───────────────────────────────────────────
    // Export lives in the `⋯` menu (disabled in Edit mode to force
    // Save/Discard first). Import is Edit-only and lives in the paste
    // section below the board.
    const [menuOpen, setMenuOpen] = useState(false);
    const importFileInputRef = useRef<HTMLInputElement>(null);
    const [pasteText, setPasteText] = useState('');
    const [importBusy, setImportBusy] = useState(false);
    const [pgnToast, setPgnToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

    // ── Read-mode "switch to edit?" prompt ──────────────────────────
    // Raised when, in Read mode, the user plays a move that isn't in the
    // repertoire or attempts to draw an annotation (both are edits). The
    // toast offers a one-click jump into Edit mode at the current
    // position; the user re-plays the move/annotation there. No edit is
    // auto-applied — Read mode never mutates the repertoire.
    const [editPromptToast, setEditPromptToast] = useState<{ kind: 'move' | 'annotation' } | null>(null);

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

    const dal = useMemo(() => getSessionStore().createDataAccessProxyLayer(), []);

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
    // The orientation that `currentFen` was resolved under. `resolvedOrientation`
    // is derived synchronously from the URL, but `currentFen` is written one
    // render later by the settle effect below — so for navigations that change
    // BOTH fen and orientation there is an intermediate render where the two
    // disagree. This state is set together with `currentFen`, giving the history
    // stack a single atomic (fen, orientation) source of truth.
    const [resolvedFenOrientation, setResolvedFenOrientation] = useState<Orientation | null>(null);

    // Hover preview: which FEN to render on the board instead of `currentFen`.
    // Set when the pointer is over (or focus is on) any clickable ply on the
    // page; cleared on leave/blur with a tiny debounce so moving the pointer
    // from one ply directly to the next doesn't flash through `currentFen`
    // between mouseleave→mouseenter pairs. `null` means "no preview — show
    // the navigation position".
    const [previewFen, setPreviewFen] = useState<string | null>(null);
    const previewClearTimerRef = useRef<number | null>(null);
    // Suppress hover events for a short window after every navigation. When
    // currentFen changes, the move-list re-renders and a different ply button
    // can land under the (stationary) cursor — browsers fire a synthetic
    // mouseenter on that new button, which would otherwise pollute the
    // preview state with a ply the user never intentionally pointed at.
    // 150 ms is well under the threshold for a real human pointer flick
    // between two move buttons after a click, so this is invisible to users.
    const recentNavAtRef = useRef<number>(0);
    const HOVER_SUPPRESSION_MS = 150;
    const handleHover = useCallback((fen: string | null) => {
        if (Date.now() - recentNavAtRef.current < HOVER_SUPPRESSION_MS) return;
        if (previewClearTimerRef.current !== null) {
            window.clearTimeout(previewClearTimerRef.current);
            previewClearTimerRef.current = null;
        }
        if (fen === null) {
            previewClearTimerRef.current = window.setTimeout(() => {
                setPreviewFen(null);
                previewClearTimerRef.current = null;
            }, 500);
        } else {
            setPreviewFen(fen);
        }
    }, []);
    // Drop any pending preview when the underlying navigation position
    // changes (click-to-jump, URL change, etc.) so the board doesn't keep
    // showing a stale hover after the user has moved on. Also stamp the
    // suppression window so post-navigation synthetic mouseenters don't
    // bring it back (see `handleHover`).
    useEffect(() => {
        recentNavAtRef.current = Date.now();
        if (previewClearTimerRef.current !== null) {
            window.clearTimeout(previewClearTimerRef.current);
            previewClearTimerRef.current = null;
        }
        setPreviewFen(null);
    }, [currentFen]);
    useEffect(() => {
        return () => {
            if (previewClearTimerRef.current !== null) {
                window.clearTimeout(previewClearTimerRef.current);
                previewClearTimerRef.current = null;
            }
        };
    }, []);

    // When data + URL settle, resolve the FEN (snap to root if necessary).
    useEffect(() => {
        if (!service) return;

        const root = service.getRootFen();
        const desiredFen = fenParam ? fenParam : root;

        if (service.isInRepertoire(desiredFen, resolvedOrientation)) {
            setCurrentFen(desiredFen);
            setResolvedFenOrientation(resolvedOrientation);
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
        setResolvedFenOrientation(resolvedOrientation);
        setSnapToast(`That position isn't in your current ${resolvedOrientation} repertoire — opened the starting position instead.`);
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

    // ── "Add to repertoire" deep-link (?addpgn=…) ────────────────────
    // The /games "Suggest a fix" action links here with the suggested line as a
    // movetext PGN. We stage it into a PendingEditModel (reusing the same decode
    // + apply path as the Edit-mode PGN import) and drop the user on Review &
    // Save so they can commit (or discard) the proposed line. Handled once per
    // distinct PGN value.
    const addPgnHandledRef = useRef<string | null>(null);
    // When the addpgn deep-link came from /games (the "Add to repertoire"
    // suggestion action), remember the originating row so Save/Discard can
    // send the user back to /games instead of stranding them on Explorer.
    // `parentFen`/`parentOrientation` capture the position just above the
    // first added move so "Continue editing" (Back from Review) can drop the
    // user onto the Explorer Edit board there instead of bouncing to /games.
    const suggestReturnRef = useRef<{
        row: string | null;
        parentFen: string | null;
        parentOrientation: Orientation | null;
    } | null>(null);
    useEffect(() => {
        if (!data) return;
        const addPgn = searchParams.get('addpgn');
        if (!addPgn) return;
        if (addPgnHandledRef.current === addPgn) return;
        addPgnHandledRef.current = addPgn;

        const orientation: Orientation =
            explicitOrientationParam === 'white' || explicitOrientationParam === 'black'
                ? explicitOrientationParam
                : resolvedOrientation;

        const next = new URLSearchParams(searchParams);
        next.delete('addpgn');
        next.delete('fen');
        next.delete('from');
        next.delete('row');

        try {
            const decoded = decodeRepertoirePgn(addPgn, { defaultOrientation: orientation });
            // Mirror the paste-import guard: never silently merge a line of one
            // color into in-progress edits of the other. (Unreachable via the
            // /games link, which always sets `o` to match — guards a hand-crafted
            // URL hit while already editing the opposite color on /explorer.)
            if (pendingModel && decoded.orientation !== orientation) {
                setPgnToast({
                    kind: 'error',
                    text: `That line is a ${decoded.orientation === 'white' ? 'White' : 'Black'} line, but you're editing ${orientation === 'white' ? 'White' : 'Black'}. Save or Discard your pending edits first.`,
                });
                setSearchParams(next, { replace: true });
                return;
            }
            const reps = data.repertoires ?? [];
            const cards = data.fsrsCards ?? extractFsrsCardsFromRepertoires(reps);
            const model = pendingModel ?? new PendingEditModel(reps, cards);
            const result = model.applyImportedPgn(
                decoded.orientation,
                decoded.edges,
                decoded.annotationsByFen,
            );
            setPendingModel(model);
            setMode('edit');
            bumpPending();
            setPgnToast({
                kind: 'success',
                text: result.addedEdges > 0
                    ? `Staged ${result.addedEdges} new move${result.addedEdges === 1 ? '' : 's'} from the suggested line — Review & Save to add ${result.addedEdges === 1 ? 'it' : 'them'}.`
                    : 'The suggested line is already in your repertoire.',
            });
            if (searchParams.get('from') === 'games') {
                // Capture the parent of the first staged (added) position so
                // "Continue editing" can land the board there. computeDelta()
                // is the same call the Review pane makes; paying it once here
                // keeps the parent lookup in lock-step with what's reviewed.
                const firstChain = model.computeDelta().addedChains[0];
                suggestReturnRef.current = {
                    row: searchParams.get('row'),
                    parentFen: firstChain?.head.from ?? null,
                    parentOrientation: firstChain?.orientation ?? null,
                };
            }
            next.set('o', decoded.orientation);
            next.set('review', '1');
        } catch {
            setPgnToast({ kind: 'error', text: 'Could not load the suggested line.' });
        }

        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, searchParams, resolvedOrientation, explicitOrientationParam]);

    // ── Repertoire-bootstrap handoff ─────────────────────────────────
    // The /bootstrap page stages its proposed starter lines into an in-memory
    // handoff (no URL payload — the selection spans both colors and many lines,
    // so it fits neither a URL nor the single-orientation `?addpgn=` contract)
    // and navigates here with `?o=<side>`. Adopt the selection into a fresh
    // PendingEditModel built from *our* loaded blob — so Save keeps Explorer's
    // own retrieve/etag concurrency — enter Edit mode, and open Review & Save by
    // *pushing* `?review=1` (mirroring enterReviewView) so the staged main Edit
    // view sits beneath in history. From there Save/Discard, "Open in Explorer",
    // and Back-to-edit (window.history.back lands on the staged Edit view, not
    // /bootstrap — so the user can tweak before accepting) all work through the
    // existing Explorer flow. Consumed once; the handoff clears itself on read.
    //
    // The take is decoupled from the `data` gate: we drain the singleton on this
    // Explorer's first effect run (held in a ref) regardless of whether `data`
    // has loaded, then apply once it has. Otherwise a failed/aborted data load
    // would leave the staged selection lingering in the module singleton for a
    // later, unrelated /explorer visit to silently adopt. If data never loads,
    // the ref is discarded on unmount and the singleton is already empty.
    const bootstrapHandledRef = useRef(false);
    const stagedBootstrapRef = useRef<BootstrapSelection | null | undefined>(undefined);
    useEffect(() => {
        if (stagedBootstrapRef.current === undefined) {
            stagedBootstrapRef.current = takeBootstrapHandoff();
        }
        const selection = stagedBootstrapRef.current;
        if (!selection || !data || bootstrapHandledRef.current) return;
        bootstrapHandledRef.current = true;

        const reps = data.repertoires ?? [];
        const cards = data.fsrsCards ?? extractFsrsCardsFromRepertoires(reps);
        const model = new PendingEditModel(reps, cards);
        // Edges arrive in BFS, parent-first order, so applying them in sequence
        // never references a not-yet-created parent.
        for (const orientation of ['white', 'black'] as Orientation[]) {
            for (const edge of selection[orientation]) {
                model.addEdge(edge.from, edge.san, edge.orientation);
            }
        }
        setPendingModel(model);
        setMode('edit');
        bumpPending();

        if (searchParams.get('review') !== '1') {
            const next = new URLSearchParams(searchParams);
            next.set('review', '1');
            setSearchParams(next); // push, so Back from Review returns to the staged Edit view
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    const jumpTo = useCallback((fen: string, orientation?: Orientation, push = true) => {
        const next = new URLSearchParams(searchParams);
        const targetOrientation = orientation ?? resolvedOrientation;
        next.set('o', targetOrientation);
        if (fen) next.set('fen', fen); else next.delete('fen');
        setSearchParams(next, { replace: !push });
        setFindInput('');
        setFindError(null);
    }, [searchParams, setSearchParams, resolvedOrientation]);

    // ── In-page navigation history ───────────────────────────────────
    // A self-contained stack of positions viewed inside `/explorer` that
    // drives the Home/Back/Forward toolbar in "How you got here". It is a
    // separate index over visited positions — navigation still updates the
    // URL (and thus browser history) like every other jump. Each settled
    // position change appends an entry (truncating any forward entries
    // first). Back/Forward move `index` then re-navigate; when the new
    // position settles it equals `entries[index]`, so the push effect skips
    // re-recording it. `historyRef` is the authoritative store read by the
    // handlers (immune to stale closures); `history` state mirrors it for
    // rendering the button states. Component-local, so it resets on reload
    // or when leaving the page.
    type HistoryEntry = { fen: string; orientation: Orientation };
    type HistoryStack = { entries: HistoryEntry[]; index: number };
    const historyRef = useRef<HistoryStack>({ entries: [], index: -1 });
    const [history, setHistory] = useState<HistoryStack>(historyRef.current);
    const commitHistory = useCallback((next: HistoryStack) => {
        historyRef.current = next;
        setHistory(next);
    }, []);

    useEffect(() => {
        if (!currentFen || !resolvedFenOrientation) return;
        const fen = currentFen;
        const orientation = resolvedFenOrientation;
        const h = historyRef.current;
        const cur = h.entries[h.index];
        if (cur && cur.fen === fen && cur.orientation === orientation) return;
        const entries = h.entries.slice(0, h.index + 1);
        entries.push({ fen, orientation });
        commitHistory({ entries, index: entries.length - 1 });
    }, [currentFen, resolvedFenOrientation, commitHistory]);

    const canHistoryBack = history.index > 0;
    const canHistoryForward = history.index < history.entries.length - 1;

    const goHistoryBack = useCallback(() => {
        const h = historyRef.current;
        if (h.index <= 0) return;
        const target = h.entries[h.index - 1];
        commitHistory({ ...h, index: h.index - 1 });
        jumpTo(target.fen, target.orientation, true);
    }, [commitHistory, jumpTo]);

    const goHistoryForward = useCallback(() => {
        const h = historyRef.current;
        if (h.index >= h.entries.length - 1) return;
        const target = h.entries[h.index + 1];
        commitHistory({ ...h, index: h.index + 1 });
        jumpTo(target.fen, target.orientation, true);
    }, [commitHistory, jumpTo]);

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
        // In Edit mode the orientation toggle is hidden and editing is
        // scoped to a single repertoire per session — silently switching
        // sides via Find would be confusing. Block the cross-orientation
        // fallthrough and surface the same not-found error as above.
        if (mode === 'edit' && result.orientation !== resolvedOrientation) {
            setFindError(`Not in your ${resolvedOrientation} repertoire (exit Edit to search the other side).`);
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
        if (searchParams.get('review') !== '1') return;
        const ret = suggestReturnRef.current;
        if (ret) {
            // Games "Add to repertoire" flow: the Review pane was reached via
            // a URL *replace* (see the addpgn effect), so there is no Explorer
            // main-Edit history entry beneath it — window.history.back() would
            // overshoot all the way to /games and unmount the page, silently
            // dropping the staged line. Instead stay on /explorer, leave the
            // Review pane, and land the board on the parent of the first added
            // position so the user can keep editing. Discard remains the
            // explicit path back to /games.
            const next = new URLSearchParams(searchParams);
            next.delete('review');
            if (ret.parentOrientation) next.set('o', ret.parentOrientation);
            if (ret.parentFen) next.set('fen', ret.parentFen);
            else next.delete('fen');
            setSearchParams(next, { replace: true });
            return;
        }
        // Normal in-Explorer flow: the main Edit view sits beneath in history,
        // so walk one step back and browser Back / this button stay in sync.
        // If for some reason that overshoots (rare — would mean the user
        // manually deep-linked to ?review=1), fall back to stripping the param.
        window.history.back();
    }, [searchParams, setSearchParams]);

    const enterEditMode = useCallback(() => {
        if (!data) return;
        if (!pendingModel) {
            const reps = data.repertoires ?? [];
            // Defensive: derive cards from the dict if the flat map happens
            // to be missing. Under current invariants `normalize()` always
            // populates `data.fsrsCards`, so this is a safety net rather
            // than the expected path.
            const cards = data.fsrsCards ?? extractFsrsCardsFromRepertoires(reps);
            setPendingModel(new PendingEditModel(reps, cards));
        }
        setMode('edit');
        stripReviewParam();
    }, [data, pendingModel, stripReviewParam]);

    /**
     * Cheap counts-only memo, runs on every edit. Drives the inline edit-bar
     * pill and `isDirty` (which gates the cross-page notifier and
     * `beforeunload`). Avoids the chain-decomposition + canonical-path +
     * PGN-formatting cost paid by the full `computeDelta()` — that cost
     * is only paid when the Review pane is actually open (see `delta`
     * below). Counts are guaranteed to match the rich path because both
     * share `PendingEditModel.computeImpl` internally.
     */
    const counts = useMemo(() => {
        void pendingTick;
        return pendingModel ? pendingModel.computeCounts() : null;
    }, [pendingModel, pendingTick]);

    /** True when the model holds at least one staged change. */
    const isDirty = !!counts &&
        (counts.added + counts.removed + counts.changed) > 0;

    /**
     * Rich delta with chain decomposition + per-row canonical PGN.
     * Only computed when the Review pane is actually visible — gated on
     * `view === 'review'` so editing the rep on huge repertoires never
     * pays for presentation work the user can't see.
     */
    const delta = useMemo(() => {
        void pendingTick;
        if (view !== 'review' || !pendingModel) return null;
        return pendingModel.computeDelta();
    }, [pendingModel, pendingTick, view]);

    // Reflect dirty state into the cross-page notifier so the safety-net
    // guards (SPA click guard, popstate, beforeunload) know there's
    // unsaved work that would be lost.
    useEffect(() => {
        PendingEditNotifier.setPending(isDirty);
        return () => PendingEditNotifier.setPending(false);
    }, [isDirty]);

    // Reflect edit-mode entry/exit so the Header can disable all of its
    // menu items while the user is editing. This is independent from
    // `isDirty`: once the user clicks "Edit repertoire", every header
    // entry is disabled — even before any change is staged — so the
    // only way out is Save or Discard.
    useEffect(() => {
        PendingEditNotifier.setInEditMode(mode === 'edit');
        return () => PendingEditNotifier.setInEditMode(false);
    }, [mode]);

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
    // `beforeunload`, so any in-page anchor leaving `/explorer` could
    // silently destroy the pending delta on unmount. Intercept anchor
    // clicks on the document while dirty and prompt the user — same
    // destructive-action confirm wording as the sticky-bar Discard. If
    // the user confirms, we strip dirty state and let the click proceed
    // on the second invocation.
    //
    // The Header is fully disabled while in Edit mode (see Header.tsx
    // subscribing to PendingEditNotifier.isInEditMode), so header anchor
    // clicks are blocked at the source; this guard remains as defense
    // in depth for any other in-page anchor that may exit `/explorer`.
    //
    // Companion guards:
    //   - The `popstate` listener inside PendingEditNotifier catches
    //     browser Back/Forward when the URL leaves `/explorer` mid-edit
    //     and bounces back if the user cancels.
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
            if (isExplorerRoute(targetRoute)) return; // staying inside Explorer
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
        if (isExplorerHash(window.location.hash)) {
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

    /**
     * Read-mode board move = navigation. A move that matches an existing
     * edge from the current position jumps to that position (pushing
     * history, like clicking a move row). A legal move that isn't in the
     * repertoire is rejected (the piece snaps back) and raises the
     * "switch to edit mode?" prompt — Read mode never mutates the tree.
     */
    const handleReadNavigateMove = useCallback((from: string, to: string): boolean => {
        if (mode !== 'read' || !currentFen || !service) return false;
        try {
            const chess = new Chess(currentFen);
            // (from, to) alone is ambiguous for promotions — the board can't
            // tell us which piece. chess.js lists candidates N,B,R,Q, so we
            // can't just take the first match (that would be the knight
            // underpromotion and miss a queen-promotion edge). We resolve a
            // promotion drag queen-first, matching the conventional "drag =
            // auto-queen" board semantics (chess-control has no promotion
            // dialog). If only an underpromotion edge is prepared we still
            // navigate to it; in the (practically nonexistent) case where a
            // position prepares several promotions from the same square, the
            // non-queen branches stay reachable through the move list.
            const PROMO_ORDER = ['q', 'r', 'b', 'n'];
            const candidates = chess.moves({ verbose: true })
                .filter(m => m.from === from && m.to === to)
                .sort((a, b) => PROMO_ORDER.indexOf(a.promotion ?? 'q') - PROMO_ORDER.indexOf(b.promotion ?? 'q'));
            if (candidates.length === 0) return false;
            const edges = service.getEdges(currentFen, resolvedOrientation);
            const edge = candidates
                .map(c => edges.find(e => e.san === c.san))
                .find((e): e is GraphEdge => e !== undefined);
            if (edge) {
                jumpTo(edge.to, undefined, true);
                return true;
            }
            setSnapToast(null);
            setEditPromptToast({ kind: 'move' });
            return false;
        } catch {
            return false;
        }
    }, [mode, currentFen, service, resolvedOrientation, jumpTo]);

    /** Read-mode annotation attempt — blocked, raises the edit prompt. */
    const handleReadAnnotationAttempt = useCallback(() => {
        setSnapToast(null);
        setEditPromptToast({ kind: 'annotation' });
    }, []);

    /**
     * If the current edit session was entered via the /games "Add to
     * repertoire" suggestion, navigate back to /games (carrying the row key so
     * the page can scroll to it, and an `added` flag for the success toast).
     * Returns true when it handled navigation so callers can skip their normal
     * stay-on-Explorer cleanup.
     */
    const returnToGamesAfterSuggest = useCallback((added: boolean): boolean => {
        const ret = suggestReturnRef.current;
        if (!ret) return false;
        suggestReturnRef.current = null;
        const params = new URLSearchParams();
        if (ret.row) params.set('row', ret.row);
        if (added) params.set('added', '1');
        const search = params.toString();
        navigate({ pathname: '/games', search: search ? `?${search}` : '' }, { replace: true });
        return true;
    }, [navigate]);

    /** Sticky-bar Save handler. */
    const handleSave = useCallback(async () => {
        if (!pendingModel || !data) return;
        setSaveInFlight(true);
        setSaveError(null);
        try {
            // Build the in-memory blob to save. `currentRepertoires` already
            // carries inline cards on every surviving edge (cloneRepertoires
            // deep-copies them, applyAddPosition re-attaches resurrected/new
            // cards), so `extractFsrsCardsFromRepertoires` gives us the
            // complete flat-map view. We don't merge in `data.fsrsCards`:
            // any base card whose edge was deleted in edit mode is correctly
            // dropped by `projectFsrsCardsIntoRepertoires` (which only
            // re-emits cards backed by an existing edge in `repertoires`).
            const liveCards = extractFsrsCardsFromRepertoires(pendingModel.currentRepertoires);

            // When this Save commits a /games "Add to repertoire" suggestion,
            // stamp the originating game record so /games can show a persistent
            // "Added to repertoire" confirmation (the frozen annotation keeps
            // offering "Add to repertoire" until the next Re-annotate).
            const ret = suggestReturnRef.current;
            if (ret?.row && data.activity) {
                const sep = ret.row.indexOf(':');
                if (sep > 0) {
                    const platform = ret.row.slice(0, sep) as 'l' | 'c';
                    const id = ret.row.slice(sep + 1);
                    const found = findRecord(data.activity, id, platform);
                    if (found?.record.sg) found.record.sg.ap = 1;
                }
            }

            const blobInMemory: RepertoireData = {
                repertoires: pendingModel.currentRepertoires,
                fsrsCards: liveCards,
                settings: data.settings,
                activity: data.activity,
                games: data.games,
                // Preserve the FSRS audit trail (Track/Untrack data from the
                // /fsrs page). Omitting it here would PUT a blob with no
                // `audit` array and erase every tracked card on the next
                // Explorer save. See `docs/product-specs/FSRS-LIST.md`.
                audit: data.audit,
            };
            const wire = RepertoireDataUtils.prepareDataForSave(blobInMemory);
            await dal.storeRepertoireData(wire);
            // Reload to the canonical persisted state so the in-memory model
            // and the persisted blob agree.
            dataRef.current = null;
            setPendingModel(null);
            setMode('read');
            if (returnToGamesAfterSuggest(true)) return;
            stripReviewParam();
            await fetchAll(true);
        } catch (err: unknown) {
            if (err instanceof DataAccessError && err.statusCode === 412) {
                // The app-root <ConflictModal> already fired (via
                // SessionStore.save's notifyConflict) and is showing the
                // Reload prompt. Don't duplicate the message with a
                // page-local "Save failed" — the modal owns the recovery
                // flow and will hard-reload the page on confirm.
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                setSaveError(`Save failed: ${msg}`);
            }
        } finally {
            setSaveInFlight(false);
        }
    }, [pendingModel, data, dal, fetchAll, stripReviewParam, returnToGamesAfterSuggest]);

    /** Sticky-bar Discard handler (always prompts when delta non-empty). */
    const requestDiscard = useCallback(() => {
        if (!pendingModel || pendingModel.isEmpty()) {
            // Trivial discard: nothing to confirm.
            setPendingModel(null);
            setMode('read');
            if (returnToGamesAfterSuggest(false)) return;
            stripReviewParam();
            return;
        }
        setDiscardPrompt(true);
    }, [pendingModel, stripReviewParam, returnToGamesAfterSuggest]);

    const confirmDiscard = useCallback(() => {
        setDiscardPrompt(false);
        setPendingModel(null);
        setMode('read');
        if (returnToGamesAfterSuggest(false)) return;
        stripReviewParam();
    }, [stripReviewParam, returnToGamesAfterSuggest]);

    // ── PGN export ─────────────────────────────────────────────────

    /**
     * Export the orientation-matching repertoire as a portable `.pgn` file.
     * Only invoked from Read mode — the overflow menu disables this item in
     * Edit mode so pending edits can't accidentally ship as "the repertoire".
     */
    const handleExportPgn = useCallback(() => {
        setMenuOpen(false);
        if (!data || !data.repertoires) {
            setPgnToast({ kind: 'error', text: 'Repertoire not loaded yet.' });
            return;
        }
        const rep = findRepertoire(data.repertoires, resolvedOrientation);
        if (!rep) {
            setPgnToast({ kind: 'error', text: `No ${resolvedOrientation} repertoire to export.` });
            return;
        }
        try {
            const pgn = encodeRepertoirePgn(rep);
            const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const positionCount = Object.keys(rep.positions).length;
            const colorLabel = resolvedOrientation === 'white' ? 'White' : 'Black';
            const username = localStorage.getItem('username') || 'repertoire';
            const dateStamp = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `Repertoire-${colorLabel}-${username}-${dateStamp}-${positionCount} positions.pgn`;
            a.click();
            URL.revokeObjectURL(url);
            setPgnToast({
                kind: 'success',
                text: `Exported ${positionCount} ${colorLabel.toLowerCase()} positions as PGN.`,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setPgnToast({ kind: 'error', text: `Export failed: ${msg}` });
        }
    }, [data, resolvedOrientation]);

    // ── PGN import (shared by file picker + paste box) ──────────────

    /**
     * Stage a parsed PGN into the pending edit delta. Only invoked from the
     * Edit-mode UI, which only renders when `pendingModel` is non-null —
     * hence the `!` assertion below rather than a user-visible guard.
     */
    const applyParsedPgn = useCallback((pgnText: string): string => {
        // Paste-box snippets may omit the `[Repertoire]` header; default
        // to the orientation being edited.
        const decoded = decodeRepertoirePgn(pgnText, {
            defaultOrientation: resolvedOrientation,
        });

        if (decoded.orientation !== resolvedOrientation) {
            throw new RepertoirePgnError(
                `This file is a ${decoded.orientation === 'white' ? 'White' : 'Black'} ` +
                `repertoire, but you're editing ${resolvedOrientation === 'white' ? 'White' : 'Black'}. ` +
                `Save or Discard your pending edits first, then re-import.`,
            );
        }
        const result = pendingModel!.applyImportedPgn(
            decoded.orientation,
            decoded.edges,
            decoded.annotationsByFen,
        );
        bumpPending();
        const colorLabel = decoded.orientation === 'white' ? 'White' : 'Black';
        return `Staged into your ${colorLabel} edits: ${result.addedEdges} move${
            result.addedEdges === 1 ? '' : 's'
        }${
            result.replacedAnnotations > 0
                ? `, ${result.replacedAnnotations} annotation${result.replacedAnnotations === 1 ? '' : 's'}`
                : ''
        }. Use Review & Save to commit.`;
    }, [pendingModel, resolvedOrientation, bumpPending]);

    const handleImportFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const file = files[0];
        // Reset input so selecting the same file again re-fires onChange.
        e.target.value = '';
        setImportBusy(true);
        setPgnToast(null);
        try {
            const text = await file.text();
            const msg = applyParsedPgn(text);
            setPgnToast({ kind: 'success', text: msg });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setPgnToast({ kind: 'error', text: `Import failed: ${msg}` });
        } finally {
            setImportBusy(false);
        }
    }, [applyParsedPgn]);

    const handlePasteImport = useCallback(() => {
        if (!pasteText.trim()) {
            setPgnToast({ kind: 'error', text: 'Paste a PGN first.' });
            return;
        }
        setImportBusy(true);
        setPgnToast(null);
        try {
            const msg = applyParsedPgn(pasteText);
            setPgnToast({ kind: 'success', text: msg });
            setPasteText('');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setPgnToast({ kind: 'error', text: `Import failed: ${msg}` });
        } finally {
            setImportBusy(false);
        }
    }, [pasteText, applyParsedPgn]);

    // Auto-dismiss the PGN toast after a few seconds (success only —
    // errors stay until the user dismisses them).
    useEffect(() => {
        if (!pgnToast || pgnToast.kind !== 'success') return;
        const id = window.setTimeout(() => setPgnToast(null), 4500);
        return () => window.clearTimeout(id);
    }, [pgnToast]);

    // Auto-dismiss the read-mode "switch to edit?" prompt.
    useEffect(() => {
        if (!editPromptToast) return;
        const id = window.setTimeout(() => setEditPromptToast(null), 6000);
        return () => window.clearTimeout(id);
    }, [editPromptToast]);

    // Leaving Read mode (or starting an edit session) makes the prompt moot.
    useEffect(() => {
        if (mode !== 'read') setEditPromptToast(null);
    }, [mode]);

    // Close the menu when clicking outside, on Escape, or any keyboard
    // dismissal — the `role="menu"` we expose requires at least an Esc
    // handler for keyboard / screen-reader users.
    const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        if (!menuOpen) return;
        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (target.closest('.explorer-menu')) return;
            if (target.closest('.explorer-menu-trigger')) return;
            setMenuOpen(false);
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setMenuOpen(false);
                // Restore focus to the trigger so the keyboard user lands
                // back where they invoked the menu.
                menuTriggerRef.current?.focus();
            }
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [menuOpen]);

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
    // PGN-with-variations of the visualized "How you got here" line, handed to
    // Lichess's analysis board (which hosts the opening explorer). Empty when
    // there is no path to show (root returns a single empty path, unreachable
    // returns none), in which case we hide the link.
    const lichessPgn = mergedPathsToPgn(summary.shown, service.getRootFen());
    const lichessHref = lichessPgn
        ? buildLichessAnalysisUrl(lichessPgn, resolvedOrientation)
        : null;
    const edges = service.getEdges(currentFen, resolvedOrientation);
    // Board rendering: when the user is hovering a ply, show that position
    // instead of the navigation position. Annotations follow the displayed
    // FEN so the user sees what's actually drawn there. `roundId` stays
    // anchored to `currentFen` so chess-control treats hover swaps as
    // in-round `fen` changes (which animate via detectMove) rather than
    // round resets.
    const isPreviewing = previewFen !== null && previewFen !== currentFen;
    const boardFen = isPreviewing ? previewFen! : currentFen;
    const annotations = service.getAnnotations(boardFen, resolvedOrientation);
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

                {pgnToast && (
                    <div
                        className={`explorer-toast explorer-toast--${pgnToast.kind}`}
                        role={pgnToast.kind === 'error' ? 'alert' : 'status'}
                    >
                        <span>{pgnToast.text}</span>
                        <button
                            type="button"
                            className="explorer-toast-dismiss"
                            aria-label="Dismiss"
                            onClick={() => setPgnToast(null)}
                        >
                            ×
                        </button>
                    </div>
                )}

                {editPromptToast && (
                    <div className="explorer-toast explorer-toast--prompt" role="alert">
                        <span>
                            {editPromptToast.kind === 'move'
                                ? "That move isn't in your repertoire yet."
                                : 'Annotations are read-only here.'}
                        </span>
                        <button
                            type="button"
                            className="explorer-toast-action"
                            onClick={() => {
                                setEditPromptToast(null);
                                enterEditMode();
                            }}
                        >
                            Switch to edit mode
                        </button>
                        <button
                            type="button"
                            className="explorer-toast-dismiss"
                            aria-label="Dismiss"
                            onClick={() => setEditPromptToast(null)}
                        >
                            ×
                        </button>
                    </div>
                )}

                {view === 'main' && (
                <div className="explorer-body">
                    {/* Toolbar lives in the body's top-left grid cell so it
                        shares the board's column width exactly — its left
                        and right edges line up with the board's edges. The
                        right column starts on the second grid row,
                        top-aligned with the chessboard (not with the
                        toolbar) so the toolbar reads as the page's top
                        line. Read mode: orientation toggle on the left,
                        green "Edit repertoire" CTA on the right. Edit
                        mode: toggle is hidden (editing is scoped to a
                        single repertoire per session) and the inline edit
                        bar spans the column with counts on the left and
                        the Save / Discard actions on the right; the bar
                        wraps to two rows on tight fits. Discard at zero
                        changes acts as the exit affordance back to Read
                        mode. */}
                    <div className="explorer-orientation-bar">
                        {mode === 'read' && (
                            <div className="explorer-toolbar-left">
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
                        )}
                        {mode === 'read' && (
                            <div className="explorer-toolbar-right">
                                <button
                                    type="button"
                                    className="explorer-btn explorer-btn--cta explorer-btn--primary"
                                    onClick={enterEditMode}
                                    title="Edit mode — add or remove moves and annotations"
                                >
                                    Edit repertoire
                                </button>
                                <ExplorerOverflowMenu
                                    open={menuOpen}
                                    onToggle={() => setMenuOpen(o => !o)}
                                    onExport={handleExportPgn}
                                    exportDisabled={false}
                                    busy={importBusy}
                                    colorLabel={resolvedOrientation === 'white' ? 'White' : 'Black'}
                                    triggerRefCallback={el => { menuTriggerRef.current = el; }}
                                    onOpenFsrs={() => { setMenuOpen(false); navigate('/fsrs'); }}
                                />
                            </div>
                        )}
                        {mode === 'edit' && (
                            <div className="explorer-save-bar" role="region" aria-label="Pending edits">
                                <span className="explorer-save-bar-counts">
                                    {isDirty
                                        ? [
                                            counts!.added > 0 ? `${counts!.added} added` : null,
                                            counts!.removed > 0 ? `${counts!.removed} removed` : null,
                                            counts!.changed > 0 ? `${counts!.changed} changed` : null,
                                        ].filter(Boolean).join(' · ')
                                        : 'No pending changes'}
                                </span>
                                <div className="explorer-save-bar-actions">
                                    <button
                                        type="button"
                                        className="explorer-btn explorer-btn--sm explorer-btn--primary"
                                        onClick={enterReviewView}
                                        disabled={saveInFlight || !isDirty}
                                        title={!isDirty ? 'Make a change to enable' : undefined}
                                    >
                                        Review &amp; Save
                                    </button>
                                    <button
                                        type="button"
                                        className="explorer-btn explorer-btn--sm explorer-btn--ghost"
                                        onClick={requestDiscard}
                                        disabled={saveInFlight}
                                    >
                                        Discard
                                    </button>
                                    <ExplorerOverflowMenu
                                        open={menuOpen}
                                        onToggle={() => setMenuOpen(o => !o)}
                                        onExport={handleExportPgn}
                                        exportDisabled={true}
                                        exportDisabledReason="Save or Discard your pending edits to export."
                                        busy={importBusy}
                                        colorLabel={resolvedOrientation === 'white' ? 'White' : 'Black'}
                                        triggerRefCallback={el => { menuTriggerRef.current = el; }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="explorer-left-col">
                    <div
                        className={`explorer-board-col${!isPreviewing ? ' explorer-board-col--interactive' : ''}`}
                        /*
                         * Read mode: the board is interactive so the user
                         * can play moves to navigate, but vendored
                         * chess-control still treats right-click as
                         * annotation drawing. We capture the right mouse
                         * button before it reaches the board so no
                         * ephemeral arrow is drawn (annotations stay
                         * read-only here, per EXPLORER.md), and instead
                         * surface the "switch to edit mode?" prompt.
                         *
                         * Edit mode: pass-through — the user is encouraged
                         * to drop arrows; we route them via the model.
                         */
                        onPointerDownCapture={mode === 'read' ? (e) => {
                            if (e.button === 2) {
                                e.preventDefault();
                                e.stopPropagation();
                                handleReadAnnotationAttempt();
                            }
                        } : undefined}
                        onContextMenu={mode === 'read' ? (e) => e.preventDefault() : undefined}
                    >
                        <ChessboardControl
                            roundId={`explorer-${mode}-${resolvedOrientation}-${currentFen}`}
                            fen={boardFen}
                            orientation={resolvedOrientation}
                            movePlayed={
                                isPreviewing
                                    ? () => false
                                    : mode === 'edit'
                                        ? handleBoardMove
                                        : handleReadNavigateMove
                            }
                            annotationsChanged={mode === 'edit' && !isPreviewing ? handleAnnotationsChanged : undefined}
                            annotations={annotations}
                            interactive={!isPreviewing}
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

                    {mode === 'edit' && (
                    <section className="explorer-pgn-paste" aria-label="Import PGN">
                        <label className="explorer-pgn-paste-label" htmlFor="explorer-pgn-paste-input">
                            Paste <strong>{resolvedOrientation === 'white' ? 'White' : 'Black'}</strong> repertoire PGN
                        </label>
                        <textarea
                            id="explorer-pgn-paste-input"
                            className="explorer-pgn-paste-textarea"
                            value={pasteText}
                            onChange={e => setPasteText(e.target.value)}
                            placeholder={'1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *'}
                            rows={4}
                            disabled={importBusy}
                            spellCheck={false}
                        />
                        <div className="explorer-pgn-paste-actions">
                            <button
                                type="button"
                                className="explorer-btn explorer-btn--sm explorer-btn--primary"
                                onClick={handlePasteImport}
                                disabled={importBusy || pasteText.trim().length === 0}
                            >
                                {importBusy ? 'Importing…' : 'Import PGN'}
                            </button>
                            <button
                                type="button"
                                className="explorer-btn explorer-btn--sm explorer-btn--primary explorer-pgn-paste-from-file"
                                onClick={() => importFileInputRef.current?.click()}
                                disabled={importBusy}
                                title="Import a .pgn file from disk"
                            >
                                From a PGN file
                            </button>
                        </div>
                        <input
                            type="file"
                            ref={importFileInputRef}
                            style={{ display: 'none' }}
                            accept=".pgn,application/x-chess-pgn,text/plain"
                            onChange={handleImportFileSelected}
                        />
                    </section>
                    )}
                    </div>

                    <div className="explorer-right-col">
                        <section className="explorer-how-you-got-here">
                            <div className="explorer-section-title">How you got here</div>
                            <div className="explorer-howyougothere-row">
                                <HistoryNav
                                    rootFen={service.getRootFen()}
                                    canHome={currentFen !== service.getRootFen()}
                                    canBack={canHistoryBack}
                                    canForward={canHistoryForward}
                                    onHome={() => jumpTo(service.getRootFen(), undefined, true)}
                                    onBack={goHistoryBack}
                                    onForward={goHistoryForward}
                                    onHoverHome={handleHover}
                                />
                                <div className="explorer-howyougothere-content">
                                {currentFen === service.getRootFen() ? (
                                    repertoireEmpty ? (
                                        <span className="explorer-empty-path">
                                            no lines in your {resolvedOrientation} repertoire yet
                                        </span>
                                    ) : null
                                ) : summary.shown.length === 0 ? (
                                    <div className="explorer-empty-path">(not reachable)</div>
                                ) : (
                                    <ul className="explorer-paths">
                                        <li>
                                            <MergedPathsLine
                                                shown={summary.shown}
                                                rootFen={service.getRootFen()}
                                                orientation={resolvedOrientation}
                                                onJump={fen => jumpTo(fen, undefined, true)}
                                                onHover={handleHover}
                                                trailing={lichessHref && (
                                                    <a
                                                        className="explorer-lichess-link"
                                                        href={lichessHref}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        aria-label="Open in Lichess analysis board"
                                                        title="Open in Lichess analysis board"
                                                    >
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                                            <path d="M15 3h6v6" />
                                                            <path d="M10 14 21 3" />
                                                        </svg>
                                                    </a>
                                                )}
                                            />
                                        </li>
                                        {summary.moreCount > 0 && (
                                            <li className="explorer-paths-more">
                                                {summary.moreIsLowerBound
                                                    ? `… ${summary.moreCount}+ more ways`
                                                    : `… ${summary.moreCount} more ${summary.moreCount === 1 ? 'way' : 'ways'}`}
                                            </li>
                                        )}
                                    </ul>
                                )}
                                </div>
                            </div>
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
                                                onHover={handleHover}
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
                        fromGames={!!suggestReturnRef.current}
                    />
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
                                Your unsaved changes — {counts?.added ?? 0} added,
                                {' '}{counts?.removed ?? 0} removed,
                                {' '}{counts?.changed ?? 0} changed — will be lost.
                                This cannot be undone.
                            </p>
                            <div className="explorer-modal-actions">
                                <button
                                    type="button"
                                    className="explorer-btn explorer-btn--neutral"
                                    onClick={() => setDiscardPrompt(false)}
                                >
                                    Keep editing
                                </button>
                                <button
                                    type="button"
                                    className="explorer-btn explorer-btn--danger"
                                    onClick={confirmDiscard}
                                >
                                    Discard
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
