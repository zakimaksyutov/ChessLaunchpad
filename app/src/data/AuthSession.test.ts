import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../services/LichessAuthService', () => ({
    lichessAuth: { getToken: vi.fn(), ready: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/LichessAccountAuth', () => ({
    exchangeLichessToken: vi.fn(),
    LichessLoginError: class LichessLoginError extends Error {
        status?: number;
        constructor(message: string, status?: number) {
            super(message);
            this.name = 'LichessLoginError';
            this.status = status;
        }
    },
}));
vi.mock('./SessionExpiredNotifier', () => ({
    notifySessionExpired: vi.fn(),
}));

import {
    PasswordCredential,
    LichessCredential,
    loadSession,
    isLichessSession,
    persistPasswordSession,
    persistLichessSession,
    updateStoredLichessJwt,
    clearStoredSession,
    loadCredentialFromStorage,
    telemetryUserId,
} from './AuthSession';
import { lichessAuth } from '../services/LichessAuthService';
import { exchangeLichessToken, LichessLoginError } from '../services/LichessAccountAuth';
import { notifySessionExpired } from './SessionExpiredNotifier';

const getToken = lichessAuth.getToken as unknown as Mock;
const exchangeMock = exchangeLichessToken as unknown as Mock;
const notifyMock = notifySessionExpired as unknown as Mock;

describe('AuthSession', () => {
    beforeEach(() => {
        localStorage.clear();
        getToken.mockReset();
        exchangeMock.mockReset();
        notifyMock.mockReset();
    });

    describe('PasswordCredential', () => {
        it('returns the password as the Authorization header', () => {
            expect(new PasswordCredential('pw').getAuthorization()).toBe('pw');
        });
        it('never renews', async () => {
            await expect(new PasswordCredential('pw').onUnauthorized()).resolves.toBe(false);
        });
    });

    describe('telemetryUserId', () => {
        it('tags password accounts as native and Lichess accounts as lichess', () => {
            expect(telemetryUserId('password', 'alice')).toBe('native:alice');
            expect(telemetryUserId('lichess', 'alice')).toBe('lichess:alice');
        });
    });

    describe('persistence', () => {
        it('round-trips a password session', () => {
            persistPasswordSession('alice', 'hashed-pw');
            expect(loadSession()).toEqual({ mode: 'password', userId: 'alice', displayName: 'alice' });
            expect(isLichessSession()).toBe(false);

            const loaded = loadCredentialFromStorage();
            expect(loaded?.userId).toBe('alice');
            expect(loaded?.credential).toBeInstanceOf(PasswordCredential);
            expect(loaded?.credential.getAuthorization()).toBe('hashed-pw');
        });

        it('round-trips a Lichess session and uses the cased display name', () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            expect(loadSession()).toEqual({ mode: 'lichess', userId: 'alice', displayName: 'Alice' });
            expect(isLichessSession()).toBe(true);

            const loaded = loadCredentialFromStorage();
            expect(loaded?.userId).toBe('alice');
            expect(loaded?.credential).toBeInstanceOf(LichessCredential);
            expect(loaded?.credential.getAuthorization()).toBe('Bearer jwt-1');
        });

        it('persistLichessSession clears any prior password key', () => {
            persistPasswordSession('alice', 'hashed-pw');
            persistLichessSession('alice', 'Alice', 'jwt-1');
            expect(localStorage.getItem('hashedPassword')).toBeNull();
            expect(loadSession()?.mode).toBe('lichess');
        });

        it('persistPasswordSession clears any prior Lichess keys', () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            persistPasswordSession('alice', 'hashed-pw');
            expect(localStorage.getItem('authMode')).toBeNull();
            expect(localStorage.getItem('lichessJwt')).toBeNull();
            expect(loadSession()?.mode).toBe('password');
        });

        it('clearStoredSession removes every key', () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            clearStoredSession();
            expect(loadSession()).toBeNull();
            expect(loadCredentialFromStorage()).toBeNull();
        });

        it('returns null when a Lichess session is missing its jwt', () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            localStorage.removeItem('lichessJwt');
            expect(loadSession()).toBeNull();
            expect(loadCredentialFromStorage()).toBeNull();
        });

        it('updateStoredLichessJwt rewrites only the jwt', () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            updateStoredLichessJwt('jwt-2');
            expect(localStorage.getItem('lichessJwt')).toBe('jwt-2');
            expect(loadSession()).toEqual({ mode: 'lichess', userId: 'alice', displayName: 'Alice' });
        });
    });

    describe('LichessCredential.onUnauthorized', () => {
        it('re-exchanges the live Lichess token and persists the fresh jwt', async () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            getToken.mockReturnValue('lip_live');
            exchangeMock.mockResolvedValueOnce({ jwt: 'jwt-2', userId: 'alice' });

            const cred = new LichessCredential('alice', 'jwt-1');
            await expect(cred.onUnauthorized()).resolves.toBe(true);
            expect(cred.getAuthorization()).toBe('Bearer jwt-2');
            expect(localStorage.getItem('lichessJwt')).toBe('jwt-2');
            expect(notifyMock).not.toHaveBeenCalled();
        });

        it('drops the session when the Lichess connection is gone', async () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            getToken.mockReturnValue(null);
            const cred = new LichessCredential('alice', 'jwt-1');
            await expect(cred.onUnauthorized()).resolves.toBe(false);
            expect(notifyMock).toHaveBeenCalledTimes(1);
            expect(exchangeMock).not.toHaveBeenCalled();
        });

        it('drops the session when Lichess rejects the token (exchange 401)', async () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            getToken.mockReturnValue('lip_live');
            exchangeMock.mockRejectedValueOnce(new LichessLoginError('rejected', 401));
            const cred = new LichessCredential('alice', 'jwt-1');
            await expect(cred.onUnauthorized()).resolves.toBe(false);
            expect(notifyMock).toHaveBeenCalledTimes(1);
        });

        it('keeps the session on a transient backend failure (no drop)', async () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            getToken.mockReturnValue('lip_live');
            exchangeMock.mockRejectedValueOnce(new LichessLoginError('server down', 502));
            const cred = new LichessCredential('alice', 'jwt-1');
            await expect(cred.onUnauthorized()).resolves.toBe(false);
            expect(notifyMock).not.toHaveBeenCalled();
            // The stored jwt is untouched so a later action can retry.
            expect(localStorage.getItem('lichessJwt')).toBe('jwt-1');
        });

        it('does not resurrect a stale jwt if the session was cleared mid-exchange', async () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            getToken.mockReturnValue('lip_live');
            // Simulate a logout that lands while the exchange is in flight.
            exchangeMock.mockImplementationOnce(async () => {
                clearStoredSession();
                return { jwt: 'jwt-2', userId: 'alice' };
            });
            const cred = new LichessCredential('alice', 'jwt-1');
            await expect(cred.onUnauthorized()).resolves.toBe(false);
            expect(localStorage.getItem('lichessJwt')).toBeNull();
        });

        it('does not notify when the active session belongs to a different user (account switch)', async () => {
            // Credential for alice, but the session is now bob's.
            persistLichessSession('bob', 'Bob', 'jwt-bob');
            getToken.mockReturnValue(null);
            const cred = new LichessCredential('alice', 'jwt-1');
            await expect(cred.onUnauthorized()).resolves.toBe(false);
            expect(notifyMock).not.toHaveBeenCalled();
            // bob's session is untouched.
            expect(localStorage.getItem('lichessJwt')).toBe('jwt-bob');
        });

        it('coalesces concurrent 401s into a single exchange', async () => {
            persistLichessSession('alice', 'Alice', 'jwt-1');
            getToken.mockReturnValue('lip_live');
            exchangeMock.mockResolvedValue({ jwt: 'jwt-2', userId: 'alice' });
            const cred = new LichessCredential('alice', 'jwt-1');
            const [a, b] = await Promise.all([cred.onUnauthorized(), cred.onUnauthorized()]);
            expect(a).toBe(true);
            expect(b).toBe(true);
            expect(exchangeMock).toHaveBeenCalledTimes(1);
        });
    });
});
