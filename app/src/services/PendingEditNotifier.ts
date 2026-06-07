/**
 * Tab-local, in-memory signal that the Explorer has an unsaved pending
 * edit session. Other pages (e.g. Training, Header) can subscribe to it
 * so they can prompt the user to Save or Discard first.
 *
 * Deliberately not persisted: the spec calls the delta "tab-local" — a
 * hard refresh or tab close loses it, so the notifier is reset on page
 * reload. Cross-tab gating relies on the blob ETag's 412 conflict path,
 * not on this notifier (see EXPLORER.md "Concurrent edits from another
 * tab").
 */

type Listener = (isPending: boolean) => void;
type EditModeListener = (inEditMode: boolean) => void;

let _pending = false;
let _inEditMode = false;
const _listeners = new Set<Listener>();
const _editModeListeners = new Set<EditModeListener>();
let _lastSafeHash: string = (typeof window !== 'undefined') ? window.location.hash : '';

export const PendingEditNotifier = {
    isPending(): boolean {
        return _pending;
    },

    setPending(pending: boolean): void {
        if (_pending === pending) return;
        _pending = pending;
        for (const l of _listeners) {
            try { l(pending); } catch { /* listener errors must not break the notifier */ }
        }
    },

    /** Returns an unsubscribe function. */
    subscribe(listener: Listener): () => void {
        _listeners.add(listener);
        return () => { _listeners.delete(listener); };
    },

    /**
     * Whether the Explorer page is currently in Edit mode. Distinct from
     * `isPending` (unsaved-changes safety net): edit mode can be active
     * with zero pending edits (the user just clicked "Edit repertoire").
     * The Header subscribes to this to disable every menu item — the user
     * must Save or Discard before navigating anywhere.
     */
    isInEditMode(): boolean {
        return _inEditMode;
    },

    setInEditMode(inEditMode: boolean): void {
        if (_inEditMode === inEditMode) return;
        _inEditMode = inEditMode;
        for (const l of _editModeListeners) {
            try { l(inEditMode); } catch { /* listener errors must not break the notifier */ }
        }
    },

    /** Returns an unsubscribe function. */
    subscribeEditMode(listener: EditModeListener): () => void {
        _editModeListeners.add(listener);
        return () => { _editModeListeners.delete(listener); };
    },

    /**
     * Update the "last safe URL hash" that the popstate guard should
     * bounce back to when the user cancels a leave-prompt mid-edit. The
     * Explorer page calls this whenever the URL settles on an explorer
     * route so we have a known-safe place to return to.
     */
    setLastSafeHash(hash: string): void {
        _lastSafeHash = hash;
    },

    getLastSafeHash(): string {
        return _lastSafeHash;
    },
};

// ── Global popstate / hashchange guard (registered at module load) ─────
//
// Why module-level: React Router's `HashRouter` registers its own
// `popstate` listener at App mount, before ExplorerPage even renders.
// Some React-Router-7 paths synchronously `flushSync` route updates,
// which unmount ExplorerPage and remove a component-scoped listener
// BEFORE that listener ever runs for the popping event. Registering at
// module-load time guarantees we're first in the listener order and
// fires synchronously alongside RR's own popstate handler.
//
// The guard is no-op when `_pending` is false, so the runtime cost of
// always being registered is negligible.
if (typeof window !== 'undefined') {
    const isExplorerHash = (h: string) => h.startsWith('#/explorer');

    const handle = () => {
        const here = window.location.hash;
        if (isExplorerHash(here)) {
            _lastSafeHash = here;
            return;
        }
        if (!_pending) return;
        const confirmed = window.confirm(
            'You have unsaved repertoire edits. Leaving this page will discard them. Continue?',
        );
        if (confirmed) {
            // User chose to abandon; flip pending to false so subsequent
            // events don't re-prompt. The Explorer page also listens to
            // this signal and will clean up its pendingModel.
            _pending = false;
            for (const l of _listeners) {
                try { l(false); } catch { /* ignore */ }
            }
            return;
        }
        // Cancel: bounce back to the last known safe URL. `replaceState`
        // keeps the back-stack clean so the user can try again.
        const safe = _lastSafeHash || '#/explorer';
        window.history.replaceState(null, '', safe);
    };
    window.addEventListener('popstate', handle);
    window.addEventListener('hashchange', handle);
}
