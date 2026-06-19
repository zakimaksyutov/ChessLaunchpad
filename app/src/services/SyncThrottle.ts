/**
 * Client-side throttle for the automatic game-sync (provider game-download)
 * that fires when the user opens /dashboard or /games.
 *
 * Without it, bouncing between those pages re-hits the Lichess/chess.com game
 * APIs on every mount, which risks the providers rate-limiting our IP. The
 * throttle records the last time we actually queried the providers and lets
 * callers skip the auto download if it happened within `SYNC_THROTTLE_MS`.
 *
 * The timestamp is persisted in `localStorage` so it is shared across both
 * pages (and survives navigation/remount). It is keyed by the logged-in
 * ChessLaunchpad app username — NOT by a linked Lichess/chess.com account — so
 * a different app user logging in on the same browser starts with their own
 * throttle clock instead of inheriting the previous user's. (Mirrors the
 * existing per-user `games:filter:${username}` key.)
 *
 * Only the *automatic* sync is throttled. An explicit "Sync now" button click
 * forces a run (bypassing this gate) and then stamps a fresh time via
 * `markSyncedNow`.
 */

export const SYNC_THROTTLE_MS = 5 * 60 * 1000;

function storageKey(): string {
    let username = '';
    try {
        username = localStorage.getItem('username') ?? '';
    } catch {
        // localStorage unavailable (e.g. private mode) — fall back to an
        // empty-user key; throttle simply degrades to per-browser.
    }
    return `sync:lastAt:${username}`;
}

/** Last time we actually queried the providers, in epoch ms, or null if never. */
export function getLastSyncAt(): number | null {
    try {
        const raw = localStorage.getItem(storageKey());
        if (raw === null) return null;
        const ms = Number(raw);
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}

/** Record that we just queried the providers (call when committing to a fetch). */
export function markSyncedNow(now: number = Date.now()): void {
    try {
        localStorage.setItem(storageKey(), String(now));
    } catch {
        // Best-effort — if persistence fails the worst case is an extra fetch.
    }
}

/** True when the last provider query was less than `SYNC_THROTTLE_MS` ago. */
export function isSyncThrottled(now: number = Date.now()): boolean {
    const last = getLastSyncAt();
    return last !== null && now - last < SYNC_THROTTLE_MS;
}
