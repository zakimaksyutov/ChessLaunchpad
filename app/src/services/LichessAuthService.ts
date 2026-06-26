import { OAuth2AuthCodePKCE, AccessContext } from '@bity/oauth2-auth-code-pkce';

const LICHESS_HOST = 'https://lichess.org';
const CLIENT_ID = 'ChessLaunchpad';
const RETURN_HASH_KEY = 'lichess_return_hash';

type AuthChangeListener = () => void;

function getRedirectUrl(): string {
    const base = import.meta.env.BASE_URL || '/';
    return `${location.protocol}//${location.host}${base}`;
}

/**
 * Manages Lichess OAuth2 PKCE authentication.
 *
 * Uses @bity/oauth2-auth-code-pkce as the single source of truth for token
 * state. Subscribable via `subscribe()` for React integration.
 */
class LichessAuthServiceImpl {
    private oauth: OAuth2AuthCodePKCE;
    private accessContext: AccessContext | null = null;
    private initPromise: Promise<void> | null = null;
    private listeners: Set<AuthChangeListener> = new Set();

    constructor() {
        this.oauth = this.createOAuthClient();
    }

    private createOAuthClient(): OAuth2AuthCodePKCE {
        return new OAuth2AuthCodePKCE({
            authorizationUrl: `${LICHESS_HOST}/oauth`,
            tokenUrl: `${LICHESS_HOST}/api/token`,
            clientId: CLIENT_ID,
            // No extra scopes needed — we only use public APIs (Masters Opening Explorer).
            scopes: [],
            redirectUrl: getRedirectUrl(),
            onAccessTokenExpiry: refreshAccessToken => refreshAccessToken(),
            onInvalidGrant: () => {
                this.accessContext = null;
                this.notifyListeners();
            },
        });
    }

    /**
     * Must be called once on app startup. Detects if we're returning from
     * Lichess OAuth and exchanges the authorization code for a token.
     *
     * Memoized so concurrent callers (and {@link ready}) await the same run
     * rather than racing — important because a Lichess session's data-layer
     * 401 re-exchange must not read the token before init has restored it.
     */
    init(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.doInit();
        }
        return this.initPromise;
    }

    /** Resolves once {@link init} has completed (token restored / callback handled). */
    ready(): Promise<void> {
        return this.init();
    }

    private async doInit(): Promise<void> {
        // Process an OAuth callback BEFORE restoring any previously-stored
        // token. A fresh login must win over a stale token (which could belong
        // to a different/old account), and a denied/failed return must NOT
        // silently fall back to a stale token.
        let isReturn = false;
        try {
            isReturn = await this.oauth.isReturningFromAuthServer();
        } catch (err) {
            // Error param present (e.g. the user denied access) — a failed
            // auth return. Leave the connection unauthenticated.
            console.warn('Lichess OAuth callback failed:', err);
            this.accessContext = null;
            this.notifyListeners();
            this.restoreReturnRoute();
            return;
        }

        if (isReturn) {
            try {
                this.accessContext = await this.oauth.getAccessToken();
                this.notifyListeners();
            } catch (err) {
                console.warn('Lichess OAuth token exchange failed:', err);
                this.accessContext = null;
                this.notifyListeners();
            }
            this.restoreReturnRoute();
            return;
        }

        // Normal load — restore a previously stored token if present.
        try {
            const existing = await this.oauth.getAccessToken();
            if (existing?.token?.value) {
                this.accessContext = existing;
                this.notifyListeners();
            }
        } catch {
            // No stored token — that's fine.
        }
    }

    /** Clean query params but preserve the hash route saved before redirect. */
    private restoreReturnRoute(): void {
        const savedHash = localStorage.getItem(RETURN_HASH_KEY) || '';
        localStorage.removeItem(RETURN_HASH_KEY);
        window.history.replaceState({}, '', location.pathname + savedHash);
    }

    /** Redirect to Lichess for authorization. */
    async login(): Promise<void> {
        // Save current hash route so we can restore it after redirect
        localStorage.setItem(RETURN_HASH_KEY, location.hash);
        await this.oauth.fetchAuthorizationCode();
    }

    /** Revoke the token and clear auth state. */
    async logout(): Promise<void> {
        const token = this.getToken();
        this.accessContext = null;
        this.notifyListeners();

        if (token) {
            try {
                await fetch(`${LICHESS_HOST}/api/token`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${token}` },
                });
            } catch {
                // Best-effort revocation
            }
        }

        // Clear persisted token from localStorage and reset the library
        this.oauth.reset();
        this.oauth = this.createOAuthClient();
    }

    /** Returns the current Bearer token, or null if not connected. */
    getToken(): string | null {
        return this.accessContext?.token?.value ?? null;
    }

    /** Whether the user has a valid Lichess connection. */
    isConnected(): boolean {
        return this.getToken() !== null;
    }

    /** Subscribe to auth state changes. Returns an unsubscribe function. */
    subscribe(listener: AuthChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notifyListeners(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

export type LichessAuthService = LichessAuthServiceImpl;
export const lichessAuth = new LichessAuthServiceImpl();
