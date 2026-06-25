import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    uciLineToSan,
    fetchCloudEval,
    fetchCloudCp,
    fetchCloudCpOutcome,
    CloudCpOutcome,
} from './LichessCloudEvalService';

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

describe('fetchCloudCp', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // Fake timers so the 1 req/sec throttle resolves instantly and
    // deterministically (no real wall-clock waits between tests).
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** Drive a fetchCloudCp call to completion, flushing the throttle timer. */
    async function run(mockFetch: unknown, fen = startFen): Promise<number | null> {
        const p = fetchCloudCp(fen, mockFetch as typeof fetch);
        await vi.runAllTimersAsync();
        return p;
    }

    function okWith(pv: Record<string, unknown> | null) {
        return vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ pvs: pv ? [pv] : [], depth: 30, knodes: 1 }),
        });
    }

    it('requests multiPv=1 (only the top-line eval is needed)', async () => {
        const mockFetch = okWith({ moves: 'e2e4', cp: 20, mate: null });
        await run(mockFetch);
        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('multiPv=1'));
    });

    it('returns the top PV centipawn value (White POV)', async () => {
        expect(await run(okWith({ moves: 'e2e4', cp: 33, mate: null }))).toBe(33);
        expect(await run(okWith({ moves: 'e2e4', cp: -150, mate: null }))).toBe(-150);
    });

    it('coalesces a forced mate to ±MATE_CP', async () => {
        expect(await run(okWith({ moves: 'e2e4', cp: null, mate: 3 }))).toBe(10000);
        expect(await run(okWith({ moves: 'e2e4', cp: null, mate: -5 }))).toBe(-10000);
    });

    it('returns null when Lichess has no eval (404) or no PV', async () => {
        const notFound = vi.fn().mockResolvedValue({ ok: false, status: 404 });
        expect(await run(notFound)).toBeNull();
        expect(await run(okWith(null))).toBeNull();
    });

    it('throttles successive requests by ~1 second', async () => {
        const mockFetch = okWith({ moves: 'e2e4', cp: 10, mate: null });
        // First call: fetched immediately.
        await run(mockFetch);
        const callsAfterFirst = mockFetch.mock.calls.length;
        // Second call: must wait for the throttle before hitting the network.
        const p2 = fetchCloudCp(startFen, mockFetch as unknown as typeof fetch);
        await vi.advanceTimersByTimeAsync(500);
        expect(mockFetch.mock.calls.length).toBe(callsAfterFirst); // still throttled
        await vi.advanceTimersByTimeAsync(600);
        await p2;
        expect(mockFetch.mock.calls.length).toBe(callsAfterFirst + 1);
    });
});

describe('fetchCloudCpOutcome', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function run(mockFetch: unknown): Promise<CloudCpOutcome> {
        const p = fetchCloudCpOutcome(startFen, mockFetch as typeof fetch);
        await vi.runAllTimersAsync();
        return p;
    }

    function okWith(pv: Record<string, unknown> | null) {
        return vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ pvs: pv ? [pv] : [], depth: 30, knodes: 1 }),
        });
    }

    it('returns ok with the top-line cp', async () => {
        expect(await run(okWith({ moves: 'e2e4', cp: 42, mate: null }))).toEqual({ kind: 'ok', cp: 42 });
    });

    it('coalesces a forced mate to ±MATE_CP', async () => {
        expect(await run(okWith({ moves: 'e2e4', cp: null, mate: 4 }))).toEqual({ kind: 'ok', cp: 10000 });
    });

    it('treats a 404 (and an empty PV list) as a genuine no-eval', async () => {
        const notFound = vi.fn().mockResolvedValue({ ok: false, status: 404 });
        expect(await run(notFound)).toEqual({ kind: 'no_eval' });
        expect(await run(okWith(null))).toEqual({ kind: 'no_eval' });
    });

    it('treats a 429 / 5xx as a transient error (NOT no-eval)', async () => {
        const rateLimited = vi.fn().mockResolvedValue({ ok: false, status: 429 });
        expect(await run(rateLimited)).toEqual({ kind: 'error' });
        const serverError = vi.fn().mockResolvedValue({ ok: false, status: 503 });
        expect(await run(serverError)).toEqual({ kind: 'error' });
    });

    it('treats a network/parse failure as a transient error', async () => {
        const networkErr = vi.fn().mockRejectedValue(new Error('network'));
        expect(await run(networkErr)).toEqual({ kind: 'error' });
    });
});
