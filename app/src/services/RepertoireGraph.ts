import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock, isUserTurnForOrientation } from '../utils/FenUtils';
import { FSRSService } from './FSRSService';

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
     * Returns all user-turn card keys that are descendants of a given position,
     * useful for determining opponent branch density of due cards.
     * If orientation is provided, only follows edges belonging to that orientation.
     */
    getDescendantCardKeys(fen: string, orientation: 'white' | 'black'): string[] {
        const keys: string[] = [];
        const visited = new Set<string>();
        this.collectDescendantCardKeys(fen, visited, keys, orientation);
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

    private collectDescendantCardKeys(fen: string, visited: Set<string>, keys: string[], orientation: 'white' | 'black'): void {
        if (visited.has(fen)) return;
        visited.add(fen);

        const node = this.nodes.get(fen);
        if (!node) return;

        const edges = orientation
            ? node.edges.filter(e => e.orientations.has(orientation))
            : node.edges;

        for (const edge of edges) {
            if (isUserTurnForOrientation(edge.from, orientation)) {
                keys.push(edge.cardKey);
            }
            this.collectDescendantCardKeys(edge.to, visited, keys, orientation);
        }
    }
}
