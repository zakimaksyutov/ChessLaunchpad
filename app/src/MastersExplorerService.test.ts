import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    MastersLookup,
    fetchMastersPosition,
    resetMastersPageBudget,
    MIN_MASTER_GAMES,
    MIN_MOVE_PERCENTAGE,
} from './MastersExplorerService';

// Mock IDB to avoid real IndexedDB in tests
vi.mock('idb', () => ({
    openDB: vi.fn(() => Promise.resolve({
        get: vi.fn(() => Promise.resolve(undefined)),
        put: vi.fn(() => Promise.resolve()),
    })),
}));

describe('MastersLookup', () => {
    describe('getMoveStats', () => {
        it('returns null for unknown position', () => {
            const lookup = new MastersLookup();
            expect(lookup.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4')).toBeNull();
        });

        it('returns stats for a known position and move', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [
                    { san: 'e4', white: 30, draws: 10, black: 10, total: 50 },
                    { san: 'd4', white: 20, draws: 15, black: 15, total: 50 },
                ],
            });

            const stats = lookup.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4');
            expect(stats).not.toBeNull();
            expect(stats!.moveGames).toBe(50);
            expect(stats!.totalGames).toBe(100);
            expect(stats!.percentage).toBe(50);
        });

        it('returns 0 games for a move not played in the position', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [
                    { san: 'e4', white: 50, draws: 30, black: 20, total: 100 },
                ],
            });

            const stats = lookup.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'a3');
            expect(stats).not.toBeNull();
            expect(stats!.moveGames).toBe(0);
            expect(stats!.percentage).toBe(0);
        });

        it('matches by compact FEN (ignores halfmove clock and fullmove number)', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            });

            // Same position with different move numbers should match
            const stats = lookup.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 10', 'e4');
            expect(stats).not.toBeNull();
            expect(stats!.moveGames).toBe(100);
        });
    });

    describe('isOutOfTheory', () => {
        it('returns null for unknown position', () => {
            const lookup = new MastersLookup();
            expect(lookup.isOutOfTheory('some/fen w KQkq - 0 1', 'e4')).toBeNull();
        });

        it('returns true when move has fewer than MIN_MASTER_GAMES', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 200,
                moves: [
                    { san: 'e4', white: 100, draws: 50, black: 50, total: 200 },
                    { san: 'a3', white: 2, draws: 1, black: 1, total: 4 }, // < 5 games
                ],
            });

            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'a3')).toBe(true);
        });

        it('returns true when move percentage is below MIN_MOVE_PERCENTAGE', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 200,
                moves: [
                    { san: 'e4', white: 100, draws: 50, black: 42, total: 192 },
                    { san: 'b3', white: 3, draws: 2, black: 3, total: 8 }, // 8/200 = 4% < 5%
                ],
            });

            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'b3')).toBe(true);
        });

        it('returns true when move has 0 games (not in response at all)', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            });

            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'h4')).toBe(true);
        });

        it('returns false when move has enough games and percentage', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [
                    { san: 'e4', white: 30, draws: 10, black: 10, total: 50 },
                    { san: 'd4', white: 20, draws: 15, black: 15, total: 50 },
                ],
            });

            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4')).toBe(false);
        });

        it('returns false when move has exactly MIN_MASTER_GAMES and exactly MIN_MOVE_PERCENTAGE', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [
                    { san: 'e4', white: 90, draws: 5, black: 0, total: 95 },
                    { san: 'c3', white: 2, draws: 2, black: 1, total: 5 }, // exactly 5 games, 5%
                ],
            });

            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'c3')).toBe(false);
        });
    });
});

describe('fetchMastersPosition', () => {
    beforeEach(() => {
        resetMastersPageBudget();
    });

    it('parses API response correctly', async () => {
        const mockResponse = {
            ok: true,
            json: () => Promise.resolve({
                white: 30,
                draws: 50,
                black: 20,
                moves: [
                    { san: 'c4', white: 25, draws: 40, black: 15 },
                    { san: 'c3', white: 0, draws: 5, black: 5 },
                ],
            }),
        };
        const mockFetch = vi.fn(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

        const result = await fetchMastersPosition(
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            'test-token',
            mockFetch
        );

        expect(result).not.toBeNull();
        expect(result!.totalGames).toBe(90); // 80 + 10
        expect(result!.moves).toHaveLength(2);
        expect(result!.moves[0].san).toBe('c4');
        expect(result!.moves[0].total).toBe(80);
        expect(result!.moves[1].san).toBe('c3');
        expect(result!.moves[1].total).toBe(10);
    });

    it('passes Authorization header with token', async () => {
        const mockFetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ moves: [] }),
        })) as unknown as typeof fetch;

        // Use a unique FEN that won't be cached from the previous test
        await fetchMastersPosition(
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
            'my-token-123',
            mockFetch
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const callArgs = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(callArgs[1]).toEqual(expect.objectContaining({
            headers: { 'Authorization': 'Bearer my-token-123' },
        }));
    });

    it('returns null on non-ok response', async () => {
        const mockFetch = vi.fn(() => Promise.resolve({
            ok: false,
            status: 429,
        })) as unknown as typeof fetch;

        // Use a unique FEN
        const result = await fetchMastersPosition(
            'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
            'token',
            mockFetch
        );

        expect(result).toBeNull();
    });

    it('returns null on fetch error', async () => {
        const mockFetch = vi.fn(() => Promise.reject(new Error('Network error'))) as unknown as typeof fetch;

        // Use a unique FEN
        const result = await fetchMastersPosition(
            'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1',
            'token',
            mockFetch
        );

        expect(result).toBeNull();
    });
});

describe('constants', () => {
    it('MIN_MASTER_GAMES is 5', () => {
        expect(MIN_MASTER_GAMES).toBe(5);
    });

    it('MIN_MOVE_PERCENTAGE is 5', () => {
        expect(MIN_MOVE_PERCENTAGE).toBe(5);
    });
});
