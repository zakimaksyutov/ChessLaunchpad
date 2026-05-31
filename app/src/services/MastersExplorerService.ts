import { openDB, type IDBPDatabase } from 'idb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MastersMoveStats {
    san: string;
    white: number;
    draws: number;
    black: number;
    total: number;
}

export interface MastersPositionResult {
    fen: string;
    totalGames: number;
    moves: MastersMoveStats[];
}

export interface MoveStats {
    moveGames: number;
    totalGames: number;
    percentage: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum absolute master games for a specific move to be considered theory. */
export const MIN_MASTER_GAMES = 5;

/**
 * Absolute game-count override: if a move has been played at least this many
 * times in master games it is always considered theory, regardless of its
 * percentage share of the position.
 */
export const MIN_MASTER_GAMES_ABSOLUTE = 50;

/** Minimum percentage of position's total games for a move to be theory. */
export const MIN_MOVE_PERCENTAGE = 5;

/** Delay between API requests in milliseconds. */
const MASTERS_RATE_LIMIT_MS = 1000;

const MASTERS_API_URL = 'https://explorer.lichess.org/masters';

// ---------------------------------------------------------------------------
// IndexedDB cache
// ---------------------------------------------------------------------------

const MASTERS_DB_NAME = 'chesslaunchpad-masters-explorer';
const MASTERS_DB_VERSION = 1;
const MASTERS_STORE = 'positions';

let mastersDbPromise: Promise<IDBPDatabase> | null = null;

function getMastersDB(): Promise<IDBPDatabase> {
    if (!mastersDbPromise) {
        mastersDbPromise = openDB(MASTERS_DB_NAME, MASTERS_DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(MASTERS_STORE)) {
                    db.createObjectStore(MASTERS_STORE);
                }
            },
        });
    }
    return mastersDbPromise;
}

/**
 * Compact FEN key: piece placement + side + castling + en passant.
 * Strips halfmove clock and fullmove number so transpositions cache-hit.
 */
export function toMastersCacheKey(fen: string): string {
    return fen.split(' ').slice(0, 4).join(' ');
}

async function getPersistedMasters(key: string): Promise<MastersPositionResult | null> {
    try {
        const db = await getMastersDB();
        const val = await db.get(MASTERS_STORE, key);
        return val ?? null;
    } catch {
        return null;
    }
}

async function persistMasters(key: string, result: MastersPositionResult): Promise<void> {
    try {
        const db = await getMastersDB();
        await db.put(MASTERS_STORE, result, key);
    } catch {
        // Best-effort persistence
    }
}

/** Load all cached master positions from IndexedDB. */
async function getAllPersistedMasters(): Promise<Map<string, MastersPositionResult>> {
    const result = new Map<string, MastersPositionResult>();
    try {
        const db = await getMastersDB();
        const tx = db.transaction(MASTERS_STORE, 'readonly');
        let cursor = await tx.store.openCursor();
        while (cursor) {
            result.set(cursor.key as string, cursor.value as MastersPositionResult);
            cursor = await cursor.continue();
        }
    } catch {
        // Best-effort — return whatever we managed to read
    }
    return result;
}

/** Bulk-delete master positions from IndexedDB by their compact FEN keys. */
async function deleteMasterKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
        const db = await getMastersDB();
        const tx = db.transaction(MASTERS_STORE, 'readwrite');
        for (const key of keys) {
            tx.store.delete(key);
        }
        await tx.done;
    } catch {
        // Best-effort
    }
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, MastersPositionResult>();

// ---------------------------------------------------------------------------
// Rate-limited fetch queue
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

/** Clear both in-memory and IndexedDB masters caches. */
export async function clearMastersCache(): Promise<void> {
    memoryCache.clear();
    try {
        const db = await getMastersDB();
        await db.clear(MASTERS_STORE);
    } catch {
        // Best-effort
    }
}

async function rateLimitedDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MASTERS_RATE_LIMIT_MS) {
        await new Promise(resolve => setTimeout(resolve, MASTERS_RATE_LIMIT_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

/**
 * Parse the Lichess masters explorer API response.
 */
function parseApiResponse(data: Record<string, unknown>, fen: string): MastersPositionResult {
    const rawMoves = (data.moves as Array<Record<string, unknown>>) || [];
    const moves: MastersMoveStats[] = rawMoves.map(m => {
        const white = (m.white as number) || 0;
        const draws = (m.draws as number) || 0;
        const black = (m.black as number) || 0;
        return {
            san: (m.san as string) || '',
            white,
            draws,
            black,
            total: white + draws + black,
        };
    });

    const totalGames = moves.reduce((sum, m) => sum + m.total, 0);

    return { fen, totalGames, moves };
}

/**
 * Fetch masters data for a single position from the Lichess API.
 * Returns null on error.
 */
export async function fetchMastersPosition(
    fen: string,
    token: string,
    fetchFn: typeof fetch = fetch
): Promise<MastersPositionResult | null> {
    const key = toMastersCacheKey(fen);

    // Check in-memory cache
    const memCached = memoryCache.get(key);
    if (memCached) return memCached;

    // Check IndexedDB cache
    const persisted = await getPersistedMasters(key);
    if (persisted) {
        memoryCache.set(key, persisted);
        return persisted;
    }

    // Rate-limited API call
    await rateLimitedDelay();

    try {
        const url = `${MASTERS_API_URL}?fen=${encodeURIComponent(fen)}`;
        const response = await fetchFn(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!response.ok) return null;

        const data = await response.json();
        const result = parseApiResponse(data, fen);

        // Cache the result
        memoryCache.set(key, result);
        await persistMasters(key, result);

        return result;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// MastersLookup — query interface for GameAnnotationService
// ---------------------------------------------------------------------------

/** Compute per-move stats from a fetched position result. */
function computeMoveStats(posResult: MastersPositionResult, moveSan: string): MoveStats {
    const moveData = posResult.moves.find(m => m.san === moveSan);
    const moveGames = moveData ? moveData.total : 0;
    const totalGames = posResult.totalGames;
    const percentage = totalGames > 0 ? (moveGames / totalGames) * 100 : 0;
    return { moveGames, totalGames, percentage };
}

/** Classify a move as out-of-theory (true), in-theory (false), or unknown (null) from its stats. */
function classifyOutOfTheory(stats: MoveStats | null): boolean | null {
    if (stats === null) return null;
    if (stats.moveGames >= MIN_MASTER_GAMES_ABSOLUTE) return false;
    return stats.moveGames < MIN_MASTER_GAMES || stats.percentage < MIN_MOVE_PERCENTAGE;
}

export class MastersLookup {
    private results = new Map<string, MastersPositionResult>();

    /** Add a fetched result to the lookup. */
    add(fen: string, result: MastersPositionResult): void {
        this.results.set(toMastersCacheKey(fen), result);
    }

    /**
     * Get stats for a specific move from a position.
     * Returns null if the position hasn't been fetched.
     */
    getMoveStats(fen: string, moveSan: string): MoveStats | null {
        const posResult = this.results.get(toMastersCacheKey(fen));
        return posResult ? computeMoveStats(posResult, moveSan) : null;
    }

    /**
     * Check whether a move should be considered out-of-theory based on masters data.
     * Returns true if the move is out of theory, false if in theory, null if no data.
     */
    isOutOfTheory(fen: string, moveSan: string): boolean | null {
        return classifyOutOfTheory(this.getMoveStats(fen, moveSan));
    }
}

// ---------------------------------------------------------------------------
// MastersCache — hit-counted cache with lifecycle management
// ---------------------------------------------------------------------------

interface CacheEntry {
    result: MastersPositionResult;
    hitCount: number;
}

/**
 * A cache of master positions loaded from IndexedDB at page load.
 * Tracks hit counts so unused positions can be purged after Sync Games.
 *
 * Implements the same query interface as MastersLookup (getMoveStats, isOutOfTheory)
 * so it can be passed to annotateGame.
 */
export class MastersCache {
    private entries = new Map<string, CacheEntry>();

    /** Load all cached master positions from IndexedDB into memory (hitCount=0). */
    static async loadAll(): Promise<MastersCache> {
        const cache = new MastersCache();
        const persisted = await getAllPersistedMasters();
        for (const [key, result] of persisted) {
            cache.entries.set(key, { result, hitCount: 0 });
        }
        return cache;
    }

    /** Number of cached positions. */
    get size(): number {
        return this.entries.size;
    }

    /**
     * Get stats for a specific move from a position.
     * Increments hitCount when the position is found.
     * Returns null if the position isn't cached.
     */
    getMoveStats(fen: string, moveSan: string): MoveStats | null {
        const entry = this.entries.get(toMastersCacheKey(fen));
        if (!entry) return null;

        entry.hitCount++;
        return computeMoveStats(entry.result, moveSan);
    }

    /**
     * Check whether a move should be considered out-of-theory based on masters data.
     * Returns true if out of theory, false if in theory, null if no data.
     * Note: hitCount is incremented by the underlying getMoveStats call.
     */
    isOutOfTheory(fen: string, moveSan: string): boolean | null {
        return classifyOutOfTheory(this.getMoveStats(fen, moveSan));
    }

    /** Check whether a position is cached (does NOT increment hitCount). */
    has(fen: string): boolean {
        return this.entries.has(toMastersCacheKey(fen));
    }

    /**
     * Fetch a position from cache or API. If cached, increments hitCount and returns.
     * If not cached, fetches from the Lichess API (rate-limited), stores in
     * IndexedDB and memory with hitCount=1.
     * Returns null on API error.
     */
    async fetchOrGet(
        fen: string,
        token: string,
        fetchFn: typeof fetch = fetch
    ): Promise<MastersPositionResult | null> {
        const key = toMastersCacheKey(fen);
        const entry = this.entries.get(key);
        if (entry) {
            entry.hitCount++;
            return entry.result;
        }

        // Not in cache — fetch from API (respects rate limit and page budget)
        const result = await fetchMastersPosition(fen, token, fetchFn);
        if (result) {
            this.entries.set(key, { result, hitCount: 1 });
        }
        return result;
    }

    /** Reset all hit counts to 0 (call before a new annotation cycle). */
    resetHitCounts(): void {
        for (const entry of this.entries.values()) {
            entry.hitCount = 0;
        }
    }

    /**
     * Delete positions with hitCount=0 from both memory and IndexedDB.
     * Returns the number of positions deleted.
     */
    async purgeUnused(): Promise<number> {
        const keysToDelete: string[] = [];
        for (const [key, entry] of this.entries) {
            if (entry.hitCount === 0) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.entries.delete(key);
        }

        await deleteMasterKeys(keysToDelete);
        return keysToDelete.length;
    }
}
