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
    const batch = await getCachedMastersBatch([fen]);
    return batch.get(fen);
}

/**
 * Batch-read multiple FENs from the cache in a single IndexedDB transaction.
 * Returns a map where `undefined` means cache miss (or stale), `null` means
 * the API returned no data, and a result object is a valid cache hit.
 */
export async function getCachedMastersBatch(
    fens: string[]
): Promise<Map<string, MastersExplorerResult | null | undefined>> {
    const results = new Map<string, MastersExplorerResult | null | undefined>();
    if (fens.length === 0) return results;
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const now = Date.now();
            for (const fen of fens) {
                const req = store.get(fen);
                req.onsuccess = () => {
                    const entry = req.result as CachedEntry | undefined;
                    if (!entry || now - entry.fetchedAt > TTL_MS) {
                        results.set(fen, undefined);
                    } else {
                        results.set(fen, entry.data);
                    }
                };
                req.onerror = () => {
                    results.set(fen, undefined);
                };
            }
            tx.oncomplete = () => {
                db.close();
                resolve(results);
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
            tx.onabort = () => {
                db.close();
                reject(tx.error);
            };
        });
    } catch {
        for (const fen of fens) results.set(fen, undefined);
        return results;
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

export async function getCacheEntryCount(): Promise<number | null> {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.count();
            req.onsuccess = () => {
                db.close();
                resolve(req.result);
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        });
    } catch {
        return null; // IndexedDB unavailable
    }
}

// Exported for testing
export const _test = { DB_NAME, DB_VERSION, STORE_NAME, TTL_MS };
