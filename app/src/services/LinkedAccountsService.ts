import { deleteGamesForAccount } from '../data/GamesDB';

export type Platform = 'lichess' | 'chess.com';

export interface LinkedAccount {
    platform: Platform;
    username: string;
}

let _linkedAccounts: LinkedAccount[] = [];

export function getAccountKey(platform: Platform, username: string): string {
    return `${platform}:${username.toLowerCase()}`;
}

export function getSyncTimestampKey(platform: Platform, username: string): string {
    return `chesslaunchpad:lastSyncTimestamp:${platform}:${username.toLowerCase()}`;
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

export function addLinkedAccount(username: string, platform: Platform): LinkedAccount[] {
    const normalized = username.trim().toLowerCase();
    if (!normalized) return _linkedAccounts;
    if (_linkedAccounts.some(a => a.platform === platform && a.username === normalized)) return _linkedAccounts;
    _linkedAccounts = [..._linkedAccounts, { platform, username: normalized }];
    return _linkedAccounts;
}

/**
 * Advance the sync watermark for an account to at least `timestamp`.
 * Used after grooming to prevent re-fetching deleted games.
 * Stays in localStorage — it's local cache, not a user setting.
 */
export function advanceSyncWatermark(platform: Platform, username: string, timestamp: number): void {
    const key = getSyncTimestampKey(platform, username.toLowerCase());
    try {
        const raw = localStorage.getItem(key);
        const current = raw ? parseInt(raw, 10) : 0;
        if (timestamp > current) {
            localStorage.setItem(key, timestamp.toString());
        }
    } catch { /* localStorage unavailable */ }
}

export function removeLinkedAccount(username: string, platform: Platform): LinkedAccount[] {
    const normalized = username.toLowerCase();
    _linkedAccounts = _linkedAccounts.filter(a => !(a.platform === platform && a.username === normalized));
    return _linkedAccounts;
}

/**
 * Clean up local data for a removed account (call after successful backend save).
 */
export function cleanupRemovedAccount(username: string, platform: Platform): void {
    const normalized = username.toLowerCase();
    try {
        localStorage.removeItem(getSyncTimestampKey(platform, normalized));
        if (platform === 'lichess') {
            localStorage.removeItem(`chesslaunchpad:lastSyncTimestamp:${normalized}`);
        }
    } catch { /* localStorage unavailable */ }
    deleteGamesForAccount(platform, normalized).catch(() => { /* best-effort cleanup */ });
}
