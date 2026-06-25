/**
 * Process-wide hook that lets the data layer signal an unrecoverable
 * authentication failure to the React tree. Used by the Lichess-login
 * session: when a backend call is rejected as unauthorized and the
 * underlying Lichess connection can no longer be exchanged for a fresh
 * backend token, the session is dead and the user must sign in again.
 *
 * Mirrors {@link ConflictNotifier}: a single module-level slot keeps the
 * wiring trivial and lets non-render code (`LichessCredential.onUnauthorized`,
 * called from inside `SessionStore` fetches) reach the app shell, which
 * registers a handler at root and drops the session + routes to /login.
 */

export type SessionExpiredListener = () => void;

let listener: SessionExpiredListener | null = null;

/**
 * Install the listener. Called once by the app shell on mount. Returns a
 * cleanup that clears the slot if the same listener is still installed, so
 * React StrictMode's double-mount doesn't leave a stale registration.
 */
export function setSessionExpiredListener(fn: SessionExpiredListener): () => void {
    listener = fn;
    return () => {
        if (listener === fn) listener = null;
    };
}

/** Fire the registered listener (no-op if none installed). */
export function notifySessionExpired(): void {
    listener?.();
}

/** Test helper — wipe the registered listener. */
export function __clearSessionExpiredListener(): void {
    listener = null;
}
