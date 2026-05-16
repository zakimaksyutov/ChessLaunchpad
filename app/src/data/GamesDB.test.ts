import { describe, it, expect, vi, beforeEach } from 'vitest';
import { groomGames, storeGames, getAllGames, clearGames, updateAnnotations, clearAnnotation, StoredGame } from './GamesDB';

// Mock idb with a simple in-memory store
let store: Map<string, StoredGame>;

vi.mock('idb', () => {
    return {
        openDB: vi.fn(() => {
            const getAll = () => {
                const arr = Array.from(store.values());
                arr.sort((a, b) => a.createdAt - b.createdAt);
                return arr;
            };

            const mockStore = {
                put: vi.fn((value: StoredGame) => {
                    store.set(value.id, value);
                    return Promise.resolve();
                }),
                get: vi.fn((id: string) => {
                    return Promise.resolve(store.get(id));
                }),
                delete: vi.fn((id: string) => {
                    store.delete(id);
                    return Promise.resolve();
                }),
                clear: vi.fn(() => {
                    store.clear();
                    return Promise.resolve();
                }),
                index: vi.fn(() => ({
                    openCursor: vi.fn(() => null),
                    getAll: getAll,
                })),
                count: vi.fn(() => store.size),
            };

            return Promise.resolve({
                transaction: vi.fn(() => ({
                    store: mockStore,
                    done: Promise.resolve(),
                })),
                put: vi.fn((storeName: string, value: StoredGame) => {
                    store.set(value.id, value);
                    return Promise.resolve();
                }),
                get: vi.fn((_storeName: string, key: string) => {
                    return Promise.resolve(store.get(key));
                }),
                getAll: vi.fn(() => {
                    return Promise.resolve(Array.from(store.values()));
                }),
                getAllFromIndex: vi.fn((_storeName: string, indexName: string) => {
                    const arr = Array.from(store.values());
                    if (indexName === 'createdAt') {
                        arr.sort((a, b) => a.createdAt - b.createdAt);
                    }
                    return Promise.resolve(arr);
                }),
                count: vi.fn(() => Promise.resolve(store.size)),
                clear: vi.fn(() => {
                    store.clear();
                    return Promise.resolve();
                }),
                objectStoreNames: { contains: () => true },
            });
        }),
    };
});

function makeGame(id: string, createdAt: number, username: string, platform: 'lichess' | 'chess.com' = 'lichess'): StoredGame {
    return { id, createdAt, username, platform, data: {} };
}

describe('groomGames', () => {
    beforeEach(() => {
        store = new Map();
    });

    it('does nothing when games are within maxKeep', async () => {
        await storeGames([
            makeGame('g1', 1000, 'alice'),
            makeGame('g2', 2000, 'alice'),
        ]);

        const result = await groomGames(5);
        expect(result.deletedCount).toBe(0);
        expect(result.deletedMaxTimestamps.size).toBe(0);

        const remaining = await getAllGames();
        expect(remaining).toHaveLength(2);
    });

    it('keeps only top maxKeep games by createdAt desc', async () => {
        await storeGames([
            makeGame('g1', 1000, 'alice'),
            makeGame('g2', 2000, 'alice'),
            makeGame('g3', 3000, 'alice'),
            makeGame('g4', 4000, 'bob'),
            makeGame('g5', 5000, 'bob'),
        ]);

        const result = await groomGames(3);
        expect(result.deletedCount).toBe(2);

        const remaining = await getAllGames();
        expect(remaining).toHaveLength(3);
        // Should keep the 3 newest: g5 (5000), g4 (4000), g3 (3000)
        const ids = remaining.map(g => g.id);
        expect(ids).toContain('g5');
        expect(ids).toContain('g4');
        expect(ids).toContain('g3');
        expect(ids).not.toContain('g1');
        expect(ids).not.toContain('g2');
    });

    it('returns correct deletedMaxTimestamps per account', async () => {
        await storeGames([
            makeGame('g1', 1000, 'alice', 'lichess'),
            makeGame('g2', 2000, 'bob', 'chess.com'),
            makeGame('g3', 3000, 'alice', 'lichess'),
            makeGame('g4', 4000, 'bob', 'chess.com'),
            makeGame('g5', 5000, 'alice', 'lichess'),
        ]);

        // Keep top 2: g5 (alice, 5000) and g4 (bob, 4000)
        const result = await groomGames(2);
        expect(result.deletedCount).toBe(3);

        // Deleted: g1 (alice, 1000), g2 (bob, 2000), g3 (alice, 3000)
        expect(result.deletedMaxTimestamps.get('lichess:alice')).toBe(3000);
        expect(result.deletedMaxTimestamps.get('chess.com:bob')).toBe(2000);
    });

    it('handles maxKeep of 0 by deleting everything', async () => {
        await storeGames([
            makeGame('g1', 1000, 'alice'),
            makeGame('g2', 2000, 'alice'),
        ]);

        const result = await groomGames(0);
        expect(result.deletedCount).toBe(2);
        expect(result.deletedMaxTimestamps.get('lichess:alice')).toBe(2000);

        const remaining = await getAllGames();
        expect(remaining).toHaveLength(0);
    });

    it('defaults platform to lichess when not set', async () => {
        const game: StoredGame = { id: 'g1', createdAt: 1000, username: 'alice', data: {} };
        await storeGames([game, makeGame('g2', 2000, 'bob')]);

        const result = await groomGames(1);
        expect(result.deletedCount).toBe(1);
        // g1 has no platform field, defaults to 'lichess'
        expect(result.deletedMaxTimestamps.get('lichess:alice')).toBe(1000);
    });
});

const mockAnnotation = {
    moves: [{ san: 'e4', isWhiteMove: true, isUserMove: true, highlight: 'in-repertoire' as const }],
    miniBoardFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    miniBoardOrientation: 'white' as const,
};

describe('updateAnnotations', () => {
    beforeEach(() => {
        store = new Map();
    });

    it('patches annotation on existing games', async () => {
        await storeGames([makeGame('g1', 1000, 'alice'), makeGame('g2', 2000, 'bob')]);

        await updateAnnotations([
            { id: 'g1', annotation: mockAnnotation },
        ]);

        const games = await getAllGames();
        const g1 = games.find(g => g.id === 'g1')!;
        const g2 = games.find(g => g.id === 'g2')!;

        expect(g1.annotation).toEqual(mockAnnotation);
        expect('annotation' in g2).toBe(false);
    });

    it('handles empty updates array', async () => {
        await storeGames([makeGame('g1', 1000, 'alice')]);
        await updateAnnotations([]);

        const games = await getAllGames();
        expect('annotation' in games[0]).toBe(false);
    });

    it('skips non-existent game IDs', async () => {
        await storeGames([makeGame('g1', 1000, 'alice')]);
        await updateAnnotations([{ id: 'nonexistent', annotation: mockAnnotation }]);

        const games = await getAllGames();
        expect(games).toHaveLength(1);
        expect('annotation' in games[0]).toBe(false);
    });

    it('can store null annotation', async () => {
        await storeGames([makeGame('g1', 1000, 'alice')]);
        await updateAnnotations([{ id: 'g1', annotation: null }]);

        const games = await getAllGames();
        expect(games[0].annotation).toBeNull();
        expect('annotation' in games[0]).toBe(true);
    });
});

describe('clearAnnotation', () => {
    beforeEach(() => {
        store = new Map();
    });

    it('removes annotation from a game', async () => {
        const game = makeGame('g1', 1000, 'alice');
        game.annotation = mockAnnotation;
        await storeGames([game]);

        const result = await clearAnnotation('g1');
        expect(result).toBe(true);

        const games = await getAllGames();
        expect('annotation' in games[0]).toBe(false);
    });

    it('returns false for non-existent game', async () => {
        const result = await clearAnnotation('nonexistent');
        expect(result).toBe(false);
    });
});
