import { describe, it, expect, vi } from 'vitest';
import {
    MastersLookup,
    fetchMastersOutcome,
    classifyOutOfTheory,
    toMastersCacheKey,
    MIN_MASTER_GAMES,
    MIN_MOVE_PERCENTAGE,
} from './MastersExplorerService';

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
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
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
                    { san: 'a3', white: 2, draws: 1, black: 1, total: 4 },
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
                    { san: 'b3', white: 3, draws: 2, black: 3, total: 8 },
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
                    { san: 'c3', white: 2, draws: 2, black: 1, total: 5 },
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
                    { san: 'd6', white: 30, draws: 10, black: 10, total: 50 },
                ],
            });
            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'd6')).toBe(false);
        });

        it('returns true when move has 49 games with low percentage (just below absolute threshold)', () => {
            const lookup = new MastersLookup();
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 10000,
                moves: [
                    { san: 'e4', white: 5000, draws: 2000, black: 2951, total: 9951 },
                    { san: 'a3', white: 20, draws: 15, black: 14, total: 49 },
                ],
            });
            expect(lookup.isOutOfTheory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'a3')).toBe(true);
        });
    });

    describe('size', () => {
        it('reports size correctly', () => {
            const lookup = new MastersLookup();
            expect(lookup.size).toBe(0);
            lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                totalGames: 100,
                moves: [{ san: 'e4', white: 50, draws: 30, black: 20, total: 100 }],
            });
            expect(lookup.size).toBe(1);
        });
    });
});

describe('classifyOutOfTheory', () => {
    it('returns null for null stats', () => {
        expect(classifyOutOfTheory(null)).toBeNull();
    });
    it('returns false when moveGames >= MIN_MASTER_GAMES_ABSOLUTE (50)', () => {
        expect(classifyOutOfTheory({ moveGames: 50, totalGames: 10000, percentage: 0.5 })).toBe(false);
    });
    it('returns true when moveGames < MIN_MASTER_GAMES', () => {
        expect(classifyOutOfTheory({ moveGames: 4, totalGames: 100, percentage: 4 })).toBe(true);
    });
    it('returns true when percentage < MIN_MOVE_PERCENTAGE despite enough moveGames', () => {
        expect(classifyOutOfTheory({ moveGames: 10, totalGames: 1000, percentage: 1 })).toBe(true);
    });
    it('returns false when moveGames >= MIN_MASTER_GAMES and percentage >= MIN_MOVE_PERCENTAGE', () => {
        expect(classifyOutOfTheory({ moveGames: 10, totalGames: 100, percentage: 10 })).toBe(false);
    });
});

describe('toMastersCacheKey', () => {
    it('strips halfmove and fullmove counters', () => {
        expect(toMastersCacheKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))
            .toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
        expect(toMastersCacheKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 10'))
            .toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
    });
});

describe('fetchMastersOutcome', () => {
    it('returns kind=ok with parsed result on success', async () => {
        const mockFetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ moves: [{ san: 'e4', white: 1, draws: 2, black: 3 }] }),
        })) as unknown as typeof fetch;
        const outcome = await fetchMastersOutcome(
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 5',
            'token',
            mockFetch,
        );
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') {
            expect(outcome.result.moves[0].san).toBe('e4');
        }
    });

    it('parses per-move totals (white + draws + black) and aggregate totalGames', async () => {
        const mockFetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                moves: [
                    { san: 'c4', white: 25, draws: 40, black: 15 },
                    { san: 'c3', white: 0, draws: 5, black: 5 },
                ],
            }),
        })) as unknown as typeof fetch;
        const outcome = await fetchMastersOutcome(
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            'token',
            mockFetch,
        );
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') {
            expect(outcome.result.totalGames).toBe(90);
            expect(outcome.result.moves).toHaveLength(2);
            expect(outcome.result.moves[0].total).toBe(80);
            expect(outcome.result.moves[1].total).toBe(10);
        }
    });

    it('passes Authorization header with token', async () => {
        const mockFetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ moves: [] }),
        })) as unknown as typeof fetch;

        await fetchMastersOutcome(
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2',
            'my-token-123',
            mockFetch,
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const callArgs = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(callArgs[1]).toEqual(expect.objectContaining({
            headers: { 'Authorization': 'Bearer my-token-123' },
        }));
    });

    it('returns kind=error on non-ok response (distinct from no-data)', async () => {
        const mockFetch = vi.fn(() => Promise.resolve({ ok: false, status: 429 })) as unknown as typeof fetch;
        const outcome = await fetchMastersOutcome(
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 6',
            'token',
            mockFetch,
        );
        expect(outcome.kind).toBe('error');
    });

    it('returns kind=error on network error', async () => {
        const mockFetch = vi.fn(() => Promise.reject(new Error('Network error'))) as unknown as typeof fetch;
        const outcome = await fetchMastersOutcome(
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 7',
            'token',
            mockFetch,
        );
        expect(outcome.kind).toBe('error');
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
