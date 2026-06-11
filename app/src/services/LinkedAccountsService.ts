export type Platform = 'lichess' | 'chess.com';

export interface LinkedAccount {
    platform: Platform;
    username: string;
}

let _linkedAccounts: LinkedAccount[] = [];

export function getAccountKey(platform: Platform, username: string): string {
    return `${platform}:${username.toLowerCase()}`;
}

export function getLinkedAccounts(): LinkedAccount[] {
    return _linkedAccounts;
}

export function setLinkedAccounts(accounts: LinkedAccount[]): void {
    _linkedAccounts = accounts.map(a => ({
        ...a,
        platform: a.platform || 'lichess',
        username: a.username.toLowerCase(),
    }));
}

/**
 * Clean up local state for a removed account. Called after a successful
 * Settings save persists the account removal.
 *
 * Today this is a no-op — the prior implementation deleted IndexedDB
 * `games` rows and removed the `chesslaunchpad:lastSyncTimestamp:*`
 * localStorage watermark, but the post-refactor design stores game
 * records on the synced blob (purged server-side by the next ingest's
 * `purgeRecordsForAccounts` call) and uses `data.games.{key}.watermarkMs`
 * on the blob for sync watermarks — neither survives on the device.
 *
 * The function is preserved as a documented seam so Settings doesn't
 * grow inline knowledge of the change; future per-device caches (if any)
 * have a single place to register cleanup.
 */
export function cleanupRemovedAccount(_username: string, _platform: Platform): void {
    // Intentionally empty — see doc comment above.
}
