import { MastersExplorerResult } from './LichessMastersService';

const DB_NAME = 'chess-launchpad';
const DB_VERSION = 1;
const STORE_NAME = 'masters-explorer';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface CachedEntry {
    data: MastersExplorerResult | null;
    fetchedAt: number;
}

// Shared in-memory mirror of the IDB store. null = not yet hydrated.
let memoryCache: Map<string, MastersExplorerResult | null> | null = null;

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

/**
 * Preload the entire IDB masters cache into memory in a single cursor scan.
 * Call on page mount (fire-and-forget). Once hydrated, all cache reads
 * become synchronous Map lookups instead of IDB transactions.
 */
export async function preloadMastersCacheToMemory(): Promise<void> {
    if (memoryCache !== null) return; // already hydrated
    try {
        const db = await openDB();
        const loaded = await new Promise<Map<string, MastersExplorerResult | null>>((resolve, reject) => {
            const results = new Map<string, MastersExplorerResult | null>();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const cursor = store.openCursor();
            const now = Date.now();
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (c) {
                    const entry = c.value as CachedEntry;
                    if (entry && now - entry.fetchedAt <= TTL_MS) {
                        results.set(c.key as string, entry.data);
                    }
                    c.continue();
                }
            };
            tx.oncomplete = () => { db.close(); resolve(results); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        });
        memoryCache = loaded;
    } catch {
        // IDB unavailable — leave memoryCache null, batch reads will fall back to IDB
    }
}

/**
 * Look up a single FEN in the masters cache.
 * Returns the cached result (may be null = no master data),
 * or undefined on cache miss / not cached.
 */
export async function getCachedMasters(fen: string): Promise<MastersExplorerResult | null | undefined> {
    // Fast path: memory cache is hydrated
    if (memoryCache !== null) {
        return memoryCache.has(fen) ? memoryCache.get(fen)! : undefined;
    }

    // Slow path: IDB lookup (only before preload completes)
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(fen);
            req.onsuccess = () => {
                const entry = req.result as CachedEntry | undefined;
                if (!entry || Date.now() - entry.fetchedAt > TTL_MS) {
                    resolve(undefined);
                } else {
                    resolve(entry.data);
                }
            };
            tx.oncomplete = () => db.close();
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        });
    } catch {
        return undefined;
    }
}

export async function setCachedMasters(
    fen: string,
    data: MastersExplorerResult | null
): Promise<void> {
    // Update memory mirror if hydrated
    if (memoryCache !== null) {
        memoryCache.set(fen, data);
    }
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
    // Clear memory mirror
    if (memoryCache !== null) {
        memoryCache.clear();
    }
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
    // If memory is hydrated, return its size directly
    if (memoryCache !== null) {
        return memoryCache.size;
    }
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

/** Reset the in-memory cache (for testing). */
export function _resetMemoryCache(): void {
    memoryCache = null;
}

// Exported for testing
export const _test = { DB_NAME, DB_VERSION, STORE_NAME, TTL_MS };
