import { Chess } from 'chess.js';
import { createEmptyCard } from 'ts-fsrs';
import {
    RepertoireEntry,
    PositionEntry,
    MoveEntry,
    createEmptyRepertoires,
    findRepertoire,
} from '../models/Repertoires';
import { Annotation } from '../models/Annotation';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService } from './FSRSService';
import {
    normalizeFenResetHalfmoveClock,
    isUserTurnForOrientation,
} from '../utils/FenUtils';

export type Orientation = 'white' | 'black';

// ── Public delta shapes ──────────────────────────────────────────────

/**
 * A single edited edge. `from`/`to` are normalized FENs. `san` is the move in SAN.
 * Cards travel with `from`+`san`; if the edge is a user-turn move for the
 * orientation, `cardKey` is FSRSService.makeCardKey(from, san).
 */
export interface EditedEdge {
    orientation: Orientation;
    from: string;
    to: string;
    san: string;
    /**
     * 1-based ply depth along the canonical path used for the row label.
     * Computed by the chain decomposer; not used by the model itself.
     */
    plyDepth?: number;
    /**
     * Whether this edge is a user-turn edge under `orientation` (i.e. produces
     * an FSRS card on add and frees one on remove).
     */
    isUserTurn: boolean;
}

/** A chain of co-linear edits (added or cascade-removed). */
export interface EditChain {
    orientation: Orientation;
    /**
     * Head row: the user-clicked edit at the top of the chain. PGN path shown
     * on collapsed rows is `headPgn` and runs from the start position through
     * `head.to`.
     */
    head: EditedEdge;
    /** Tail edges (length ≥ 0). Length-0 → length-1 chain. */
    tail: EditedEdge[];
    /**
     * Canonical PGN path from the start position to the chain's last edge's
     * `to` FEN (joined "1.e4 c5 …"). Used for the chain's row label and for
     * Cancel/Back round-trips.
     */
    chainPgn: string;
    /**
     * PGN path from the start position to the chain HEAD's `from` FEN (the
     * "parent" position the row shows the board for). Empty when the head's
     * `from` is the root.
     */
    parentPgn: string;
    /**
     * For Added: present iff the chain joins back into an already-known
     * subtree under the chain's last edge's `to` FEN, and reports how many
     * surviving (user-turn) edges live below. Absent → leaf.
     *
     * For Removed: present iff the cascade stopped because the next-step
     * position is still reachable from another path. Carries one canonical
     * PGN that still reaches it (the lex-smallest among alternatives).
     */
    tailHint?:
        | { kind: 'joins-existing'; movesBelow: number }
        | { kind: 'survives-via'; viaPgn: string; viaSan?: string };
}

/** A position with annotation set change (set-equality compared). */
export interface AnnotationDiff {
    orientation: Orientation;
    fen: string;
    /** Canonical PGN path from start to this FEN under `orientation`. */
    pgn: string;
    before: Annotation[];
    after: Annotation[];
}

/** Computed delta. Empty array fields → no items in that category. */
export interface PendingDelta {
    addedChains: EditChain[];
    removedChains: EditChain[];
    editedAnnotations: AnnotationDiff[];
    /** Sums across all chains. */
    counts: { added: number; removed: number; changed: number };
}

// ── Helpers (module-private) ──────────────────────────────────────────

function cloneRepertoires(reps: RepertoireEntry[]): RepertoireEntry[] {
    return reps.map(r => ({
        name: r.name,
        orientation: r.orientation,
        positions: Object.fromEntries(
            Object.entries(r.positions).map(([fen, pos]) => [
                fen,
                {
                    annotations: pos.annotations ? pos.annotations.map(a => ({ ...a })) : undefined,
                    moves: Object.fromEntries(
                        Object.entries(pos.moves).map(([san, m]) => [
                            san,
                            // Cards are read-only in the snapshot; deep-clone the
                            // FSRSCardData object so later mutations don't leak.
                            m.card ? { card: { ...m.card } } : {},
                        ]),
                    ),
                },
            ]),
        ),
    }));
}

function startFen(): string {
    return normalizeFenResetHalfmoveClock(new Chess().fen());
}

function fenAfter(fromFen: string, san: string): string | null {
    try {
        const chess = new Chess(fromFen);
        const m = chess.move(san);
        if (!m) return null;
        return normalizeFenResetHalfmoveClock(chess.fen());
    } catch {
        return null;
    }
}

function reachableFensFromRoot(
    rep: RepertoireEntry | undefined,
    root: string,
): Set<string> {
    const r = new Set<string>([root]);
    if (!rep) return r;
    const stack = [root];
    while (stack.length) {
        const fen = stack.pop()!;
        const pos = rep.positions[fen];
        if (!pos) continue;
        for (const san of Object.keys(pos.moves)) {
            const to = fenAfter(fen, san);
            if (to && !r.has(to)) {
                r.add(to);
                stack.push(to);
            }
        }
    }
    return r;
}

/** Set equality for annotation arrays (order-insensitive, duplicate-collapsing). */
function annotationsKey(anns: Annotation[]): string {
    const norm = anns.map(a => `${a.brush}${a.orig}${a.dest ?? ''}`);
    norm.sort();
    return [...new Set(norm)].join('|');
}

function annotationSetsEqual(a: Annotation[], b: Annotation[]): boolean {
    return annotationsKey(a) === annotationsKey(b);
}

function compareSans(a: string, b: string): number {
    return a.localeCompare(b);
}

// ── Path enumeration (canonical-only, on a given repertoire snapshot) ──

/**
 * Canonical (shortest, lex-by-SAN tiebreak) path of SAN moves from root to
 * `targetFen` in `rep`. Returns null if not reachable. [] for root.
 *
 * BFS with per-path visited set so cycles are tolerated; ties at any depth
 * are broken by sorting the frontier on (running SAN sequence) before
 * expanding it, mirroring ExplorerService.enumeratePaths' first result.
 */
function canonicalPath(
    rep: RepertoireEntry | undefined,
    targetFen: string,
    root: string,
): string[] | null {
    if (targetFen === root) return [];
    if (!rep) return null;
    const reachable = reachableFensFromRoot(rep, root);
    if (!reachable.has(targetFen)) return null;

    type FrontierItem = { fen: string; sans: string[]; visited: Set<string> };
    let frontier: FrontierItem[] = [{ fen: root, sans: [], visited: new Set([root]) }];
    const MAX_WORK = 20_000;
    let work = 0;
    while (frontier.length > 0) {
        // Stable lex order ensures the first result returned is the lex-smallest at this depth.
        frontier.sort((a, b) => {
            const n = Math.min(a.sans.length, b.sans.length);
            for (let i = 0; i < n; i++) {
                const c = compareSans(a.sans[i], b.sans[i]);
                if (c !== 0) return c;
            }
            return a.sans.length - b.sans.length;
        });
        const next: FrontierItem[] = [];
        for (const item of frontier) {
            if (work++ > MAX_WORK) return null;
            const pos = rep.positions[item.fen];
            if (!pos) continue;
            const sans = Object.keys(pos.moves).slice().sort(compareSans);
            for (const san of sans) {
                const to = fenAfter(item.fen, san);
                if (!to) continue;
                if (item.visited.has(to)) continue;
                const newSans = item.sans.concat(san);
                if (to === targetFen) {
                    return newSans;
                }
                const newVisited = new Set(item.visited);
                newVisited.add(to);
                next.push({ fen: to, sans: newSans, visited: newVisited });
            }
        }
        frontier = next;
    }
    return null;
}

/**
 * Try each repertoire's positions dict for a canonical path to `target`,
 * skipping the orientation we already tried in the caller. Returns the
 * first hit (shortest, lex-by-SAN tiebreak within each rep).
 */
function canonicalFromAny(
    reps: RepertoireEntry[],
    target: string,
    root: string,
    skip: Orientation,
): string[] | null {
    for (const r of reps) {
        if (r.orientation === skip) continue;
        const p = canonicalPath(r, target, root);
        if (p) return p;
    }
    return null;
}

function pathToPgn(sans: string[]): string {
    if (sans.length === 0) return '';
    const chess = new Chess();
    for (const s of sans) chess.move(s);
    return chess.pgn();
}

// ── PendingEditModel ──────────────────────────────────────────────────

/**
 * In-memory pending-delta state for Explorer Edit mode.
 *
 * Holds:
 *   - `baseRepertoires`: a frozen deep-clone snapshot captured when Edit
 *     was entered.
 *   - `currentRepertoires`: the live, mutable working copy that edit
 *     operations modify in place.
 *   - `baseFsrsCards`: snapshot of all FSRS cards keyed by `<fen>::<san>`
 *     at edit-start (used to restore on Discard and for the conflict path).
 *   - `newCardsByKey`: brand-new FSRSCardData created for each newly-added
 *     user-turn edge. Dropped on Discard; merged into the persisted blob
 *     on Save.
 *
 * The model exposes pure-ish mutating methods (`addEdge`, `deleteEdge`,
 * `setAnnotations`) and a pure `computeDelta()` derived from
 * (base, current) — no operation log is tracked.
 */
export class PendingEditModel {
    public readonly baseRepertoires: RepertoireEntry[];
    public readonly currentRepertoires: RepertoireEntry[];
    public readonly baseFsrsCards: Record<string, FSRSCardData>;
    /** Cards created for newly-added user-turn edges, keyed by `<from>::<san>`. */
    public readonly newCardsByKey: Record<string, FSRSCardData>;

    public readonly root: string;

    constructor(
        baseRepertoires: RepertoireEntry[],
        baseFsrsCards: Record<string, FSRSCardData>,
    ) {
        // Snapshot is deep-cloned and frozen so it can't be mutated in place
        // by the rest of the page even if a caller leaks a reference.
        this.baseRepertoires = cloneRepertoires(baseRepertoires);
        this.currentRepertoires = cloneRepertoires(baseRepertoires);
        // Ensure both repertoires exist on the working copy even if the
        // backing blob doesn't carry one (defensive: an empty repertoire
        // should still permit the user to drop new moves).
        for (const need of createEmptyRepertoires()) {
            if (!findRepertoire(this.baseRepertoires, need.orientation)) {
                this.baseRepertoires.push({ ...need, positions: {} });
            }
            if (!findRepertoire(this.currentRepertoires, need.orientation)) {
                this.currentRepertoires.push({ ...need, positions: {} });
            }
        }
        // Freeze the base; the runtime can't enforce TS readonly, so use
        // Object.freeze defensively. (The card objects inside `baseFsrsCards`
        // are user-visible elsewhere so we don't freeze them — just the dict.)
        for (const rep of this.baseRepertoires) {
            for (const pos of Object.values(rep.positions)) {
                Object.freeze(pos.moves);
                if (pos.annotations) Object.freeze(pos.annotations);
                Object.freeze(pos);
            }
            Object.freeze(rep.positions);
            Object.freeze(rep);
        }
        Object.freeze(this.baseRepertoires);

        this.baseFsrsCards = { ...baseFsrsCards };
        this.newCardsByKey = {};
        this.root = startFen();
    }

    // ── Queries used by the UI ───────────────────────────────────────

    getCurrentRepertoire(orientation: Orientation): RepertoireEntry {
        const rep = findRepertoire(this.currentRepertoires, orientation);
        if (!rep) throw new Error(`PendingEditModel: missing repertoire for ${orientation}`);
        return rep;
    }

    /** Working copy's annotations for (fen, orientation). Empty array if none. */
    getAnnotations(fen: string, orientation: Orientation): Annotation[] {
        const rep = this.getCurrentRepertoire(orientation);
        return rep.positions[fen]?.annotations ?? [];
    }

    /** True iff the position is reachable from root in the working copy. */
    isReachable(fen: string, orientation: Orientation): boolean {
        if (fen === this.root) return true;
        const rep = this.getCurrentRepertoire(orientation);
        const reachable = reachableFensFromRoot(rep, this.root);
        return reachable.has(fen);
    }

    /**
     * True iff the model has no pending changes vs. its snapshot. Used to
     * gate Save/Discard and the beforeunload warning.
     */
    isEmpty(): boolean {
        const d = this.computeDelta();
        return d.counts.added === 0 && d.counts.removed === 0 && d.counts.changed === 0;
    }

    // ── Mutating operations ─────────────────────────────────────────

    /**
     * Add an edge `(from --san--> to)` to `orientation`'s repertoire.
     *
     * - Replays SAN through chess.js to derive `to`; throws if illegal.
     * - Ensures both positions exist; idempotent if the edge already exists.
     * - For user-turn moves, attaches a fresh New-state card unless one
     *   already exists in the base map (which is the case for adds that
     *   resurrect a previously-deleted edge in the same session). The
     *   `newCardsByKey` ledger only carries cards we *minted* in this
     *   session — base-resurrected cards aren't double-counted.
     *
     * Returns the resulting `to` FEN, or null if the move was illegal.
     */
    addEdge(from: string, san: string, orientation: Orientation): string | null {
        const to = fenAfter(from, san);
        if (!to) return null;
        const rep = this.getCurrentRepertoire(orientation);
        if (!rep.positions[from]) rep.positions[from] = { moves: {} };
        if (!rep.positions[to]) rep.positions[to] = { moves: {} };
        if (!rep.positions[from].moves[san]) {
            rep.positions[from].moves[san] = {};
        }
        if (isUserTurnForOrientation(from, orientation)) {
            const key = FSRSService.makeCardKey(from, san);
            const baseCard = this.baseFsrsCards[key];
            if (baseCard) {
                // Resurrected edge — re-attach the original card so the
                // user's history isn't reset on a delete-then-readd loop.
                rep.positions[from].moves[san].card = baseCard;
                delete this.newCardsByKey[key];
            } else if (!this.newCardsByKey[key]) {
                // Brand-new card; serialize via FSRSService for backend parity.
                const card = createEmptyCard();
                const serialized = FSRSService.serialize(card);
                this.newCardsByKey[key] = serialized;
                rep.positions[from].moves[san].card = serialized;
            } else {
                rep.positions[from].moves[san].card = this.newCardsByKey[key];
            }
        }
        return to;
    }

    /**
     * Delete edge `(from --san-->)` from `orientation`'s repertoire and
     * cascade-prune any descendants no longer reachable from root through
     * orientation-filtered edges. Transposition-protected positions survive.
     *
     * Returns:
     *   - `removedPositions`: every position pruned in the cascade (the
     *     immediate `to` is included only if it became unreachable; it is
     *     excluded if it survived via transposition).
     *
     * No-op if the edge does not exist; returns empty results.
     *
     * The full transposition-tail annotation ("stopped at X — still
     * reachable via Y") is reported by `computeDelta()` on each removed
     * chain's `tailHint`. Callers that only need the immediate UI feedback
     * after a delete can inspect `removedPositions`.
     */
    deleteEdge(from: string, san: string, orientation: Orientation): {
        removedPositions: string[];
    } {
        const rep = this.getCurrentRepertoire(orientation);
        const pos = rep.positions[from];
        if (!pos || !pos.moves[san]) {
            return { removedPositions: [] };
        }

        // Snapshot card key BEFORE deletion so we can drop the corresponding
        // newCardsByKey entry if this was a brand-new edge added in this
        // session.
        const key = FSRSService.makeCardKey(from, san);

        // 1. Remove the edge.
        delete pos.moves[san];

        // 2. Was this a fresh card we'd minted? Drop it.
        delete this.newCardsByKey[key];

        // 3. Cascade — recompute reachability from root.
        const reachable = reachableFensFromRoot(rep, this.root);
        const removed: string[] = [];
        for (const fen of Object.keys(rep.positions)) {
            // Never drop the root (it's always reachable).
            if (fen === this.root) continue;
            if (!reachable.has(fen)) {
                removed.push(fen);
                delete rep.positions[fen];
            }
        }

        // 4. Drop any new cards whose `from` got pruned (defensive — they
        //    shouldn't be reachable from a pruned position anyway).
        const removedSet = new Set(removed);
        for (const k of Object.keys(this.newCardsByKey)) {
            const { fen: cardFen } = FSRSService.parseCardKey(k);
            if (removedSet.has(cardFen)) {
                delete this.newCardsByKey[k];
            }
        }

        return { removedPositions: removed };
    }

    /**
     * Replace the annotation set for (fen, orientation) on the working copy.
     * Ensures the position exists (creates one with empty moves if not).
     * Set-equality semantics (order/dup-insensitive) are applied in
     * `computeDelta`; this method does not normalize the input.
     */
    setAnnotations(fen: string, orientation: Orientation, annotations: Annotation[]): void {
        const rep = this.getCurrentRepertoire(orientation);
        if (!rep.positions[fen]) rep.positions[fen] = { moves: {} };
        if (annotations.length === 0) {
            delete rep.positions[fen].annotations;
        } else {
            rep.positions[fen].annotations = annotations.map(a => ({ ...a }));
        }
    }

    // ── Delta computation ────────────────────────────────────────────

    /**
     * Compare (base, current) and produce the chain-decomposed delta the
     * Review view renders. Pure over the model's snapshots.
     */
    computeDelta(): PendingDelta {
        const addedChains: EditChain[] = [];
        const removedChains: EditChain[] = [];
        const editedAnnotations: AnnotationDiff[] = [];

        for (const orientation of ['white', 'black'] as Orientation[]) {
            const baseRep = findRepertoire(this.baseRepertoires, orientation);
            const curRep = findRepertoire(this.currentRepertoires, orientation);
            if (!baseRep || !curRep) continue;

            // Build edge sets.
            const baseEdges = collectEdges(baseRep);
            const curEdges = collectEdges(curRep);

            const baseKeys = new Set(Object.keys(baseEdges));
            const curKeys = new Set(Object.keys(curEdges));

            const addedEdgeKeys = [...curKeys].filter(k => !baseKeys.has(k));
            const removedEdgeKeys = [...baseKeys].filter(k => !curKeys.has(k));

            // Chain-decompose Added against current repertoire (reachability
            // and "joins-existing" annotations need to look at survivors).
            // Pass BOTH orientations' reps so multi-orientation edits in one
            // session can resolve parent paths across orientations.
            const addedAsChains = decomposeChains(
                'added',
                addedEdgeKeys.map(k => curEdges[k]),
                orientation,
                curRep,
                baseRep,
                this.root,
                this.currentRepertoires,
                this.baseRepertoires,
            );
            for (const c of addedAsChains) addedChains.push(c);

            const removedAsChains = decomposeChains(
                'removed',
                removedEdgeKeys.map(k => baseEdges[k]),
                orientation,
                curRep,
                baseRep,
                this.root,
                this.currentRepertoires,
                this.baseRepertoires,
            );
            for (const c of removedAsChains) removedChains.push(c);

            // Annotation diffs (set semantics).
            //
            // Only consider positions REACHABLE in both base and current:
            //   - Positions cascade-pruned by a delete in this session are
            //     unreachable in current — their annotations went with the
            //     position (covered by removedChains).
            //   - Positions added by an addEdge in this session are
            //     unreachable in base — their annotations are part of the
            //     new addition (covered by addedChains).
            //   - Root is always reachable (even on an empty repertoire),
            //     so annotation edits on the start position always register.
            const baseReachable = reachableFensFromRoot(baseRep, this.root);
            const curReachable = reachableFensFromRoot(curRep, this.root);
            const allFens = new Set<string>([
                ...Object.keys(baseRep.positions),
                ...Object.keys(curRep.positions),
                this.root,
            ]);
            for (const fen of allFens) {
                if (!baseReachable.has(fen) || !curReachable.has(fen)) continue;
                const before = baseRep.positions[fen]?.annotations ?? [];
                const after = curRep.positions[fen]?.annotations ?? [];
                if (annotationSetsEqual(before, after)) continue;
                const sans = canonicalPath(curRep, fen, this.root);
                if (!sans) continue;
                editedAnnotations.push({
                    orientation,
                    fen,
                    pgn: pathToPgn(sans),
                    before,
                    after,
                });
            }
        }

        // Counts: every edge in every chain (head + tail).
        const sumEdges = (chains: EditChain[]) =>
            chains.reduce((n, c) => n + 1 + c.tail.length, 0);

        return {
            addedChains,
            removedChains,
            editedAnnotations,
            counts: {
                added: sumEdges(addedChains),
                removed: sumEdges(removedChains),
                changed: editedAnnotations.length,
            },
        };
    }

    // ── Reset / hard-discard ─────────────────────────────────────────

    /**
     * Replace the working copy with a fresh clone of the snapshot and clear
     * any minted cards. Used by Discard so the next Edit session starts from
     * the saved state.
     */
    resetToBase(): void {
        // Wipe positions on the working repertoire and re-clone from the base.
        for (const rep of this.currentRepertoires) {
            for (const k of Object.keys(rep.positions)) delete rep.positions[k];
        }
        const baseClone = cloneRepertoires(this.baseRepertoires);
        for (const rep of this.currentRepertoires) {
            const src = findRepertoire(baseClone, rep.orientation);
            if (src) Object.assign(rep.positions, src.positions);
        }
        for (const k of Object.keys(this.newCardsByKey)) {
            delete this.newCardsByKey[k];
        }
    }
}

// ── Edge / chain decomposition ────────────────────────────────────────

type EdgeRecord = {
    from: string;
    san: string;
    to: string;
    isUserTurn: boolean;
    orientation: Orientation;
};

function collectEdges(rep: RepertoireEntry): Record<string, EdgeRecord> {
    const out: Record<string, EdgeRecord> = {};
    for (const [fen, pos] of Object.entries(rep.positions)) {
        for (const san of Object.keys(pos.moves)) {
            const to = fenAfter(fen, san);
            if (!to) continue;
            const key = `${fen}::${san}`;
            out[key] = {
                from: fen,
                san,
                to,
                isUserTurn: isUserTurnForOrientation(fen, rep.orientation),
                orientation: rep.orientation,
            };
        }
    }
    return out;
}

/**
 * Build chains from a set of changed edges. A chain is a maximal sequence
 * of changed edges along a single forward path. Branching or merging at any
 * intermediate node splits chains.
 *
 * Two adjacent changed edges `e1 → e2` (`e1.to == e2.from`) belong to the
 * SAME chain iff at the connecting node:
 *   - exactly one changed edge enters  (`inAt[e1.to].length == 1`), and
 *   - exactly one changed edge leaves  (`outAt[e1.to].length == 1`).
 *
 * Otherwise the edges are in separate chains. This encodes "branching splits
 * chains" symmetrically for Added and Removed: when a parent in the changed
 * subgraph branches into N siblings, each sibling is its own length-1 chain
 * (or a longer chain that continues unambiguously beyond it).
 *
 * For Added: chains hang off positions present in the BASE (so canonical
 * `parentPgn` is resolved through `baseRep`).
 * For Removed: chains hang off positions still present in CURRENT after the
 * cascade (so `parentPgn` is resolved through `curRep`).
 */
function decomposeChains(
    side: 'added' | 'removed',
    edges: EdgeRecord[],
    orientation: Orientation,
    curRep: RepertoireEntry,
    baseRep: RepertoireEntry,
    root: string,
    allCurRepertoires: RepertoireEntry[],
    allBaseRepertoires: RepertoireEntry[],
): EditChain[] {
    // Index by `from` (out-edges) and by `to` (in-edges) for fast lookups.
    const outAt = new Map<string, EdgeRecord[]>();
    const inAt = new Map<string, EdgeRecord[]>();
    for (const e of edges) {
        if (!outAt.has(e.from)) outAt.set(e.from, []);
        outAt.get(e.from)!.push(e);
        if (!inAt.has(e.to)) inAt.set(e.to, []);
        inAt.get(e.to)!.push(e);
    }

    /** True iff `e` starts a new chain (no unique connection from a predecessor). */
    const isHead = (e: EdgeRecord): boolean => {
        const preds = inAt.get(e.from) ?? [];
        if (preds.length !== 1) return true;
        // Even with a unique predecessor, branching at e.from splits the chain.
        const siblings = outAt.get(e.from) ?? [];
        return siblings.length !== 1;
    };

    const chains: EditChain[] = [];
    for (const head of edges) {
        if (!isHead(head)) continue;

        const tail: EdgeRecord[] = [];
        let cur = head;
        const guard = new Set<string>();
        guard.add(cur.from);
        // Walk forward while exactly one changed edge enters AND exactly one
        // changed edge leaves the connecting node. Stop on branch, merge, end,
        // or a cycle.
        while (true) {
            if (guard.has(cur.to)) break;
            guard.add(cur.to);
            const succ = outAt.get(cur.to) ?? [];
            const entering = inAt.get(cur.to) ?? [];
            if (succ.length !== 1 || entering.length !== 1) break;
            const next = succ[0];
            tail.push(next);
            cur = next;
        }

        const chainEdges = [head, ...tail];

        // Determine the head's parent PGN: canonical path to head.from in
        // the CURRENT repertoire (where the path actually lives now). When
        // the user is editing across orientations in one session, the
        // parent FEN may only be reachable via the OTHER orientation's
        // repertoire — fall through both orientations and then through
        // base before giving up.
        //
        // For Added: the user navigated to head.from before adding, so it's
        // reachable somewhere in curRepertoires.
        // For Removed: head.from survived the cascade by definition (else
        // the cascade would have started further up), so curRep contains it.
        const parentSans =
            canonicalPath(curRep, head.from, root)
            ?? canonicalFromAny(allCurRepertoires, head.from, root, orientation)
            ?? canonicalPath(baseRep, head.from, root)
            ?? canonicalFromAny(allBaseRepertoires, head.from, root, orientation)
            ?? [];

        // Chain PGN: parent path + each SAN in the chain.
        const chainSans = [...parentSans, ...chainEdges.map(e => e.san)];

        // Plydepth assignment (1-based from start).
        const headPlyDepth = parentSans.length + 1;
        const editedHead: EditedEdge = {
            orientation,
            from: head.from,
            to: head.to,
            san: head.san,
            isUserTurn: head.isUserTurn,
            plyDepth: headPlyDepth,
        };
        const editedTail: EditedEdge[] = tail.map((e, i) => ({
            orientation,
            from: e.from,
            to: e.to,
            san: e.san,
            isUserTurn: e.isUserTurn,
            plyDepth: headPlyDepth + 1 + i,
        }));

        // Tail hint:
        //   Added: does the chain's last `to` exist in the BASE? If so, the
        //          chain joined an existing subtree — count surviving user-turn
        //          edges below it.
        //   Removed: does the chain's last `to` still exist in CURRENT (after
        //          the cascade)? If so, the cascade stopped because of a
        //          transposition — report a canonical surviving path.
        let tailHint: EditChain['tailHint'] | undefined = undefined;
        const lastTo = chainEdges[chainEdges.length - 1].to;
        if (side === 'added') {
            // The chain "joins existing" if its tail target was already in
            // the base (whether or not it had outgoing edges — a leaf join
            // is still a join). The "moves below" count is over BASE edges,
            // recursively reachable.
            if (baseRep.positions[lastTo]) {
                const movesBelow = countDescendantUserTurnEdges(baseRep, lastTo);
                tailHint = { kind: 'joins-existing', movesBelow };
            }
        } else {
            // The cascade survived this node iff it's still in `curRep`
            // (it wasn't pruned). We don't annotate the chain's own `to`
            // as a survivor when there's no further cascade — only when
            // the chain stopped short of its last edge's `to` because of
            // a transposition.
            //
            // Detection: the chain's last edge is the user's *clicked*
            // deletion (head when length-1) or the deepest cascade ply.
            // If `lastTo` is still reachable in current, the cascade
            // ended because of a transposition; otherwise it ended at a
            // leaf of the base subtree.
            if (lastTo !== root && curRep.positions[lastTo]) {
                const sans = canonicalPath(curRep, lastTo, root);
                if (sans && sans.length > 0) {
                    tailHint = {
                        kind: 'survives-via',
                        viaPgn: pathToPgn(sans),
                        viaSan: sans[sans.length - 1],
                    };
                }
            }
        }

        chains.push({
            orientation,
            head: editedHead,
            tail: editedTail,
            chainPgn: pathToPgn(chainSans),
            parentPgn: pathToPgn(parentSans),
            tailHint,
        });
    }

    // Stable order: by (orientation, head's chainPgn).
    chains.sort((a, b) => {
        if (a.orientation !== b.orientation) return a.orientation < b.orientation ? -1 : 1;
        return a.chainPgn.localeCompare(b.chainPgn);
    });

    return chains;
}

/** Count all user-turn edges reachable from `fen` (excluding `fen` itself). */
function countDescendantUserTurnEdges(rep: RepertoireEntry, fen: string): number {
    const root = startFen();
    void root; // (not needed; keep API symmetric)
    let count = 0;
    const visited = new Set<string>();
    const stack: string[] = [fen];
    visited.add(fen);
    while (stack.length) {
        const cur = stack.pop()!;
        const pos = rep.positions[cur];
        if (!pos) continue;
        const userHere = isUserTurnForOrientation(cur, rep.orientation);
        for (const san of Object.keys(pos.moves)) {
            if (userHere) count += 1;
            const to = fenAfter(cur, san);
            if (to && !visited.has(to)) {
                visited.add(to);
                stack.push(to);
            }
        }
    }
    return count;
}

// ── Re-exports for tests ──────────────────────────────────────────────

export const __test = {
    cloneRepertoires,
    canonicalPath,
    annotationsKey,
    pathToPgn,
    fenAfter,
};

// Avoid unused-export typecheck noise: a slim wrapper consumers might use.
export function makeEmptyModel(): PendingEditModel {
    return new PendingEditModel(createEmptyRepertoires(), {});
}

// Keep helper interfaces exported for the page UI.
export type { PositionEntry, MoveEntry };
