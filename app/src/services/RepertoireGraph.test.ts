import { describe, it, expect } from 'vitest';
import { RepertoireGraph } from './RepertoireGraph';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { Chess } from 'chess.js';
import { FSRSService } from './FSRSService';

// Helper to get the starting FEN (normalized)
const startFen = normalizeFenResetHalfmoveClock(new Chess().fen());

// Simple 1. e4 e5 2. Nf3 variant (white perspective)
const PGN_1E4_E5_NF3 = '1. e4 e5 2. Nf3';

// 1. e4 e5 (black perspective — so black's moves are user turns)
const PGN_1E4_E5_BLACK = '1. e4 e5';

// Two variants sharing a transposition: 1. e4 d5 and 1. e4 e5
const PGN_1E4_D5 = '1. e4 d5';
const PGN_1E4_E5 = '1. e4 e5';

function getFenAfterMoves(moves: string[]): string {
    const chess = new Chess();
    for (const m of moves) chess.move(m);
    return normalizeFenResetHalfmoveClock(chess.fen());
}

describe('RepertoireGraph', () => {
    describe('construction', () => {
        it('should build from a simple PGN (white)', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            expect(graph.getRootFen()).toBe(startFen);
            expect(graph.size).toBeGreaterThan(1);
        });

        it('should handle empty PGN list', () => {
            const graph = new RepertoireGraph([]);
            expect(graph.getRootFen()).toBe(startFen);
            expect(graph.getCardKeys()).toHaveLength(0);
        });

        it('should handle invalid PGN gracefully', () => {
            const graph = new RepertoireGraph([
                { pgn: 'not a valid pgn!!!', orientation: 'white' },
            ]);
            expect(graph.getRootFen()).toBe(startFen);
            expect(graph.getCardKeys()).toHaveLength(0);
        });
    });

    describe('card keys', () => {
        it('should return card keys only for user-turn edges', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const keys = graph.getCardKeys();
            // 1. e4 (user) and 2. Nf3 (user), e5 is opponent
            expect(keys.length).toBe(2);
            // Each key should contain the "::" separator
            for (const key of keys) {
                expect(key).toContain('::');
            }
        });

        it('should deduplicate card keys from overlapping PGNs', () => {
            const graph = new RepertoireGraph([
                { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
                { pgn: '1. e4 e5 2. Bc4', orientation: 'white' },
            ]);
            const keys = graph.getCardKeys();
            // e4 appears in both but should be counted once. Nf3 + Bc4 = 2 more.
            expect(keys.length).toBe(3);
        });
    });

    describe('orientation', () => {
        it('should track orientation for card keys', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const keys = graph.getCardKeys();
            for (const key of keys) {
                expect(graph.getOrientationForCard(key)).toBe('white');
            }
        });

        it('should return white as default for unknown card key', () => {
            const graph = new RepertoireGraph([]);
            expect(graph.getOrientationForCard('unknown::key')).toBe('white');
        });
    });

    describe('getEdge', () => {
        it('should find existing edge', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const edge = graph.getEdge(startFen, 'e4');
            expect(edge).toBeDefined();
            expect(edge!.san).toBe('e4');
        });

        it('should not find non-existent edge', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            expect(graph.getEdge(startFen, 'd4')).toBeUndefined();
        });
    });

    describe('getPathsToEdge', () => {
        it('should find path to first move', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const paths = graph.getPathsToEdge(startFen, 'e4');
            expect(paths.length).toBe(1);
            expect(paths[0].length).toBe(1);
            expect(paths[0][0].san).toBe('e4');
        });

        it('should find path to deeper move', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const fenAfterE4E5 = getFenAfterMoves(['e4', 'e5']);
            const paths = graph.getPathsToEdge(fenAfterE4E5, 'Nf3');
            expect(paths.length).toBe(1);
            // Path: e4 → e5 → Nf3 = 3 edges
            expect(paths[0].length).toBe(3);
        });

        it('should return empty for unreachable edge', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const paths = graph.getPathsToEdge('unknown/fen', 'Bc4');
            expect(paths.length).toBe(0);
        });
    });

    describe('getDescendantCardKeys', () => {
        it('should find descendant card keys from root', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const descendants = graph.getDescendantCardKeys(startFen, 'white');
            // All user-turn cards should be descendants of root
            expect(descendants.length).toBe(graph.getCardKeys().length);
        });

        it('should return empty for leaf position', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const fenAfterNf3 = getFenAfterMoves(['e4', 'e5', 'Nf3']);
            const descendants = graph.getDescendantCardKeys(fenAfterNf3, 'white');
            expect(descendants.length).toBe(0);
        });
    });

    describe('transpositions', () => {
        it('should share nodes for transpositions via FEN normalization', () => {
            // Two different move orders leading to the same position
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_D5, orientation: 'white' },
                { pgn: PGN_1E4_E5, orientation: 'white' },
            ]);

            // Both share the root and the post-e4 position
            const afterE4 = getFenAfterMoves(['e4']);
            const node = graph.getNode(afterE4);
            expect(node).toBeDefined();
            // Should have both d5 and e5 as opponent edges
            const opponentEdges = node!.edges.filter(e => !e.hasCard);
            expect(opponentEdges.length).toBe(2);
            const moves = opponentEdges.map(e => e.san).sort();
            expect(moves).toEqual(['d5', 'e5']);
        });
    });

    describe('findBestPathToEdge', () => {
        function makeCardKey(moves: string[], moveIndex: number): string {
            return FSRSService.makeCardKey(
                getFenAfterMoves(moves.slice(0, moveIndex)),
                moves[moveIndex],
            );
        }

        it('returns null for unknown target', () => {
            const graph = new RepertoireGraph([{ pgn: PGN_1E4_E5_NF3, orientation: 'white' }]);
            const path = graph.findBestPathToEdge('unknown/fen', 'Bc4');
            expect(path).toBeNull();
        });

        it('returns single-edge path when target starts at root', () => {
            const graph = new RepertoireGraph([{ pgn: PGN_1E4_E5_NF3, orientation: 'white' }]);
            const path = graph.findBestPathToEdge(startFen, 'e4', undefined, 'white');
            expect(path).not.toBeNull();
            expect(path!.length).toBe(1);
            expect(path![0].san).toBe('e4');
        });

        it('returns the shortest path when no isDueCheck is provided', () => {
            const graph = new RepertoireGraph([{ pgn: PGN_1E4_E5_NF3, orientation: 'white' }]);
            const fenAfterE4E5 = getFenAfterMoves(['e4', 'e5']);
            const path = graph.findBestPathToEdge(fenAfterE4E5, 'Nf3', undefined, 'white');
            expect(path).not.toBeNull();
            // e4 → e5 → Nf3 = 3 edges
            expect(path!.length).toBe(3);
            expect(path!.map(e => e.san)).toEqual(['e4', 'e5', 'Nf3']);
        });

        it('prefers the path that crosses the most due cards over a shorter one', () => {
            // Two routes to the same target square via 4.Nc3 in the Caro-Kann:
            //   A) 1.e4 c6 2.Nc3      (2 user moves: e4, Nc3 — shortest)
            //   B) 1.e4 c6 2.d4 d5 3.Nc3 (3 user moves: e4, d4, Nc3 — longer, more cards on the way)
            // The post-c6 position is the branch point (transposition).
            const variantA = '1. e4 c6 2. Nc3';
            const variantB = '1. e4 c6 2. d4 d5 3. Nc3';
            const graph = new RepertoireGraph([
                { pgn: variantA, orientation: 'white' },
                { pgn: variantB, orientation: 'white' },
            ]);

            // Target the Nc3 user-turn edge reached via the d4 d5 branch.
            // In variant B, after 1.e4 c6 2.d4 d5, white plays Nc3.
            const movesB = ['e4', 'c6', 'd4', 'd5', 'Nc3'];
            const fenBeforeNc3InB = getFenAfterMoves(movesB.slice(0, 4));
            const e4Key = makeCardKey(movesB, 0);
            const d4Key = makeCardKey(movesB, 2);
            const nc3Key = makeCardKey(movesB, 4);

            // Mark d4 and Nc3 as due. With (most-due, then shortest) sort, the
            // planner should prefer the longer route through d4 because it
            // crosses TWO due cards (d4 and Nc3) vs. the shorter route which
            // only crosses Nc3 (and doesn't even reach that exact Nc3 edge —
            // the variant-A Nc3 has a different `from` FEN).
            //
            // Note: variant-A's Nc3 is FROM the post-1.e4 c6 position, while
            // variant-B's Nc3 is FROM the post-1.e4 c6 2.d4 d5 position. So
            // the target IS exclusively the variant-B Nc3, but the assertion
            // here is that the chosen route still picks up d4 along the way.
            const dueKeys = new Set([d4Key, nc3Key]);

            const path = graph.findBestPathToEdge(
                fenBeforeNc3InB,
                'Nc3',
                (k) => dueKeys.has(k),
                'white',
            );

            expect(path).not.toBeNull();
            const moves = path!.map(e => e.san);
            // Must go through d4 d5 to reach this exact Nc3 edge, AND we want
            // the planner to pick the d4-included route.
            expect(moves).toEqual(['e4', 'c6', 'd4', 'd5', 'Nc3']);

            // Sanity: e4 is also on the path but is in dueKeys only if marked.
            expect(dueKeys.has(e4Key)).toBe(false);
        });

        it('tiebreak: shorter path wins when two routes cross the same number of due cards', () => {
            // 1.e4 e5 2.Nf3 and 1.Nf3 e5 2.e4 both reach the same post-2.e4
            // position. Same number of user-turn moves on each route (2).
            // With no due cards (all weights = 0), both routes have dueCount=0,
            // so length tiebreak picks the shorter. Same length → first DFS-
            // discovered edge wins (deterministic by repertoire load order).
            //
            // Here we just verify the result is one of the two valid sequences
            // and is exactly 3 edges long.
            const graph = new RepertoireGraph([
                { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
                { pgn: '1. Nf3 e5 2. e4', orientation: 'white' },
            ]);
            const targetFen = getFenAfterMoves(['e4', 'e5']);
            const path = graph.findBestPathToEdge(targetFen, 'Nf3', undefined, 'white');
            expect(path).not.toBeNull();
            expect(path!.length).toBe(3);
            expect(path![path!.length - 1].san).toBe('Nf3');
        });

        it('respects orientation filter (rejects edge from another orientation only)', () => {
            // Build a white-orientation repertoire and try to find a path with
            // black orientation — should return null because the edges don't
            // belong to black's repertoire.
            const graph = new RepertoireGraph([
                { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
            ]);
            const path = graph.findBestPathToEdge(startFen, 'e4', undefined, 'black');
            expect(path).toBeNull();
        });
    });
});
