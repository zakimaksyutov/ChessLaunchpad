/**
 * One-time best-effort cleanup of IndexedDB stores retired by the
 * `docs/product-specs/GAMES-REFACTOR.md` refactor.
 *
 * The three IndexedDB databases used by the old /games page —
 *   - `chesslaunchpad-games-db`        (downloaded games)
 *   - `chesslaunchpad-masters-explorer` (cached masters positions)
 *   - `chesslaunchpad-opponent-analysis` (saved opponent analyses)
 * — are no longer opened by any code path. They survive on existing
 * users' devices indefinitely unless we delete them explicitly. Logout
 * used to clear two of them; that hook is gone, so we sweep on first
 * app boot after the refactor ships.
 *
 * Marked done via a localStorage flag only when **all three** deletions
 * succeed via `onsuccess`. `onerror` / `onblocked` are silently retried
 * on the next boot — they're rare (other open connections to the same
 * DB) and orphaned DBs are inert until the user closes the conflicting
 * tab. Failures don't loop in tight pods because the flag stays unset
 * (so the next boot re-attempts), and `deleteDatabase` is idempotent.
 */

const DONE_FLAG_KEY = 'chesslaunchpad:legacyIDBCleanup:v1';

const LEGACY_DBS = [
    'chesslaunchpad-games-db',
    'chesslaunchpad-masters-explorer',
    'chesslaunchpad-opponent-analysis',
];

export function cleanupLegacyIndexedDB(): void {
    try {
        if (localStorage.getItem(DONE_FLAG_KEY) === 'done') return;
    } catch {
        // localStorage unavailable — best to just attempt the cleanup
        // anyway; deleteDatabase is idempotent.
    }

    if (typeof indexedDB === 'undefined') return;

    // Track per-db status. `done` flag is only written when ALL three
    // succeeded — partial completion leaves the flag unset so the next
    // boot retries the still-blocked / still-errored DBs.
    const succeeded = new Set<string>();
    let settled = 0;

    const onSettle = () => {
        settled += 1;
        if (settled === LEGACY_DBS.length && succeeded.size === LEGACY_DBS.length) {
            try {
                localStorage.setItem(DONE_FLAG_KEY, 'done');
            } catch {
                // best-effort
            }
        }
    };

    for (const name of LEGACY_DBS) {
        try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => {
                succeeded.add(name);
                onSettle();
            };
            // onerror / onblocked: settle without marking success. The
            // next boot will retry (deleteDatabase is idempotent).
            req.onerror = onSettle;
            req.onblocked = onSettle;
        } catch {
            onSettle();
        }
    }
}
