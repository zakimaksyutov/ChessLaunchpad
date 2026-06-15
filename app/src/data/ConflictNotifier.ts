/**
 * Process-wide hook that lets non-UI code (`SessionStore.save`) signal
 * a 412 conflict to the React tree. The {@link ConflictModal} component
 * registers itself at app root via {@link setConflictListener} and
 * displays a "Repertoire changed elsewhere — reload" prompt when
 * {@link notifyConflict} fires.
 *
 * Why a module-level listener instead of an event bus / context: the
 * notifier is fired from `SessionStore.save`, which runs outside the
 * React render path (called from background helpers, page callbacks,
 * etc.). A single module-level slot keeps the wiring trivial and lets
 * us avoid threading a context through every save call site.
 *
 * Multiple notifications coalesce into a single modal display — the
 * listener implementation tracks its own "shown" flag, so repeated
 * fires from concurrent helpers don't stack modals.
 */

export type ConflictListener = () => void;

let listener: ConflictListener | null = null;

/**
 * Install the listener. Called once by {@link ConflictModal} on mount.
 * Returns a cleanup that clears the slot if the same listener is still
 * installed, so React StrictMode's double-mount doesn't leave a stale
 * registration.
 */
export function setConflictListener(fn: ConflictListener): () => void {
    listener = fn;
    return () => {
        if (listener === fn) listener = null;
    };
}

/**
 * Fire the registered listener (no-op if none installed). Called by
 * `SessionStore.save` when the server returns 412 — before the
 * `DataAccessError` is thrown — so the listener wins the race with
 * any caller's `catch` block.
 */
export function notifyConflict(): void {
    listener?.();
}

/** Test helper — wipe the registered listener. */
export function __clearConflictListener(): void {
    listener = null;
}
