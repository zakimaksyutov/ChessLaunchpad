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

/** Minimum percentage of position's total games for a move to be theory. */
export const MIN_MOVE_PERCENTAGE = 5;

/** Delay between API requests in milliseconds. */
const MASTERS_RATE_LIMIT_MS = 1000;

/** Maximum number of uncached API calls per page load. */
const MASTERS_PAGE_BUDGET = 20;

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
function toCompactFen(fen: string): string {
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

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, MastersPositionResult>();

// ---------------------------------------------------------------------------
// Rate-limited fetch queue
// ---------------------------------------------------------------------------

let pageLoadApiCalls = 0;
let lastRequestTime = 0;

/** Reset page-load budget (call when the page mounts). */
export function resetMastersPageBudget(): void {
    pageLoadApiCalls = 0;
}

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
 * Returns null on error or if budget is exhausted.
 */
export async function fetchMastersPosition(
    fen: string,
    token: string,
    fetchFn: typeof fetch = fetch
): Promise<MastersPositionResult | null> {
    const key = toCompactFen(fen);

    // Check in-memory cache
    const memCached = memoryCache.get(key);
    if (memCached) return memCached;

    // Check IndexedDB cache
    const persisted = await getPersistedMasters(key);
    if (persisted) {
        memoryCache.set(key, persisted);
        return persisted;
    }

    // Check page budget
    if (pageLoadApiCalls >= MASTERS_PAGE_BUDGET) {
        return null;
    }

    // Rate-limited API call
    await rateLimitedDelay();
    pageLoadApiCalls++;

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

export class MastersLookup {
    private results = new Map<string, MastersPositionResult>();

    /** Add a fetched result to the lookup. */
    add(fen: string, result: MastersPositionResult): void {
        this.results.set(toCompactFen(fen), result);
    }

    /**
     * Get stats for a specific move from a position.
     * Returns null if the position hasn't been fetched.
     */
    getMoveStats(fen: string, moveSan: string): MoveStats | null {
        const key = toCompactFen(fen);
        const posResult = this.results.get(key);
        if (!posResult) return null;

        const moveData = posResult.moves.find(m => m.san === moveSan);
        const moveGames = moveData ? moveData.total : 0;
        const totalGames = posResult.totalGames;
        const percentage = totalGames > 0 ? (moveGames / totalGames) * 100 : 0;

        return { moveGames, totalGames, percentage };
    }

    /**
     * Check whether a move should be considered out-of-theory based on masters data.
     * Returns true if the move is out of theory, false if in theory, null if no data.
     */
    isOutOfTheory(fen: string, moveSan: string): boolean | null {
        const stats = this.getMoveStats(fen, moveSan);
        if (stats === null) return null;

        return stats.moveGames < MIN_MASTER_GAMES || stats.percentage < MIN_MOVE_PERCENTAGE;
    }
}

/**
 * Fetch masters data for a batch of positions.
 * Checks caches first, then fetches uncached positions rate-limited.
 * Returns a populated MastersLookup.
 *
 * @param onProgress Optional callback invoked after each position is processed
 *                   with (fetched, total) counts.
 */
export async function fetchMastersForPositions(
    positions: { fen: string }[],
    token: string,
    fetchFn: typeof fetch = fetch,
    onProgress?: (fetched: number, total: number) => void,
): Promise<MastersLookup> {
    const lookup = new MastersLookup();

    // Deduplicate by compact FEN
    const uniqueFens = new Map<string, string>();
    for (const pos of positions) {
        const key = toCompactFen(pos.fen);
        if (!uniqueFens.has(key)) {
            uniqueFens.set(key, pos.fen);
        }
    }

    const total = uniqueFens.size;
    let fetched = 0;

    for (const [, fen] of uniqueFens) {
        const result = await fetchMastersPosition(fen, token, fetchFn);
        if (result) {
            lookup.add(fen, result);
        }
        fetched++;
        onProgress?.(fetched, total);
    }

    return lookup;
}
