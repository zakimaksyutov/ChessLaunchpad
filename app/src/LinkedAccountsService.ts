const STORAGE_KEY = 'chesslaunchpad:linkedAccounts';

import { deleteGamesForUser } from './GamesDB';

export interface LinkedAccount {
    platform: 'lichess';
    username: string;
}

export function getLinkedAccounts(): LinkedAccount[] {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
        return JSON.parse(raw) as LinkedAccount[];
    } catch {
        return [];
    }
}

export function addLinkedAccount(username: string): LinkedAccount[] {
    const accounts = getLinkedAccounts();
    const normalized = username.trim().toLowerCase();
    if (!normalized) return accounts;
    if (accounts.some(a => a.username === normalized)) return accounts;
    const updated = [...accounts, { platform: 'lichess' as const, username: normalized }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
}

export function removeLinkedAccount(username: string): LinkedAccount[] {
    const accounts = getLinkedAccounts();
    const normalized = username.toLowerCase();
    const updated = accounts.filter(a => a.username !== normalized);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    // Clean up sync watermark for the removed account
    localStorage.removeItem(`chesslaunchpad:lastSyncTimestamp:${normalized}`);
    // Remove cached games for this account from IndexedDB
    deleteGamesForUser(normalized).catch(() => { /* best-effort cleanup */ });
    return updated;
}
