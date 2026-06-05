import { Chess } from 'chess.js';
import { RepertoireGraph, GraphEdge } from './RepertoireGraph';
import { FSRSService } from './FSRSService';
import { FSRSCardData } from '../models/FSRSCardData';
import { RepertoireData } from '../models/RepertoireData';
import { Annotation } from '../models/Annotation';
import {
    normalizeFenResetHalfmoveClock,
    isLikelyFen,
    isUserTurnForOrientation,
} from '../utils/FenUtils';
import {
    bootstrapRepertoiresFromLegacy,
    extractAnnotationsFromRepertoires,
    extractFsrsCardsFromRepertoires,
} from '../utils/RepertoiresSerde';
import {
    DatabaseOpening,
} from '../utils/DatabaseOpeningsUtils';
import { State } from 'ts-fsrs';

export type Orientation = 'white' | 'black';

// ── Path enumeration ──────────────────────────────────────────────────

const HOW_YOU_GOT_HERE_DISPLAY = 3;
export const HOW_YOU_GOT_HERE_CAP = 20;
// Defensive bound on a single continuation expansion. Real opening lines are
// far shorter than this; the cap exists only so a pathological repertoire
// (long forced line with no branches) cannot make the page hang. The UI
// renders an explicit "…" truncation marker if it is ever hit.
const CONTINUATION_MAX_DEPTH = 100;

/** A path from root to a position, represented as the sequence of edges taken. */
export type Path = GraphEdge[];

export interface PathEnumeration {
    paths: Path[];
    /** True iff enumeration was stopped because the cap was reached. */
    capped: boolean;
}

// ── Continuation lines ────────────────────────────────────────────────

export interface ContinuationPly {
    san: string;
    /** Normalized FEN BEFORE this ply — defines whose turn it is. */
    fromFen: string;
    /** Normalized FEN AFTER this ply. */
    toFen: string;
    /**
     * 1-based ply depth in the canonical path that contains this ply.
     * Used to format `N.SAN` or `N…SAN`. Odd ply = white move, even ply = black move.
     */
    plyDepth: number;
}

export type ContinuationTail =
    | { kind: 'branch'; alternatives: string[]; afterFen: string }
    | { kind: 'end'; afterFen: string }
    | { kind: 'open' }; // truncated by depth cap (rare)

export interface Continuation {
    plies: ContinuationPly[];
    tail: ContinuationTail;
}

// ── Opening label ─────────────────────────────────────────────────────

export interface OpeningLabel {
    eco: string;
    name: string;
}

// ── Card status ───────────────────────────────────────────────────────

export type CardStatus =
    | 'New'
    | 'Learning'
    | 'Relearning'
    | 'Due'
    | 'Mastered';

export interface CardInfo {
    status: CardStatus;
    /** Due date (undefined for New). */
    dueAt?: Date;
    /** Retrievability (0..1). Only meaningful for Review-state cards. */
    retrievability?: number;
    reps: number;
    lapses: number;
    /** Last review (undefined for New). */
    lastReviewedAt?: Date;
}

// ── Find-position results ─────────────────────────────────────────────

export interface FindResult {
    fen: string;
    /** Orientation under which the position was found. */
    orientation: Orientation;
}

/**
 * ExplorerService — a read-only facade over `RepertoireGraph`, position
 * annotations, and FSRS card state, scoped to one repertoire snapshot.
 *
 * Responsibilities (all derived from `EXPLORER.md`):
 *   - "How you got here" path enumeration (orientation-filtered, capped).
 *   - Canonical root→FEN path (shortest + lex-by-SAN tiebreak).
 *   - "Continuation" line expansion (single-edge runs, branch lists, end of line).
 *   - Position membership check (orientation-reachable).
 *   - Per-FEN arrow annotations merged across PGN sources.
 *   - Per-card FSRS status derivation, including the *Mastered* label.
 *   - Find-position input parsing (FEN or PGN) with cross-orientation fallback.
 *
 * The service is pure with respect to its inputs — it never writes to the
 * repertoire blob.
 */
export class ExplorerService {
    public readonly graph: RepertoireGraph;
    private readonly fsrs: FSRSService;
    private readonly openings: DatabaseOpening[];

    // orientation → FEN → reachable from root via orientation-filtered edges
    private readonly reachable: Record<Orientation, Set<string>>;

    // orientation → FEN → merged Annotation[] (arrows only — squares are skipped)
    private readonly annotationsByFen: Record<Orientation, Map<string, Annotation[]>>;

    // Memoized canonical path per (orientation, FEN)
    private readonly canonicalCache: Record<Orientation, Map<string, Path | null>>;

    // Memoized classification per PGN string
    private readonly classifyCache = new Map<string, OpeningLabel | null>();

    constructor(
        data: RepertoireData,
        openings: DatabaseOpening[],
    ) {
        // ExplorerService is invoked directly from page code as well as from
        // tests (which often hand-craft legacy-shape RepertoireData). Tolerate
        // both shapes by running the same bootstrap path the normalize() flow
        // uses for blobs that lack `repertoires`.
        let repertoires = data.repertoires;
        let fsrsCards = data.fsrsCards;
        if (!repertoires) {
            repertoires = bootstrapRepertoiresFromLegacy(data.data ?? [], data.fsrsCards ?? {});
            fsrsCards = extractFsrsCardsFromRepertoires(repertoires);
        }

        this.graph = RepertoireGraph.fromRepertoires(repertoires);
        this.fsrs = new FSRSService(fsrsCards ?? {});
        this.openings = openings;

        this.reachable = {
            white: this.computeReachable('white'),
            black: this.computeReachable('black'),
        };
        this.annotationsByFen = this.collectAnnotations(repertoires);

        this.canonicalCache = { white: new Map(), black: new Map() };
    }

    getRootFen(): string {
        return this.graph.getRootFen();
    }

    /**
     * True iff `fen` is reachable from root by following only edges that
     * belong to `orientation`'s repertoire. The root is always considered
     * in repertoire (even for empty repertoires).
     */
    isInRepertoire(fen: string, orientation: Orientation): boolean {
        return this.reachable[orientation].has(fen);
    }

    /** Outgoing edges from `fen` belonging to the given orientation. */
    getEdges(fen: string, orientation: Orientation): GraphEdge[] {
        return this.graph.getEdges(fen, orientation);
    }

    /** Annotations attached to `fen` from any variant in this orientation. */
    getAnnotations(fen: string, orientation: Orientation): Annotation[] {
        return this.annotationsByFen[orientation].get(fen) ?? [];
    }

    // ── Path enumeration ──────────────────────────────────────────────

    /**
     * Enumerate paths from root to `targetFen` through `orientation`-filtered
     * edges. Search stops at `HOW_YOU_GOT_HERE_CAP`; if it stops, `capped` is true.
     *
     * Uses BFS-by-path-length so the cap respects the spec's ordering
     * guarantee: when capped, the *displayed* subset is the genuinely
     * shortest (and lex-smallest among same length) paths, not whatever
     * a DFS happened to discover first.
     *
     * Paths are deduplicated by SAN sequence (transpositions can produce
     * structurally distinct but SAN-identical paths via different traversal
     * orders).
     */
    enumeratePaths(targetFen: string, orientation: Orientation): PathEnumeration {
        const root = this.graph.getRootFen();

        // Root → empty path.
        if (targetFen === root) {
            return { paths: [[]], capped: false };
        }

        if (!this.reachable[orientation].has(targetFen)) {
            return { paths: [], capped: false };
        }

        // BFS by path length. Each frontier entry is a partial path; we expand
        // layer-by-layer so the first `HOW_YOU_GOT_HERE_CAP` results are
        // guaranteed shortest-first (with lex-by-SAN tiebreak — we sort each
        // frontier before expanding).
        //
        // Two hard bounds prevent the search from running away on pathological
        // transposition graphs:
        //   1. HOW_YOU_GOT_HERE_CAP=20 found paths → flag capped and stop.
        //   2. MAX_WORK total frontier expansions → flag capped and stop.
        //
        // Per-path cycle guard: each path carries its own visited-FEN set, so
        // a single path never revisits a node. This is what makes the BFS
        // terminate on graphs with cycles.

        const MAX_WORK = 10_000;
        let work = 0;
        let capped = false;

        type Frontier = { fen: string; edges: GraphEdge[]; visited: Set<string> };
        let frontier: Frontier[] = [{
            fen: root,
            edges: [],
            visited: new Set([root]),
        }];

        const results: Path[] = [];
        const seen = new Set<string>(); // SAN-sequence dedup across paths

        while (frontier.length > 0 && results.length < HOW_YOU_GOT_HERE_CAP) {
            // Sort current frontier by lex(SAN sequence) before expanding so
            // results within a single depth come out in lex order.
            frontier.sort((a, b) => compareSanSequence(a.edges, b.edges));

            const next: Frontier[] = [];
            let outerBreak = false;
            for (const node of frontier) {
                if (results.length >= HOW_YOU_GOT_HERE_CAP) {
                    capped = true;
                    outerBreak = true;
                    break;
                }
                if (work >= MAX_WORK) {
                    capped = true;
                    outerBreak = true;
                    break;
                }
                work += 1;
                for (const e of this.graph.getEdges(node.fen, orientation)) {
                    if (node.visited.has(e.to)) continue;
                    const newEdges = node.edges.concat(e);
                    if (e.to === targetFen) {
                        const key = newEdges.map(p => p.san).join(' ');
                        if (!seen.has(key)) {
                            seen.add(key);
                            results.push(newEdges);
                            if (results.length >= HOW_YOU_GOT_HERE_CAP) {
                                capped = true;
                                outerBreak = true;
                                break;
                            }
                        }
                        // Don't expand past the target — the spec only wants
                        // root → target paths, and descendant exploration
                        // costs work without producing valid results.
                        continue;
                    }
                    const newVisited = new Set(node.visited);
                    newVisited.add(e.to);
                    next.push({ fen: e.to, edges: newEdges, visited: newVisited });
                }
                if (outerBreak) break;
            }
            if (outerBreak) break;
            frontier = next;
        }

        // Final sort: shortest first, then lex SAN sequence.
        results.sort((a, b) => {
            if (a.length !== b.length) return a.length - b.length;
            return compareSanSequence(a, b);
        });

        return { paths: results, capped };
    }

    /**
     * Returns up to `HOW_YOU_GOT_HERE_DISPLAY` paths plus a count of how many
     * more exist (with `+` when the enumeration cap was hit).
     */
    summarizePaths(targetFen: string, orientation: Orientation): {
        shown: Path[];
        moreCount: number;
        moreIsLowerBound: boolean;
    } {
        const { paths, capped } = this.enumeratePaths(targetFen, orientation);
        const shown = paths.slice(0, HOW_YOU_GOT_HERE_DISPLAY);
        const more = Math.max(0, paths.length - shown.length);
        return { shown, moreCount: more, moreIsLowerBound: capped };
    }

    /**
     * Canonical path from root to `fen`. Shortest first, ties broken lex by
     * SAN sequence (same ordering as `enumeratePaths`). Returns null when
     * `fen` is not reachable in this orientation. Returns [] for root.
     */
    canonicalPath(fen: string, orientation: Orientation): Path | null {
        const cache = this.canonicalCache[orientation];
        if (cache.has(fen)) return cache.get(fen) ?? null;
        const { paths } = this.enumeratePaths(fen, orientation);
        const path = paths[0] ?? null;
        cache.set(fen, path);
        return path;
    }

    /**
     * Reconstruct a PGN string for a path. Used by ClassifyOpening (which
     * loads PGNs via chess.js) and for textual rendering.
     */
    pathToPgn(path: Path): string {
        if (path.length === 0) return '';
        const chess = new Chess();
        for (const e of path) {
            chess.move(e.san);
        }
        return chess.pgn();
    }

    // ── Continuation expansion ────────────────────────────────────────

    /**
     * Given a row entry (a single first edge from the current position) and
     * the depth of the current position in the canonical path, expand the
     * continuation that follows that edge. The first ply emitted is `firstEdge`
     * itself.
     */
    expandContinuation(
        startDepth: number,
        firstEdge: GraphEdge,
        orientation: Orientation,
    ): Continuation {
        const plies: ContinuationPly[] = [];
        const visited = new Set<string>();

        let cur = firstEdge;
        let depth = startDepth + 1;

        // Emit the row's own ply first so navigation/styling lines up.
        plies.push({
            san: cur.san,
            fromFen: cur.from,
            toFen: cur.to,
            plyDepth: depth,
        });
        visited.add(cur.from);

        while (plies.length < CONTINUATION_MAX_DEPTH) {
            if (visited.has(cur.to)) {
                // Cycle — stop with a neutral "end" marker.
                return { plies, tail: { kind: 'end', afterFen: cur.to } };
            }
            visited.add(cur.to);

            const next = this.graph.getEdges(cur.to, orientation);
            if (next.length === 0) {
                return { plies, tail: { kind: 'end', afterFen: cur.to } };
            }
            if (next.length > 1) {
                return {
                    plies,
                    tail: {
                        kind: 'branch',
                        alternatives: next.map(e => e.san),
                        afterFen: cur.to,
                    },
                };
            }

            cur = next[0];
            depth += 1;
            plies.push({
                san: cur.san,
                fromFen: cur.from,
                toFen: cur.to,
                plyDepth: depth,
            });
        }

        return { plies, tail: { kind: 'open' } };
    }

    // ── Card status ───────────────────────────────────────────────────

    /**
     * Derive the Explorer status row for a (FEN, SAN) user-turn card.
     * - state=New                                    → 'New'
     * - state=Learning                               → 'Learning'
     * - state=Relearning                             → 'Relearning'
     * - state=Review ∧ R ≥ getRetention() ∧ not due → 'Mastered'
     * - state=Review otherwise                       → 'Due'
     */
    cardInfo(fen: string, san: string, now: Date): CardInfo {
        const cards = this.fsrs.getCards();
        const key = FSRSService.makeCardKey(fen, san);
        const c: FSRSCardData | undefined = cards[key];

        if (!c) {
            return { status: 'New', reps: 0, lapses: 0 };
        }

        if (c.st === State.New) {
            return { status: 'New', reps: c.r, lapses: c.l };
        }

        const due = FSRSService.computeDueDate(c);
        const lastReviewedAt = c.lr ? new Date(c.lr) : undefined;

        if (c.st === State.Learning) {
            return {
                status: 'Learning',
                dueAt: due,
                reps: c.r,
                lapses: c.l,
                lastReviewedAt,
            };
        }
        if (c.st === State.Relearning) {
            return {
                status: 'Relearning',
                dueAt: due,
                reps: c.r,
                lapses: c.l,
                lastReviewedAt,
            };
        }

        // Review.
        const R = this.fsrs.getRetrievability(fen, san, now) ?? 0;
        const target = FSRSService.getRetention();
        const isDue = now >= due;
        const status: CardStatus = (!isDue && R >= target) ? 'Mastered' : 'Due';
        return {
            status,
            dueAt: due,
            retrievability: R,
            reps: c.r,
            lapses: c.l,
            lastReviewedAt,
        };
    }

    // ── Opening classification ────────────────────────────────────────

    /**
     * Returns the most-specific opening label for a path, or null if no
     * classification matches.
     */
    classifyPath(path: Path): OpeningLabel | null {
        const pgn = this.pathToPgn(path);
        return this.classifyPgn(pgn);
    }

    /** Same as classifyPath but takes a PGN string directly. */
    classifyPgn(pgn: string): OpeningLabel | null {
        if (this.classifyCache.has(pgn)) {
            return this.classifyCache.get(pgn) ?? null;
        }

        let result: OpeningLabel | null = null;
        if (pgn.trim().length > 0) {
            // Don't rely on `ClassifyOpening`'s post-sort order to identify
            // the most-specific label — its output is alphabetized, which
            // shuffles deeper matches around. Reproduce the spec's intent
            // here: among all opening-DB matches whose PGN is a prefix of
            // the input (in chess.js PGN whitespace form), pick the one
            // with the longest PGN.
            const target = `${pgn} `;
            let best: DatabaseOpening | null = null;
            for (const o of this.openings) {
                if (target.startsWith(`${o.pgn} `)) {
                    if (!best || o.pgn.length > best.pgn.length) best = o;
                }
            }
            if (best) {
                result = { eco: best.eco, name: best.name };
            }
        }
        this.classifyCache.set(pgn, result);
        return result;
    }

    /**
     * True iff classifying after the move produces a different (eco, name)
     * pair than classifying before. Used by per-row opening labels.
     *
     * Builds the after-PGN by replaying `beforePgn` in chess.js and applying
     * the new move so that move numbering matches `openings.tsv`'s
     * `1. e4 c5 2. Nc3` format — naïve string concatenation produces
     * `1. e4 c5 Nc3` for a white move following a black move, which would
     * never match the openings DB.
     */
    classificationChanges(beforePgn: string, beforeMoveSan: string): OpeningLabel | null {
        let after = beforeMoveSan;
        try {
            const chess = new Chess();
            if (beforePgn.length > 0) chess.loadPgn(beforePgn);
            chess.move(beforeMoveSan);
            after = chess.pgn();
        } catch {
            // Fall back to the literal concatenation if chess.js refuses the
            // move — caller will simply not find a classification change.
            after = beforePgn.length > 0 ? `${beforePgn} ${beforeMoveSan}` : beforeMoveSan;
        }

        const beforeLabel = this.classifyPgn(beforePgn);
        const afterLabel = this.classifyPgn(after);

        if (!afterLabel) return null;
        if (!beforeLabel) return afterLabel;
        if (beforeLabel.eco !== afterLabel.eco || beforeLabel.name !== afterLabel.name) {
            return afterLabel;
        }
        return null;
    }

    // ── Find-position parsing ─────────────────────────────────────────

    /**
     * Resolve a free-text input (FEN or PGN) to a normalized FEN that exists
     * in some orientation's repertoire. The active orientation is tried first;
     * on miss, the other orientation is tried. Returns null if invalid input
     * or absent from both orientations.
     */
    findPosition(input: string, activeOrientation: Orientation): FindResult | null {
        const trimmed = input.trim();
        if (!trimmed) return null;

        let resolvedFen: string | null = null;

        if (isLikelyFen(trimmed)) {
            try {
                const chess = new Chess(trimmed);
                resolvedFen = normalizeFenResetHalfmoveClock(chess.fen());
            } catch {
                return null;
            }
        } else {
            try {
                const chess = new Chess();
                chess.loadPgn(trimmed);
                if (chess.history().length === 0) return null;
                resolvedFen = normalizeFenResetHalfmoveClock(chess.fen());
            } catch {
                return null;
            }
        }

        if (!resolvedFen) return null;

        if (this.isInRepertoire(resolvedFen, activeOrientation)) {
            return { fen: resolvedFen, orientation: activeOrientation };
        }
        const other: Orientation = activeOrientation === 'white' ? 'black' : 'white';
        if (this.isInRepertoire(resolvedFen, other)) {
            return { fen: resolvedFen, orientation: other };
        }
        return null;
    }

    // ── Helpers ───────────────────────────────────────────────────────

    /**
     * Helper: is `fen` a user-turn position for `orientation`?
     */
    static isUserTurn(fen: string, orientation: Orientation): boolean {
        return isUserTurnForOrientation(fen, orientation);
    }

    // ── Private ───────────────────────────────────────────────────────

    private computeReachable(orientation: Orientation): Set<string> {
        const reachable = new Set<string>();
        const root = this.graph.getRootFen();
        const stack: string[] = [root];
        reachable.add(root);
        while (stack.length) {
            const fen = stack.pop()!;
            for (const e of this.graph.getEdges(fen, orientation)) {
                if (!reachable.has(e.to)) {
                    reachable.add(e.to);
                    stack.push(e.to);
                }
            }
        }
        return reachable;
    }

    private collectAnnotations(repertoires: import('../models/Repertoires').RepertoireEntry[]): Record<Orientation, Map<string, Annotation[]>> {
        // Source annotations from the position dict. The Explorer historically
        // hid square highlights (arrows-only) and we keep that here so the
        // arrow-overlay UI doesn't gain noisy squares. The persisted shape
        // still carries both — see RepertoiresSerde for the storage layer.
        const result: Record<Orientation, Map<string, Annotation[]>> = {
            white: new Map(),
            black: new Map(),
        };
        const per = extractAnnotationsFromRepertoires(repertoires);
        for (const orientation of ['white', 'black'] as const) {
            for (const [fen, anns] of per[orientation]) {
                const arrows = anns.filter(a => a.dest);
                if (arrows.length > 0) {
                    result[orientation].set(fen, arrows);
                }
            }
        }
        return result;
    }
}

// ── Pure formatting helpers (decoupled from the service for easy testing) ──

/** Lexicographic comparison of two paths' SAN sequences. */
function compareSanSequence(a: GraphEdge[], b: GraphEdge[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const c = a[i].san.localeCompare(b[i].san);
        if (c !== 0) return c;
    }
    return a.length - b.length;
}

/**
 * Format a single ply as PGN-style text. `plyDepth` is 1-based (1 = first
 * white move). Odd depth = white, even depth = black.
 */
export function formatPly(san: string, plyDepth: number): string {
    const isWhite = plyDepth % 2 === 1;
    const moveNumber = Math.ceil(plyDepth / 2);
    return isWhite ? `${moveNumber}.${san}` : `${moveNumber}\u2026${san}`;
}

/**
 * Render a sequence of plies as PGN-style tokens, applying the standard rule
 * that a black move dropping immediately after the matching white move on the
 * same line omits the move number (e.g. `1.e4 c5 2.Nf3 Nc6` rather than
 * `1.e4 1…c5 2.Nf3 2…Nc6`). The first ply always carries its move number.
 *
 * Returns an array of labels aligned 1:1 with the input plyDepths.
 */
export function formatPlyLabels(plyDepths: number[], sans: string[]): string[] {
    return formatPlyLabelParts(plyDepths, sans).map(p => p.prefix + p.san);
}

/**
 * Like `formatPlyLabels`, but returns each ply pre-split into a non-clickable
 * `prefix` (e.g. "1.", "3…", or "") and the SAN. UI code uses this so that the
 * clickable hit area can be just the SAN while the move number remains visible
 * as plain text.
 */
export function formatPlyLabelParts(
    plyDepths: number[],
    sans: string[],
): { prefix: string; san: string }[] {
    const out: { prefix: string; san: string }[] = [];
    for (let i = 0; i < plyDepths.length; i++) {
        const depth = plyDepths[i];
        const isWhite = depth % 2 === 1;
        const moveNumber = Math.ceil(depth / 2);
        let prefix: string;
        if (i === 0) {
            prefix = isWhite ? `${moveNumber}.` : `${moveNumber}\u2026`;
        } else if (isWhite) {
            prefix = `${moveNumber}.`;
        } else {
            // Drop the move number on a black move that immediately follows the
            // matching white move in this sequence.
            const prevDepth = plyDepths[i - 1];
            prefix = prevDepth === depth - 1 && prevDepth % 2 === 1
                ? ''
                : `${moveNumber}\u2026`;
        }
        out.push({ prefix, san: sans[i] });
    }
    return out;
}

/**
 * Format an entire path as a space-separated PGN string with move numbers,
 * applying the same contextual rule as `formatPlyLabels`.
 */
export function formatPathAsPgn(path: Path, startDepth: number = 1): string {
    const depths = path.map((_, i) => startDepth + i);
    const sans = path.map(e => e.san);
    return formatPlyLabels(depths, sans).join(' ');
}
