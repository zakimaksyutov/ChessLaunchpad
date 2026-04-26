import { MastersExplorerResult } from './LichessMastersService';

const DB_NAME = 'chess-launchpad';
const DB_VERSION = 1;
const STORE_NAME = 'masters-explorer';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface CachedEntry {
    data: MastersExplorerResult | null;
    fetchedAt: number;
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function getCachedMasters(fen: string): Promise<MastersExplorerResult | null | undefined> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(fen);
            req.onsuccess = () => {
                db.close();
                const entry = req.result as CachedEntry | undefined;
                if (!entry) {
                    resolve(undefined); // cache miss
                    return;
                }
                if (Date.now() - entry.fetchedAt > TTL_MS) {
                    resolve(undefined); // stale
                    return;
                }
                resolve(entry.data); // cache hit (may be null = no master data)
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        });
    } catch {
        return undefined; // IndexedDB unavailable — treat as cache miss
    }
}

export async function setCachedMasters(
    fen: string,
    data: MastersExplorerResult | null
): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const entry: CachedEntry = { data, fetchedAt: Date.now() };
            const req = store.put(entry, fen);
            req.onsuccess = () => {
                db.close();
                resolve();
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        });
    } catch {
        // Silently ignore — caching is best-effort
    }
}

export async function clearMastersIDBCache(): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.clear();
            req.onsuccess = () => {
                db.close();
                resolve();
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        });
    } catch {
        // Silently ignore
    }
}

// Exported for testing
export const _test = { DB_NAME, DB_VERSION, STORE_NAME, TTL_MS };
