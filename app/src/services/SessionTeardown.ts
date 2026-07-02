import { setLinkedAccounts } from './LinkedAccountsService';
import { clearSyncThrottle } from './SyncThrottle';
import { clearBootstrapResult } from './BootstrapResultCache';
import { clearBootstrapHandoff } from './BootstrapHandoff';
import { loadSession, clearStoredSession } from '../data/AuthSession';

/**
 * Clear the per-user client state that must not leak into the next login:
 * the in-memory LinkedAccountsService cache, the staged bootstrap analysis
 * (completed-result cache + pending Explorer handoff), the auto game-sync
 * throttle stamp, and every persisted session key (username/password or
 * Lichess).
 *
 * Shared by the header logout and the Settings "delete account" flow so the
 * two can't drift on the easy-to-forget bits (resetting linked accounts,
 * dropping bootstrap state, clearing session keys, knowing whether a Lichess
 * OAuth revoke is needed).
 *
 * Returns the session mode that was active *before* clearing, so the caller
 * can decide whether to also revoke the underlying Lichess OAuth connection.
 * Note: this does NOT dispose the in-memory SessionStore — callers that need
 * that (e.g. delete-account, which has no parent logout handler) must call
 * `clearSessionStore()` themselves.
 */
export function clearClientSessionKeys(): 'password' | 'lichess' | null {
    const mode = loadSession()?.mode ?? null;
    setLinkedAccounts([]);
    // Drop any bootstrap analysis staged in memory so one user's proposed lines
    // and downloaded games never leak into the next user's /bootstrap on this
    // browser (both are app-lifetime module state, cleared only on logout or a
    // hard reload).
    clearBootstrapResult();
    clearBootstrapHandoff();
    // Before clearStoredSession: the throttle key is derived from the username
    // it is about to remove.
    clearSyncThrottle();
    clearStoredSession();
    return mode;
}
