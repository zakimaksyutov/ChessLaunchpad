import { describe, it, expect, vi } from 'vitest';
import {
    uciToSan,
    uciLineToSan,
    formatEval,
    formatMoveWithNumber,
    fetchCloudEval,
} from './LichessCloudEvalService';

describe('uciToSan', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    it('converts e2e4 from starting position', () => {
        expect(uciToSan(startFen, 'e2e4')).toBe('e4');
    });

    it('converts g1f3 from starting position', () => {
        expect(uciToSan(startFen, 'g1f3')).toBe('Nf3');
    });

    it('converts promotion move', () => {
        const fen = '8/P7/8/8/8/8/8/4K2k w - - 0 1';
        expect(uciToSan(fen, 'a7a8q')).toBe('a8=Q+');
    });

    it('returns null for illegal move', () => {
        expect(uciToSan(startFen, 'e2e5')).toBeNull();
    });

    it('returns null for invalid FEN', () => {
        expect(uciToSan('invalid', 'e2e4')).toBeNull();
    });
});

describe('uciLineToSan', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    it('converts a sequence of UCI moves', () => {
        const result = uciLineToSan(startFen, ['e2e4', 'd7d5', 'e4d5']);
        expect(result).toEqual(['e4', 'd5', 'exd5']);
    });

    it('stops at illegal move', () => {
        const result = uciLineToSan(startFen, ['e2e4', 'e7e5', 'a1a8']);
        expect(result).toEqual(['e4', 'e5']);
    });

    it('returns empty array for empty input', () => {
        expect(uciLineToSan(startFen, [])).toEqual([]);
    });
});

describe('formatEval', () => {
    it('formats positive centipawns', () => {
        expect(formatEval(35, null)).toBe('+0.35');
    });

    it('formats negative centipawns', () => {
        expect(formatEval(-120, null)).toBe('-1.20');
    });

    it('formats zero centipawns', () => {
        expect(formatEval(0, null)).toBe('+0.00');
    });

    it('formats positive mate', () => {
        expect(formatEval(null, 3)).toBe('M3');
    });

    it('formats negative mate', () => {
        expect(formatEval(null, -5)).toBe('-M5');
    });

    it('mate takes precedence over cp', () => {
        expect(formatEval(100, 2)).toBe('M2');
    });

    it('returns ? when both are null', () => {
        expect(formatEval(null, null)).toBe('?');
    });
});

describe('formatMoveWithNumber', () => {
    it('formats white move at move 1', () => {
        const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        expect(formatMoveWithNumber(fen, 'e4')).toBe('1. e4');
    });

    it('formats black move at move 1', () => {
        const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        expect(formatMoveWithNumber(fen, 'e5')).toBe('1... e5');
    });

    it('formats white move at move 5', () => {
        const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
        expect(formatMoveWithNumber(fen, 'Nc3')).toBe('4. Nc3');
    });
});

describe('fetchCloudEval', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    it('returns parsed result on success', async () => {
        const mockResponse = {
            fen: startFen,
            depth: 40,
            knodes: 12345,
            pvs: [
                { moves: 'e2e4 e7e5 g1f3', cp: 20, mate: null },
                { moves: 'd2d4 d7d5', cp: 15, mate: null },
            ],
        };

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        });

        const result = await fetchCloudEval(startFen, 5, mockFetch as any);

        expect(result).not.toBeNull();
        expect(result!.depth).toBe(40);
        expect(result!.pvs).toHaveLength(2);
        expect(result!.pvs[0].moveSan).toBe('e4');
        expect(result!.pvs[0].cp).toBe(20);
        expect(result!.pvs[0].lineSan).toEqual(['e4', 'e5', 'Nf3']);
        expect(result!.pvs[1].moveSan).toBe('d4');
        expect(result!.pvs[1].moveUci).toBe('d2d4');
    });

    it('returns null on 404', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
        });

        const result = await fetchCloudEval(startFen, 5, mockFetch as any);
        expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('network'));

        const result = await fetchCloudEval(startFen, 5, mockFetch as any);
        expect(result).toBeNull();
    });

    it('handles mate eval in PV', async () => {
        const mockResponse = {
            fen: 'some/fen',
            depth: 50,
            knodes: 100,
            pvs: [
                { moves: 'e2e4', cp: null, mate: 3 },
            ],
        };

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        });

        const result = await fetchCloudEval(startFen, 5, mockFetch as any);
        expect(result!.pvs[0].mate).toBe(3);
        expect(result!.pvs[0].cp).toBeNull();
    });

    it('constructs correct URL with encoded FEN', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ pvs: [] }),
        });

        await fetchCloudEval(startFen, 3, mockFetch as any);

        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('multiPv=3')
        );
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining(encodeURIComponent(startFen))
        );
    });
});
