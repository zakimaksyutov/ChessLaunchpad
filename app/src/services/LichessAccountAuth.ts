/**
 * Backend + Lichess helpers for the "Sign in with Lichess" flow.
 *
 * These wrap the three network calls the login flow needs:
 *   1. Exchange a Lichess OAuth token for a Chess Launchpad backend JWT
 *      (`POST /auth/lichess`). This validates the Lichess token and resolves
 *      the backend user id; it does **not** create an account.
 *   2. Create the backend account on first-ever sign-in (`PUT /user/{id}`).
 *      An "already exists" (409) is treated as a normal sign-in.
 *   3. Read the user's properly-cased Lichess username for display.
 *
 * See `docs/product-specs/LICHESS-LOGIN.md` and
 * `docs/BACKEND_API_CONTRACT.md`.
 */

const API_BASE = 'https://chess-prod-function.azurewebsites.net/api';
const LICHESS_HOST = 'https://lichess.org';

export interface LichessExchangeResult {
    /** Backend-issued JWT, the credential for all account/repertoire calls. */
    jwt: string;
    /** Resolved backend user id (lowercased Lichess username). */
    userId: string;
}

export class LichessLoginError extends Error {
    /** HTTP status from the failed call, when there was a response. */
    public status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = 'LichessLoginError';
        this.status = status;
        Object.setPrototypeOf(this, LichessLoginError.prototype);
    }
}

/**
 * Exchange a Lichess OAuth token for a backend JWT + resolved user id.
 * Throws {@link LichessLoginError} on any non-200 / malformed response. The
 * error carries the HTTP `status` so callers can distinguish a rejected token
 * (401 — the Lichess connection is dead) from a transient backend failure.
 */
export async function exchangeLichessToken(lichessToken: string): Promise<LichessExchangeResult> {
    let response: Response;
    try {
        response = await fetch(`${API_BASE}/auth/lichess`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: lichessToken }),
        });
    } catch {
        throw new LichessLoginError('Could not reach the server.');
    }

    if (!response.ok) {
        throw new LichessLoginError(`Lichess token exchange failed (${response.status}).`, response.status);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new LichessLoginError('Malformed token exchange response.');
    }

    const jwt = (body as { jwt?: unknown }).jwt;
    const userId = (body as { userId?: unknown }).userId;
    if (typeof jwt !== 'string' || !jwt || typeof userId !== 'string' || !userId) {
        throw new LichessLoginError('Token exchange response missing jwt or userId.');
    }
    return { jwt, userId };
}

/**
 * Create the backend account for a freshly signed-in Lichess user.
 *
 * Returns `true` if the account was created by this call (first-ever sign-in),
 * `false` if it already existed (409). Both outcomes are non-error sign-ins.
 * Throws {@link LichessLoginError} on any other failure.
 */
export async function createLichessAccount(userId: string, jwt: string): Promise<boolean> {
    let response: Response;
    try {
        response = await fetch(`${API_BASE}/user/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${jwt}` },
        });
    } catch {
        throw new LichessLoginError('Could not reach the server.');
    }

    if (response.status === 409) return false;
    if (!response.ok) {
        throw new LichessLoginError(`Account creation failed (${response.status}).`);
    }
    return true;
}

/**
 * Resolve the user's properly-cased Lichess username for display.
 *
 * Uses the **public** `GET /api/user/{id}` endpoint (no auth, no OAuth scope
 * required) keyed by the lowercased id from the exchange, so it works
 * regardless of the OAuth token's scopes. Falls back to `userId` if the call
 * fails — the cased name is purely cosmetic and must never block a sign-in.
 */
export async function fetchLichessDisplayName(userId: string): Promise<string> {
    try {
        const response = await fetch(`${LICHESS_HOST}/api/user/${encodeURIComponent(userId)}`);
        if (!response.ok) return userId;
        const body = await response.json();
        const username = (body as { username?: unknown }).username;
        return typeof username === 'string' && username ? username : userId;
    } catch {
        return userId;
    }
}
