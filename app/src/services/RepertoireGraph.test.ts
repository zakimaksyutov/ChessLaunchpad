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
            const descendants = graph.getDescendantCardKeys(startFen);
            // All user-turn cards should be descendants of root
            expect(descendants.length).toBe(graph.getCardKeys().length);
        });

        it('should return empty for leaf position', () => {
            const graph = new RepertoireGraph([
                { pgn: PGN_1E4_E5_NF3, orientation: 'white' },
            ]);
            const fenAfterNf3 = getFenAfterMoves(['e4', 'e5', 'Nf3']);
            const descendants = graph.getDescendantCardKeys(fenAfterNf3);
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
            const opponentEdges = node!.edges.filter(e => !e.isUserTurn);
            expect(opponentEdges.length).toBe(2);
            const moves = opponentEdges.map(e => e.san).sort();
            expect(moves).toEqual(['d5', 'e5']);
        });
    });
});
