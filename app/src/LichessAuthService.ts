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
    private initialized = false;
    private listeners: Set<AuthChangeListener> = new Set();

    constructor() {
        this.oauth = new OAuth2AuthCodePKCE({
            authorizationUrl: `${LICHESS_HOST}/oauth`,
            tokenUrl: `${LICHESS_HOST}/api/token`,
            clientId: CLIENT_ID,
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
     */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;

        try {
            // Try to restore a previously acquired token
            const existing = await this.oauth.getAccessToken();
            if (existing?.token?.value) {
                this.accessContext = existing;
                this.notifyListeners();
                return;
            }
        } catch {
            // No stored token — that's fine
        }

        try {
            const hasAuthCode = await this.oauth.isReturningFromAuthServer();
            if (hasAuthCode) {
                this.accessContext = await this.oauth.getAccessToken();
                this.notifyListeners();

                // Clean query params but preserve the hash route
                const savedHash = localStorage.getItem(RETURN_HASH_KEY) || '';
                localStorage.removeItem(RETURN_HASH_KEY);
                window.history.replaceState(
                    {},
                    '',
                    location.pathname + savedHash
                );
            }
        } catch (err) {
            console.warn('Lichess OAuth callback failed:', err);
            this.accessContext = null;
            this.notifyListeners();
        }
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

        // Reset the library's internal state
        this.oauth = new OAuth2AuthCodePKCE({
            authorizationUrl: `${LICHESS_HOST}/oauth`,
            tokenUrl: `${LICHESS_HOST}/api/token`,
            clientId: CLIENT_ID,
            scopes: [],
            redirectUrl: getRedirectUrl(),
            onAccessTokenExpiry: refreshAccessToken => refreshAccessToken(),
            onInvalidGrant: () => {
                this.accessContext = null;
                this.notifyListeners();
            },
        });
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
