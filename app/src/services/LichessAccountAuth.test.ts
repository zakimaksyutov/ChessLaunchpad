import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    exchangeLichessToken,
    createLichessAccount,
    fetchLichessDisplayName,
    LichessLoginError,
} from './LichessAccountAuth';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('LichessAccountAuth', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    describe('exchangeLichessToken', () => {
        it('POSTs the Lichess token and returns jwt + userId', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ jwt: 'jwt-1', userId: 'alice' }));
            const result = await exchangeLichessToken('lip_token');
            expect(result).toEqual({ jwt: 'jwt-1', userId: 'alice' });

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toContain('/api/auth/lichess');
            expect(init.method).toBe('POST');
            expect(JSON.parse(init.body)).toEqual({ token: 'lip_token' });
        });

        it('throws LichessLoginError carrying the status on a non-200 response', async () => {
            fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
            await expect(exchangeLichessToken('bad')).rejects.toMatchObject({
                name: 'LichessLoginError',
                status: 401,
            });
        });

        it('throws when the response is missing jwt or userId', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ jwt: 'only-jwt' }));
            await expect(exchangeLichessToken('x')).rejects.toBeInstanceOf(LichessLoginError);
        });

        it('throws on a network failure', async () => {
            fetchMock.mockRejectedValueOnce(new TypeError('network down'));
            await expect(exchangeLichessToken('x')).rejects.toBeInstanceOf(LichessLoginError);
        });
    });

    describe('createLichessAccount', () => {
        it('returns true when the account is newly created (200)', async () => {
            fetchMock.mockResolvedValueOnce(new Response("User 'alice' has been created.", { status: 200 }));
            await expect(createLichessAccount('alice', 'jwt-1')).resolves.toBe(true);

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toContain('/api/user/alice');
            expect(init.method).toBe('PUT');
            expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
        });

        it('returns false when the account already exists (409)', async () => {
            fetchMock.mockResolvedValueOnce(new Response("already exists", { status: 409 }));
            await expect(createLichessAccount('alice', 'jwt-1')).resolves.toBe(false);
        });

        it('throws on other error statuses', async () => {
            fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
            await expect(createLichessAccount('alice', 'jwt-1')).rejects.toBeInstanceOf(LichessLoginError);
        });
    });

    describe('fetchLichessDisplayName', () => {
        it('returns the cased username from the public user endpoint', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'drnykterstein', username: 'DrNykterstein' }));
            await expect(fetchLichessDisplayName('drnykterstein')).resolves.toBe('DrNykterstein');

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toContain('lichess.org/api/user/drnykterstein');
            // Public endpoint — no Authorization header / no OAuth scope needed.
            expect(init).toBeUndefined();
        });

        it('falls back to the id when the call fails', async () => {
            fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
            await expect(fetchLichessDisplayName('alice')).resolves.toBe('alice');
        });

        it('falls back to the id on a network error', async () => {
            fetchMock.mockRejectedValueOnce(new TypeError('offline'));
            await expect(fetchLichessDisplayName('alice')).resolves.toBe('alice');
        });
    });
});
