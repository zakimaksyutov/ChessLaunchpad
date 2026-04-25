import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    fetchMastersExplorer,
    computePercentages,
    formatGameCount,
    clearMastersCache,
    fetchMastersExplorerCached,
} from './LichessMastersService';

beforeEach(() => {
    clearMastersCache();
});

describe('computePercentages', () => {
    it('computes correct percentages', () => {
        const result = computePercentages(52, 30, 18);
        expect(result.whitePercent).toBe(52);
        expect(result.drawPercent).toBe(30);
        expect(result.blackPercent).toBe(18);
    });

    it('returns zeros when total is 0', () => {
        const result = computePercentages(0, 0, 0);
        expect(result.whitePercent).toBe(0);
        expect(result.drawPercent).toBe(0);
        expect(result.blackPercent).toBe(0);
    });

    it('rounds to nearest integer', () => {
        const result = computePercentages(1, 1, 1);
        expect(result.whitePercent).toBe(33);
        expect(result.drawPercent).toBe(33);
        expect(result.blackPercent).toBe(33);
    });
});

describe('formatGameCount', () => {
    it('formats small numbers', () => {
        expect(formatGameCount(42)).toBe('42');
    });

    it('formats large numbers with separators', () => {
        const formatted = formatGameCount(12345);
        // toLocaleString output varies by locale, but should contain digits
        expect(formatted).toMatch(/12.?345/);
    });
});

describe('fetchMastersExplorer', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const token = 'test-token';

    it('parses response and sorts by total games', async () => {
        const mockResponse = {
            white: 10000,
            draws: 8000,
            black: 7000,
            moves: [
                { uci: 'e2e4', san: 'e4', white: 3000, draws: 2500, black: 2000, averageRating: 2650 },
                { uci: 'd2d4', san: 'd4', white: 4000, draws: 3000, black: 2500, averageRating: 2680 },
                { uci: 'g1f3', san: 'Nf3', white: 1000, draws: 800, black: 500, averageRating: 2620 },
            ],
        };

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        });

        const result = await fetchMastersExplorer(startFen, token, mockFetch as any);

        expect(result).not.toBeNull();
        expect(result!.totalGames).toBe(25000);
        expect(result!.moves).toHaveLength(3);
        // Sorted by totalGames descending: d4 (9500), e4 (7500), Nf3 (2300)
        expect(result!.moves[0].san).toBe('d4');
        expect(result!.moves[0].totalGames).toBe(9500);
        expect(result!.moves[1].san).toBe('e4');
        expect(result!.moves[1].totalGames).toBe(7500);
        expect(result!.moves[2].san).toBe('Nf3');
        expect(result!.moves[2].totalGames).toBe(2300);
    });

    it('computes percentages correctly', async () => {
        const mockResponse = {
            white: 100, draws: 100, black: 100,
            moves: [
                { uci: 'e2e4', san: 'e4', white: 60, draws: 25, black: 15, averageRating: 2600 },
            ],
        };

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        });

        const result = await fetchMastersExplorer(startFen, token, mockFetch as any);
        const move = result!.moves[0];
        expect(move.whitePercent).toBe(60);
        expect(move.drawPercent).toBe(25);
        expect(move.blackPercent).toBe(15);
    });

    it('sends Authorization header', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ moves: [] }),
        });

        await fetchMastersExplorer(startFen, token, mockFetch as any);

        expect(mockFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: { Authorization: 'Bearer test-token' },
            })
        );
    });

    it('returns null on 401', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
        const result = await fetchMastersExplorer(startFen, token, mockFetch as any);
        expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('network'));
        const result = await fetchMastersExplorer(startFen, token, mockFetch as any);
        expect(result).toBeNull();
    });

    it('handles empty moves array', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ white: 0, draws: 0, black: 0, moves: [] }),
        });

        const result = await fetchMastersExplorer(startFen, token, mockFetch as any);
        expect(result).not.toBeNull();
        expect(result!.moves).toHaveLength(0);
        expect(result!.totalGames).toBe(0);
    });

    it('handles missing fields gracefully', async () => {
        const mockResponse = {
            moves: [
                { uci: 'e2e4', san: 'e4' },
            ],
        };

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        });

        const result = await fetchMastersExplorer(startFen, token, mockFetch as any);
        expect(result).not.toBeNull();
        const move = result!.moves[0];
        expect(move.white).toBe(0);
        expect(move.draws).toBe(0);
        expect(move.black).toBe(0);
        expect(move.averageRating).toBe(0);
    });
});

describe('fetchMastersExplorerCached', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const token = 'test-token';

    it('caches successful results', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ white: 1, draws: 1, black: 1, moves: [] }),
        });

        const r1 = await fetchMastersExplorerCached(startFen, token, mockFetch as any);
        const r2 = await fetchMastersExplorerCached(startFen, token, mockFetch as any);
        expect(r1).toBe(r2);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache failures', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ white: 1, draws: 1, black: 1, moves: [] }),
            });

        const r1 = await fetchMastersExplorerCached(startFen, token, mockFetch as any);
        expect(r1).toBeNull();
        const r2 = await fetchMastersExplorerCached(startFen, token, mockFetch as any);
        expect(r2).not.toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
