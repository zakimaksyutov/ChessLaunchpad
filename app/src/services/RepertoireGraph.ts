import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock, isUserTurnForOrientation } from '../utils/FenUtils';
import { FSRSService } from './FSRSService';
import { RepertoireEntry } from '../models/Repertoires';
import { reachableFrom, forEachReachableEdge } from '../utils/PathSearch';

export interface GraphEdge {
    from: string;       // normalized FEN before the move
    to: string;         // normalized FEN after the move
    san: string;        // SAN notation of the move
    hasCard: boolean;   // true if any orientation treats this as a user-turn move (produces an FSRS card)
    cardKey: string;    // FSRSService.makeCardKey(from, san) — only meaningful when hasCard is true
    orientations: Set<'white' | 'black'>; // which repertoire orientations include this edge
}

export interface GraphNode {
    fen: string;        // normalized FEN
    edges: GraphEdge[]; // outgoing edges from this position
}

/**
 * DAG built from PGN variants. Positions are nodes, moves are edges.
 * User-turn edges carry FSRS card keys. Opponent edges are informational only.
 * Transpositions share the same node (via FEN normalization).
 */
export class RepertoireGraph {
    private nodes: Map<string, GraphNode> = new Map();
    private rootFen: string;
    private orientations: Map<string, 'white' | 'black'> = new Map(); // card key → orientation

    constructor(
        pgns: { pgn: string; orientation: 'white' | 'black' }[]
    ) {
        const chess = new Chess();
        this.rootFen = normalizeFenResetHalfmoveClock(chess.fen());
        this.ensureNode(this.rootFen);

        for (const { pgn, orientation } of pgns) {
            this.addPgn(pgn, orientation);
        }
    }

    /**
     * Build a graph directly from the position-centric `repertoires` shape.
     * Each `from` node + SAN gives us the edge; the `to` FEN is derived by
     * replaying the SAN through chess.js (the spec deliberately doesn't
     * persist `to`-FENs so they can't drift). Edges shared between the two
     * orientations are merged on `(from, san, to)` and accumulate both
     * orientations.
     */
    static fromRepertoires(repertoires: RepertoireEntry[]): RepertoireGraph {
        const graph = new RepertoireGraph([]);
        for (const rep of repertoires) {
            for (const [fen, pos] of Object.entries(rep.positions)) {
                graph.ensureNode(fen);
                for (const san of Object.keys(pos.moves)) {
                    // Prefer the denormalized `to` populated by the codec /
                    // PendingEditModel; fall back to chess.js replay for
                    // legacy/test fixtures that hand-rolled MoveEntry as `{}`.
                    let toFen: string;
                    const memoTo = pos.moves[san].to;
                    if (memoTo !== undefined) {
                        toFen = memoTo;
                    } else {
                        try {
                            const chess = new Chess(fen);
                            const move = chess.move(san);
                            if (!move) continue;
                            toFen = normalizeFenResetHalfmoveClock(chess.fen());
                        } catch {
                            continue;
                        }
                    }
                    graph.ensureNode(toFen);
                    const isUserTurn = isUserTurnForOrientation(fen, rep.orientation);
                    const cardKey = FSRSService.makeCardKey(fen, san);
                    const node = graph.nodes.get(fen)!;
                    const existing = node.edges.find(e => e.san === san && e.to === toFen);
                    if (existing) {
                        existing.orientations.add(rep.orientation);
                        if (isUserTurn) existing.hasCard = true;
                    } else {
                        node.edges.push({
                            from: fen,
                            to: toFen,
                            san,
                            hasCard: isUserTurn,
                            cardKey,
                            orientations: new Set([rep.orientation]),
                        });
                    }
                    if (isUserTurn) {
                        graph.orientations.set(cardKey, rep.orientation);
                    }
                }
            }
        }
        return graph;
    }

    getRootFen(): string {
        return this.rootFen;
    }

    getNode(fen: string): GraphNode | undefined {
        return this.nodes.get(fen);
    }

    /**
     * Returns all outgoing edges from the given position.
     * If orientation is provided, only returns edges that belong to that orientation's repertoire.
     */
    getEdges(fen: string, orientation?: 'white' | 'black'): GraphEdge[] {
        const node = this.nodes.get(fen);
        if (!node) return [];
        if (orientation) {
            return node.edges.filter(e => e.orientations.has(orientation));
        }
        return node.edges;
    }

    /**
     * Returns all card keys (for user-turn edges) in the graph.
     */
    getCardKeys(): string[] {
        const keys: string[] = [];
        for (const node of this.nodes.values()) {
            for (const edge of node.edges) {
                if (edge.hasCard) {
                    keys.push(edge.cardKey);
                }
            }
        }
        return [...new Set(keys)];
    }

    /**
     * Returns the orientation for a given card key.
     */
    getOrientationForCard(cardKey: string): 'white' | 'black' {
        return this.orientations.get(cardKey) ?? 'white';
    }

    /**
     * Find all paths from root to a specific edge (fen, move).
     * Returns paths sorted by: shortest first, then most due cards, then random.
     * Each path is an array of edges from root to target.
     * If orientation is provided, only follows edges belonging to that orientation.
     */
    getPathsToEdge(
        targetFen: string,
        targetSan: string,
        isDueCheck?: (cardKey: string) => boolean,
        orientation?: 'white' | 'black'
    ): GraphEdge[][] {
        const results: GraphEdge[][] = [];
        this.dfsPathsToEdge(this.rootFen, targetFen, targetSan, [], new Set(), results, orientation);

        if (isDueCheck && orientation) {
            results.sort((a, b) => {
                // Shortest path first
                if (a.length !== b.length) return a.length - b.length;
                // Most due cards as tiebreak — use orientation-aware check
                // so shared edges are only counted when they're user turns
                // for the current orientation.
                const aDue = a.filter(e => isUserTurnForOrientation(e.from, orientation) && isDueCheck(e.cardKey)).length;
                const bDue = b.filter(e => isUserTurnForOrientation(e.from, orientation) && isDueCheck(e.cardKey)).length;
                return bDue - aDue;
            });
        } else {
            results.sort((a, b) => a.length - b.length);
        }

        return results;
    }

    /**
     * Get the edge for a specific move from a position.
     */
    getEdge(fen: string, san: string): GraphEdge | undefined {
        const node = this.nodes.get(fen);
        if (!node) return undefined;
        return node.edges.find(e => e.san === san);
    }

    /**
     * Find the single best path from root to a specific edge (fen, move), where
     * "best" means the path that crosses the most due user-turn cards (for the
     * given orientation), with shorter length as the tiebreak.
     *
     * Uses a topological-sort DP on the orientation-filtered subgraph reachable
     * from root — runs in O(V + E), with no path-enumeration cap, and always
     * returns the optimum. If a cycle is detected in the reachable subgraph
     * (extremely rare in real repertoires — would require an exact position
     * recurrence), falls back to the bounded `getPathsToEdge` DFS.
     */
    findBestPathToEdge(
        targetFen: string,
        targetSan: string,
        isDueCheck?: (cardKey: string) => boolean,
        orientation?: 'white' | 'black',
    ): GraphEdge[] | null {
        const targetEdge = this.getEdge(targetFen, targetSan);
        if (!targetEdge) return null;
        if (orientation && !targetEdge.orientations.has(orientation)) return null;

        // 1. Find every node reachable from root via orientation-filtered edges.
        const reachable = reachableFrom(
            this.rootFen,
            fen => this.getEdges(fen, orientation).map(e => e.to),
        );
        if (!reachable.has(targetFen)) return null;

        // 2. Compute in-degrees within the reachable subgraph.
        const inDegree = new Map<string, number>();
        for (const fen of reachable) inDegree.set(fen, 0);
        for (const fen of reachable) {
            for (const e of this.getEdges(fen, orientation)) {
                if (reachable.has(e.to)) {
                    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
                }
            }
        }

        // 3. Topological order via Kahn's algorithm. Root should be the only
        // in-degree-0 node in a well-formed repertoire; we seed with all of
        // them defensively.
        const order: string[] = [];
        const ready: string[] = [];
        for (const [fen, d] of inDegree) {
            if (d === 0) ready.push(fen);
        }
        while (ready.length) {
            const fen = ready.shift()!;
            order.push(fen);
            for (const e of this.getEdges(fen, orientation)) {
                if (!reachable.has(e.to)) continue;
                const d = (inDegree.get(e.to) ?? 0) - 1;
                inDegree.set(e.to, d);
                if (d === 0) ready.push(e.to);
            }
        }

        // Cycle detected → fall back to the bounded DFS path enumeration.
        if (order.length !== reachable.size) {
            const paths = this.getPathsToEdge(targetFen, targetSan, isDueCheck, orientation);
            return paths[0] ?? null;
        }

        // 4. DP over topological order. State at each node is the best path
        // from root ending at that node, scored by (dueCount, -pathLen).
        type State = { dueCount: number; pathLen: number; parentEdge: GraphEdge | null };
        const dp = new Map<string, State>();
        dp.set(this.rootFen, { dueCount: 0, pathLen: 0, parentEdge: null });

        for (const fen of order) {
            const cur = dp.get(fen);
            if (!cur) continue;
            const isUserHere = orientation ? isUserTurnForOrientation(fen, orientation) : false;
            for (const e of this.getEdges(fen, orientation)) {
                const edgeDue = (isUserHere && isDueCheck && isDueCheck(e.cardKey)) ? 1 : 0;
                const newDue = cur.dueCount + edgeDue;
                const newLen = cur.pathLen + 1;
                const existing = dp.get(e.to);
                if (!existing
                    || newDue > existing.dueCount
                    || (newDue === existing.dueCount && newLen < existing.pathLen)) {
                    dp.set(e.to, { dueCount: newDue, pathLen: newLen, parentEdge: e });
                }
            }
        }

        // 5. Reconstruct the path by walking parentEdges from targetFen back
        // to the root, then append the target edge.
        const reversed: GraphEdge[] = [];
        let cur = targetFen;
        for (let safety = 0; safety < 10_000; safety++) {
            if (cur === this.rootFen) break;
            const state = dp.get(cur);
            if (!state || !state.parentEdge) return null;
            reversed.push(state.parentEdge);
            cur = state.parentEdge.from;
        }
        if (cur !== this.rootFen) return null;

        reversed.reverse();
        reversed.push(targetEdge);
        return reversed;
    }

    /**
     * Returns all user-turn card keys that are descendants of a given position,
     * useful for determining opponent branch density of due cards.
     * If orientation is provided, only follows edges belonging to that orientation.
     */
    getDescendantCardKeys(fen: string, orientation: 'white' | 'black'): string[] {
        const keys: string[] = [];
        this.collectDescendantCardKeys(fen, keys, orientation);
        return keys;
    }

    /**
     * Returns the total number of positions in the graph.
     */
    get size(): number {
        return this.nodes.size;
    }

    // ─── Private ───────────────────────────────────────────────────────

    private addPgn(pgn: string, orientation: 'white' | 'black'): void {
        const chess = new Chess();
        try {
            chess.loadPgn(pgn);
        } catch {
            console.error('Invalid PGN:', pgn);
            return;
        }
        chess.deleteComments();

        const moves = chess.history({ verbose: true });
        const replay = new Chess();

        for (let i = 0; i < moves.length; i++) {
            const beforeFen = normalizeFenResetHalfmoveClock(replay.fen());
            this.ensureNode(beforeFen);

            const move = moves[i];
            const isWhiteMove = i % 2 === 0;
            const isUserTurn = (orientation === 'white' && isWhiteMove) ||
                               (orientation === 'black' && !isWhiteMove);

            replay.move(move);
            const afterFen = normalizeFenResetHalfmoveClock(replay.fen());
            this.ensureNode(afterFen);

            const cardKey = FSRSService.makeCardKey(beforeFen, move.san);

            // Only add edge if it doesn't already exist; otherwise merge orientation
            const node = this.nodes.get(beforeFen)!;
            const existing = node.edges.find(e => e.san === move.san && e.to === afterFen);
            if (existing) {
                existing.orientations.add(orientation);
                // A shared edge may be a user turn for the new orientation
                // even if it wasn't for the first-loaded one.
                if (isUserTurn) {
                    existing.hasCard = true;
                }
            } else {
                const edge: GraphEdge = {
                    from: beforeFen,
                    to: afterFen,
                    san: move.san,
                    hasCard: isUserTurn,
                    cardKey,
                    orientations: new Set([orientation]),
                };
                node.edges.push(edge);
            }

            if (isUserTurn) {
                this.orientations.set(cardKey, orientation);
            }
        }
    }

    private ensureNode(fen: string): void {
        if (!this.nodes.has(fen)) {
            this.nodes.set(fen, { fen, edges: [] });
        }
    }

    private dfsPathsToEdge(
        currentFen: string,
        targetFen: string,
        targetSan: string,
        path: GraphEdge[],
        visited: Set<string>,
        results: GraphEdge[][],
        orientation?: 'white' | 'black'
    ): void {
        if (results.length >= 10) return; // limit path enumeration
        if (visited.has(currentFen)) return;
        visited.add(currentFen);

        const node = this.nodes.get(currentFen);
        if (!node) { visited.delete(currentFen); return; }

        const edges = orientation
            ? node.edges.filter(e => e.orientations.has(orientation))
            : node.edges;

        for (const edge of edges) {
            if (results.length >= 10) break;
            const newPath = [...path, edge];

            if (edge.from === targetFen && edge.san === targetSan) {
                results.push(newPath);
            }

            // Continue searching deeper (the target could be further along)
            this.dfsPathsToEdge(edge.to, targetFen, targetSan, newPath, visited, results, orientation);
        }

        visited.delete(currentFen);
    }

    private collectDescendantCardKeys(fen: string, keys: string[], orientation: 'white' | 'black'): void {
        forEachReachableEdge<string, GraphEdge>(
            fen,
            current => {
                const node = this.nodes.get(current);
                if (!node) return [];
                const edges = orientation
                    ? node.edges.filter(e => e.orientations.has(orientation))
                    : node.edges;
                return edges.map(edge => ({ from: current, to: edge.to, edge }));
            },
            ref => {
                if (isUserTurnForOrientation(ref.from, orientation)) {
                    keys.push(ref.edge.cardKey);
                }
            },
        );
    }
}
