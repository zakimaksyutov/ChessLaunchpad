import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    MastersLookup,
    MastersCache,
    fetchMastersPosition,
    resetMastersPageBudget,
    MIN_MASTER_GAMES,
    MIN_MOVE_PERCENTAGE,
} from './MastersExplorerService';

// Mock IDB cursor for getAllPersistedMasters and bulk operations
let mockStore: Record<string, unknown> = {};

const createMockCursor = (entries: [string, unknown][]) => {
    let index = 0;
    const cursor = {
        get key() { return entries[index]?.[0]; },
        get value() { return entries[index]?.[1]; },
        continue: vi.fn(() => {
            index++;
            return index < entries.length ? Promise.resolve(cursor) : Promise.resolve(null);
        }),
    };
    return entries.length > 0 ? cursor : null;
};

vi.mock('idb', () => ({
    openDB: vi.fn(() => {
        const store = {
            get: vi.fn((key: string) => Promise.resolve(mockStore[key])),
            put: vi.fn((value: unknown, key: string) => {
                mockStore[key] = value;
                return Promise.resolve();
            }),
            delete: vi.fn((key: string) => {
                delete mockStore[key];
                return Promise.resolve();
            }),
            openCursor: vi.fn(() => {
                const entries = Object.entries(mockStore);
                return Promise.resolve(createMockCursor(entries));
            }),
        };
        return Promise.resolve({
            get: store.get,
            put: store.put,
            clear: vi.fn(() => {
                mockStore = {};
                return Promise.resolve();
            }),
            transaction: vi.fn(() => ({
                store,
                done: Promise.resolve(),
            })),
        });
    }),
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

        it('returns false when move has >= MIN_MASTER_GAMES_ABSOLUTE games even with low percentage', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 10000,
                moves: [
                    { san: 'e4', white: 5000, draws: 2000, black: 2900, total: 9900 },
                    { san: 'd6', white: 30, draws: 10, black: 10, total: 50 }, // 50 games, 0.5%
                ],
            });

            // 50 games >= MIN_MASTER_GAMES_ABSOLUTE → in theory despite 0.5% share
            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'd6')).toBe(false);
        });

        it('returns true when move has 49 games with low percentage (just below absolute threshold)', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 10000,
                moves: [
                    { san: 'e4', white: 5000, draws: 2000, black: 2951, total: 9951 },
                    { san: 'a3', white: 20, draws: 15, black: 14, total: 49 }, // 49 games, 0.49%
                ],
            });

            // 49 games < MIN_MASTER_GAMES_ABSOLUTE and 0.49% < MIN_MOVE_PERCENTAGE → out of theory
            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'a3')).toBe(true);
        });
    });
});

describe('fetchMastersPosition', () => {
    beforeEach(() => {
        mockStore = {};
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

describe('MastersCache', () => {
    beforeEach(() => {
        mockStore = {};
        resetMastersPageBudget();
    });

    describe('loadAll', () => {
        it('loads empty cache when DB is empty', async () => {
            const cache = await MastersCache.loadAll();
            expect(cache.size).toBe(0);
        });

        it('loads all positions from DB with hitCount=0', async () => {
            const position = {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };
            mockStore['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'] = position;

            const cache = await MastersCache.loadAll();
            expect(cache.size).toBe(1);
        });
    });

    describe('getMoveStats', () => {
        it('returns null for unknown position', async () => {
            const cache = await MastersCache.loadAll();
            expect(cache.getMoveStats('unknown/fen w KQkq - 0 1', 'e4')).toBeNull();
        });

        it('returns stats and increments hitCount for known position', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };

            const cache = await MastersCache.loadAll();
            const stats = cache.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4');
            expect(stats).not.toBeNull();
            expect(stats!.moveGames).toBe(100);
            expect(stats!.percentage).toBe(100);

            // Position won't be purged since hitCount > 0
            const purged = await cache.purgeUnused();
            expect(purged).toBe(0);
        });
    });

    describe('isOutOfTheory', () => {
        it('returns null for unknown position', async () => {
            const cache = await MastersCache.loadAll();
            expect(cache.isOutOfTheory('unknown/fen w KQkq - 0 1', 'e4')).toBeNull();
        });

        it('returns true for rare move', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 200,
                moves: [
                    { san: 'e4', white: 100, draws: 50, black: 46, total: 196 },
                    { san: 'h3', white: 2, draws: 1, black: 1, total: 4 },
                ],
            };

            const cache = await MastersCache.loadAll();
            expect(cache.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'h3')).toBe(true);
        });

        it('returns false when move has >= MIN_MASTER_GAMES_ABSOLUTE games despite low percentage', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 10000,
                moves: [
                    { san: 'e4', white: 5000, draws: 2000, black: 2950, total: 9950 },
                    { san: 'd6', white: 20, draws: 15, black: 15, total: 50 }, // 50 games, 0.5%
                ],
            };

            const cache = await MastersCache.loadAll();
            expect(cache.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'd6')).toBe(false);
        });
    });

    describe('has', () => {
        it('returns false for uncached position', async () => {
            const cache = await MastersCache.loadAll();
            expect(cache.has('unknown/fen w KQkq - 0 1')).toBe(false);
        });

        it('returns true for cached position without incrementing hitCount', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };

            const cache = await MastersCache.loadAll();
            expect(cache.has('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(true);

            // has() does NOT increment hitCount, so position should be purged
            const purged = await cache.purgeUnused();
            expect(purged).toBe(1);
        });
    });

    describe('fetchOrGet', () => {
        it('returns cached position and increments hitCount', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };

            const cache = await MastersCache.loadAll();
            const mockFetch = vi.fn() as unknown as typeof fetch;

            const result = await cache.fetchOrGet(
                'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                'token',
                mockFetch
            );

            expect(result).not.toBeNull();
            expect(result!.totalGames).toBe(100);
            expect(mockFetch).not.toHaveBeenCalled();

            // hitCount > 0, won't be purged
            const purged = await cache.purgeUnused();
            expect(purged).toBe(0);
        });

        it('fetches from API when not cached and stores with hitCount=1', async () => {
            const cache = await MastersCache.loadAll();
            const mockFetch = vi.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    moves: [{ san: 'Nf3', white: 10, draws: 5, black: 5 }],
                }),
            })) as unknown as typeof fetch;

            const result = await cache.fetchOrGet(
                'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
                'token',
                mockFetch
            );

            expect(result).not.toBeNull();
            expect(result!.moves[0].san).toBe('Nf3');
            expect(cache.size).toBe(1);

            // hitCount=1, won't be purged
            const purged = await cache.purgeUnused();
            expect(purged).toBe(0);
        });
    });

    describe('resetHitCounts', () => {
        it('resets all counts to 0', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };

            const cache = await MastersCache.loadAll();

            // Access to increment hitCount
            cache.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4');

            // Reset
            cache.resetHitCounts();

            // Now purge should remove it
            const purged = await cache.purgeUnused();
            expect(purged).toBe(1);
            expect(cache.size).toBe(0);
        });
    });

    describe('purgeUnused', () => {
        it('deletes positions with hitCount=0 and keeps those with hitCount>0', async () => {
            const key1 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            const key2 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
            mockStore[key1] = {
                fen: key1,
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };
            mockStore[key2] = {
                fen: key2,
                totalGames: 80,
                moves: [{ san: 'e5', white: 40, draws: 20, black: 20, total: 80 }],
            };

            const cache = await MastersCache.loadAll();
            expect(cache.size).toBe(2);

            // Access only position 1
            cache.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4');

            // Purge — should delete position 2 (hitCount=0)
            const purged = await cache.purgeUnused();
            expect(purged).toBe(1);
            expect(cache.size).toBe(1);
            expect(cache.has('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(true);
            expect(cache.has('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe(false);
        });

        it('returns 0 when all positions have been accessed', async () => {
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
            mockStore[key] = {
                fen: key,
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            };

            const cache = await MastersCache.loadAll();
            cache.getMoveStats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e4');

            const purged = await cache.purgeUnused();
            expect(purged).toBe(0);
            expect(cache.size).toBe(1);
        });
    });
});
