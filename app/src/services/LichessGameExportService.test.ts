import { describe, it, expect, vi } from 'vitest';
import { fetchLichessGameExport } from './LichessGameExportService';

function okResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

function errResponse(status: number): Response {
    return {
        ok: false,
        status,
        json: () => Promise.reject(new Error('should not parse')),
    } as unknown as Response;
}

describe('fetchLichessGameExport', () => {
    it('returns parsed JSON on a 200 response', async () => {
        const payload = { id: 'abc123', moves: 'e4 e5', analysis: [{ eval: 10 }] };
        const fetchFn = vi.fn(() => Promise.resolve(okResponse(payload))) as unknown as typeof fetch;
        const result = await fetchLichessGameExport('abc123', fetchFn);
        expect(result).toEqual(payload);
    });

    it('requests the expected URL with evals/clocks/opening/moves', async () => {
        const fetchFn = vi.fn(() => Promise.resolve(okResponse({ id: 'x' }))) as unknown as typeof fetch;
        await fetchLichessGameExport('xYz_1', fetchFn);
        const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const url = calls[0][0] as string;
        expect(url).toContain('https://lichess.org/game/export/xYz_1?');
        expect(url).toContain('moves=true');
        expect(url).toContain('clocks=true');
        expect(url).toContain('evals=true');
        expect(url).toContain('opening=true');
    });

    it('does NOT send Authorization (would force a CORS preflight that Lichess 404s)', async () => {
        const fetchFn = vi.fn(() => Promise.resolve(okResponse({ id: 'x' }))) as unknown as typeof fetch;
        await fetchLichessGameExport('x', fetchFn);
        const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const init = calls[0][1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBeUndefined();
        expect(headers['Accept']).toBe('application/json');
    });

    it('returns null on a non-ok response (404, 429, etc.)', async () => {
        for (const status of [404, 429, 500]) {
            const fetchFn = vi.fn(() => Promise.resolve(errResponse(status))) as unknown as typeof fetch;
            const result = await fetchLichessGameExport('x', fetchFn);
            expect(result, `status=${status}`).toBeNull();
        }
    });

    it('returns null on a network error', async () => {
        const fetchFn = vi.fn(() => Promise.reject(new Error('network'))) as unknown as typeof fetch;
        const result = await fetchLichessGameExport('x', fetchFn);
        expect(result).toBeNull();
    });

    it('returns null when the response body is not a JSON object', async () => {
        const fetchFn = vi.fn(() => Promise.resolve(okResponse([1, 2, 3]))) as unknown as typeof fetch;
        const result = await fetchLichessGameExport('x', fetchFn);
        expect(result).toBeNull();
    });
});
