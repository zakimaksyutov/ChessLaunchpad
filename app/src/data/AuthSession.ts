/**
 * Auth-mode-aware session credentials.
 *
 * Chess Launchpad supports two kinds of account that share one backend:
 *   - **Username/password** — `Authorization: <derived-password>`.
 *   - **Lichess login** — `Authorization: Bearer <backend-jwt>`.
 *
 * Both persist a session in `localStorage` and restore it on startup so a
 * refresh keeps the user signed in. The backend user id (`username` key) is
 * identical in both modes; a Lichess session additionally records its mode,
 * the cased display name, and the backend JWT.
 *
 * See the "Lichess Integration" section of `ARCHITECTURE.md`.
 */

import { lichessAuth } from '../services/LichessAuthService';
import { exchangeLichessToken, LichessLoginError } from '../services/LichessAccountAuth';
import { notifySessionExpired } from './SessionExpiredNotifier';

type AuthMode = 'password' | 'lichess';

// localStorage keys. `username` + `hashedPassword` are the long-standing
// password-account keys; the rest are added for Lichess sessions.
const LS_USERNAME = 'username';
const LS_HASHED_PASSWORD = 'hashedPassword';
const LS_AUTH_MODE = 'authMode';
const LS_LICHESS_JWT = 'lichessJwt';
const LS_LICHESS_DISPLAY_NAME = 'lichessDisplayName';

// Marks an in-progress "Sign in with Lichess" so the login can resume after
// the full-page OAuth redirect to Lichess and back. The OAuth provider
// returns to the app's base URL (no hash route), so this flag — not the
// route — is what tells the app a login is mid-flight.
const LS_LICHESS_LOGIN_PENDING = 'lichess_login_pending';

export interface SessionInfo {
    mode: AuthMode;
    /** Backend user id (lowercased). */
    userId: string;
    /** Name to show in the UI (cased Lichess username, or the plain userId). */
    displayName: string;
}

/**
 * Credential used by the data layer to authorize backend requests.
 *
 * `onUnauthorized` is invoked when a backend request returns 401; it returns
 * `true` if a fresh credential was obtained and the caller should retry once,
 * `false` otherwise. Any side effect of an unrecoverable failure (dropping a
 * dead Lichess session) is the credential's own responsibility.
 */
export interface AuthCredential {
    getAuthorization(): string;
    onUnauthorized(): Promise<boolean>;
}

/** Username/password credential — the header is the derived password. */
export class PasswordCredential implements AuthCredential {
    constructor(private readonly password: string) {}

    getAuthorization(): string {
        return this.password;
    }

    async onUnauthorized(): Promise<boolean> {
        // A 401 on a password account means the password is wrong; there is
        // nothing to refresh and no live session to drop.
        return false;
    }
}

/**
 * Lichess credential — the header is `Bearer <backend-jwt>`. The backend JWT
 * can expire; `onUnauthorized` transparently re-runs the token exchange using
 * the still-live Lichess OAuth connection and, on failure, drops the session.
 */
export class LichessCredential implements AuthCredential {
    private inFlightRefresh: Promise<boolean> | null = null;

    constructor(
        private readonly userId: string,
        private jwt: string,
    ) {}

    getAuthorization(): string {
        return `Bearer ${this.jwt}`;
    }

    async onUnauthorized(): Promise<boolean> {
        // Coalesce concurrent 401s (e.g. parallel page fetches) into a single
        // exchange so we don't hammer the backend with duplicate requests.
        if (!this.inFlightRefresh) {
            this.inFlightRefresh = this.refresh().finally(() => {
                this.inFlightRefresh = null;
            });
        }
        return this.inFlightRefresh;
    }

    /**
     * Whether the persisted session still belongs to *this* credential. Guards
     * every side effect: a refresh that's still in flight when the user logs
     * out or switches accounts must not resurrect a jwt or fire the
     * session-expired notifier against the new/absent session.
     */
    private isOwnSession(): boolean {
        const session = loadSession();
        return session?.mode === 'lichess' && session.userId === this.userId;
    }

    private async refresh(): Promise<boolean> {
        // Wait for the OAuth layer to finish restoring the token on startup —
        // otherwise a fast backend 401 during the eager fetch could read a
        // not-yet-restored token as "gone" and wrongly drop a valid session.
        await lichessAuth.ready();

        const lichessToken = lichessAuth.getToken();
        if (!lichessToken) {
            // The underlying Lichess connection is gone — the session is dead
            // (but only if this credential still owns the active session).
            if (this.isOwnSession()) notifySessionExpired();
            return false;
        }
        try {
            const { jwt } = await exchangeLichessToken(lichessToken);
            // The session may have been cleared (logout) or replaced (account
            // switch) while the exchange was in flight — don't resurrect it.
            if (!this.isOwnSession()) {
                return false;
            }
            this.jwt = jwt;
            updateStoredLichessJwt(jwt);
            return true;
        } catch (err) {
            // Only drop the session when Lichess itself rejected the token
            // (401 — the connection is dead). Transient backend failures
            // (5xx / network) leave the session intact; the caller's request
            // surfaces an error and a later action can retry the exchange.
            if (err instanceof LichessLoginError && err.status === 401 && this.isOwnSession()) {
                notifySessionExpired();
            }
            return false;
        }
    }
}

// ── localStorage persistence ────────────────────────────────────────────

/** Read the persisted session, or `null` if no user is signed in. */
export function loadSession(): SessionInfo | null {
    const userId = localStorage.getItem(LS_USERNAME);
    if (!userId) return null;

    if (localStorage.getItem(LS_AUTH_MODE) === 'lichess') {
        const jwt = localStorage.getItem(LS_LICHESS_JWT);
        if (!jwt) return null;
        const displayName = localStorage.getItem(LS_LICHESS_DISPLAY_NAME) || userId;
        return { mode: 'lichess', userId, displayName };
    }

    if (!localStorage.getItem(LS_HASHED_PASSWORD)) return null;
    return { mode: 'password', userId, displayName: userId };
}

/** True if the active session is a Lichess-login session. */
export function isLichessSession(): boolean {
    return loadSession()?.mode === 'lichess';
}

/**
 * Tag a backend user id with its auth provider for telemetry so the two
 * account kinds are distinguishable, e.g. `native:alice` / `lichess:alice`.
 * The backend user id is identical across modes, so the prefix is the only
 * thing that separates a password account from a Lichess login.
 */
export function telemetryUserId(mode: AuthMode, userId: string): string {
    return `${mode === 'lichess' ? 'lichess' : 'native'}:${userId}`;
}

/** Persist a username/password session, clearing any prior Lichess keys. */
export function persistPasswordSession(userId: string, hashedPassword: string): void {
    localStorage.setItem(LS_USERNAME, userId);
    localStorage.setItem(LS_HASHED_PASSWORD, hashedPassword);
    localStorage.removeItem(LS_AUTH_MODE);
    localStorage.removeItem(LS_LICHESS_JWT);
    localStorage.removeItem(LS_LICHESS_DISPLAY_NAME);
}

/** Persist a Lichess-login session, clearing any prior password key. */
export function persistLichessSession(userId: string, displayName: string, jwt: string): void {
    localStorage.setItem(LS_USERNAME, userId);
    localStorage.setItem(LS_AUTH_MODE, 'lichess');
    localStorage.setItem(LS_LICHESS_JWT, jwt);
    localStorage.setItem(LS_LICHESS_DISPLAY_NAME, displayName);
    localStorage.removeItem(LS_HASHED_PASSWORD);
}

/** Update only the stored backend JWT (after a transparent re-exchange). */
export function updateStoredLichessJwt(jwt: string): void {
    localStorage.setItem(LS_LICHESS_JWT, jwt);
}

/** Remove every persisted session key (logout). */
export function clearStoredSession(): void {
    localStorage.removeItem(LS_USERNAME);
    localStorage.removeItem(LS_HASHED_PASSWORD);
    localStorage.removeItem(LS_AUTH_MODE);
    localStorage.removeItem(LS_LICHESS_JWT);
    localStorage.removeItem(LS_LICHESS_DISPLAY_NAME);
}

// ── Pending Lichess login intent ────────────────────────────────────────

/** True if a "Sign in with Lichess" is mid-flight across the OAuth redirect. */
export function isLichessLoginPending(): boolean {
    return localStorage.getItem(LS_LICHESS_LOGIN_PENDING) === '1';
}

/** Record that a Lichess login was started (survives the full-page redirect). */
export function setLichessLoginPending(): void {
    localStorage.setItem(LS_LICHESS_LOGIN_PENDING, '1');
}

/** Clear the pending Lichess login intent. */
export function clearLichessLoginPending(): void {
    localStorage.removeItem(LS_LICHESS_LOGIN_PENDING);
}

/**
 * Build the credential for the persisted session, or `null` if no usable
 * session is stored. Used by `SessionStore` to lazily bootstrap.
 */
export function loadCredentialFromStorage(): { userId: string; credential: AuthCredential } | null {
    const session = loadSession();
    if (!session) return null;
    if (session.mode === 'lichess') {
        const jwt = localStorage.getItem(LS_LICHESS_JWT);
        if (!jwt) return null;
        return { userId: session.userId, credential: new LichessCredential(session.userId, jwt) };
    }
    const password = localStorage.getItem(LS_HASHED_PASSWORD);
    if (!password) return null;
    return { userId: session.userId, credential: new PasswordCredential(password) };
}
