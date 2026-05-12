const STORAGE_KEY = 'chesslaunchpad:linkedAccounts';

import { deleteGamesForAccount } from './GamesDB';

export type Platform = 'lichess' | 'chess.com';

export interface LinkedAccount {
    platform: Platform;
    username: string;
}

export function getAccountKey(platform: Platform, username: string): string {
    return `${platform}:${username.toLowerCase()}`;
}

export function getSyncTimestampKey(platform: Platform, username: string): string {
    return `chesslaunchpad:lastSyncTimestamp:${platform}:${username.toLowerCase()}`;
}

export function getLinkedAccounts(): LinkedAccount[] {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
        const accounts = JSON.parse(raw) as LinkedAccount[];
        // Migrate old records without platform field
        return accounts.map(a => ({
            ...a,
            platform: a.platform || 'lichess',
        }));
    } catch {
        return [];
    }
}

export function addLinkedAccount(username: string, platform: Platform): LinkedAccount[] {
    const accounts = getLinkedAccounts();
    const normalized = username.trim().toLowerCase();
    if (!normalized) return accounts;
    if (accounts.some(a => a.platform === platform && a.username === normalized)) return accounts;
    const updated = [...accounts, { platform, username: normalized }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
}

/**
 * Advance the sync watermark for an account to at least `timestamp`.
 * Used after grooming to prevent re-fetching deleted games.
 */
export function advanceSyncWatermark(platform: Platform, username: string, timestamp: number): void {
    const key = getSyncTimestampKey(platform, username.toLowerCase());
    const raw = localStorage.getItem(key);
    const current = raw ? parseInt(raw, 10) : 0;
    if (timestamp > current) {
        localStorage.setItem(key, timestamp.toString());
    }
}

export function removeLinkedAccount(username: string, platform: Platform): LinkedAccount[] {
    const accounts = getLinkedAccounts();
    const normalized = username.toLowerCase();
    const updated = accounts.filter(a => !(a.platform === platform && a.username === normalized));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    // Clean up sync watermark (new key format)
    localStorage.removeItem(getSyncTimestampKey(platform, normalized));
    // Also clean up legacy Lichess key format
    if (platform === 'lichess') {
        localStorage.removeItem(`chesslaunchpad:lastSyncTimestamp:${normalized}`);
    }
    // Remove cached games for this account from IndexedDB
    deleteGamesForAccount(platform, normalized).catch(() => { /* best-effort cleanup */ });
    return updated;
}
