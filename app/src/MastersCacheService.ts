import { MastersExplorerResult } from './LichessMastersService';

const DB_NAME = 'chess-launchpad';
const DB_VERSION = 1;
const STORE_NAME = 'masters-explorer';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface CachedEntry {
    data: MastersExplorerResult | null;
    fetchedAt: number;
}

// Shared in-memory mirror of the IDB store.
let memoryCache = new Map<string, MastersExplorerResult | null>();

// Promise that resolves once the IDB store has been loaded into memory.
// null until preloadMastersCacheToMemory() is first called.
let preloadPromise: Promise<void> | null = null;

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
 * Call early (e.g. on page mount). All cache reads await this promise
 * before doing synchronous Map lookups.
 */
export function preloadMastersCacheToMemory(): Promise<void> {
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
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
            // IDB unavailable — memoryCache stays empty, all lookups are misses
        }
    })();
    return preloadPromise;
}

/** Wait for preload, then look up a single FEN. */
export async function getCachedMasters(fen: string): Promise<MastersExplorerResult | null | undefined> {
    await preloadMastersCacheToMemory();
    return memoryCache.has(fen) ? memoryCache.get(fen)! : undefined;
}

export async function setCachedMasters(
    fen: string,
    data: MastersExplorerResult | null
): Promise<void> {
    memoryCache.set(fen, data);
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
    memoryCache.clear();
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
    await preloadMastersCacheToMemory();
    return memoryCache.size;
}

/** Reset the in-memory cache (for testing). */
export function _resetMemoryCache(): void {
    memoryCache = new Map();
    preloadPromise = null;
}

// Exported for testing
export const _test = { DB_NAME, DB_VERSION, STORE_NAME, TTL_MS };
