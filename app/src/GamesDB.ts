import { openDB, type IDBPDatabase } from 'idb';
import type { Platform } from './LinkedAccountsService';

const DB_NAME = 'chesslaunchpad-games-db';
const DB_VERSION = 1;
const STORE_NAME = 'games';

export interface StoredGame {
    id: string;
    createdAt: number;
    username: string;
    platform?: Platform;
    data: Record<string, unknown>;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // Games are keyed by a platform-specific ID: Lichess game ID for Lichess,
                    // "chesscom_" + UUID for Chess.com. Collisions across platforms are avoided
                    // by the prefix. If two linked accounts played each other, the later sync
                    // overwrites the earlier entry (accepted trade-off for storage simplicity).
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt');
                    store.createIndex('username', 'username');
                }
            },
        });
    }
    return dbPromise;
}

export async function storeGames(games: StoredGame[]): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (const game of games) {
        tx.store.put(game);
    }
    await tx.done;
}

export async function getAllGames(): Promise<StoredGame[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex(STORE_NAME, 'createdAt');
    return all.reverse(); // Most recent first
}

export async function getGamesForUser(username: string): Promise<StoredGame[]> {
    const db = await getDB();
    const games = await db.getAllFromIndex(STORE_NAME, 'username', username);
    return games.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getGameCount(): Promise<number> {
    const db = await getDB();
    return db.count(STORE_NAME);
}

export async function clearGames(): Promise<void> {
    const db = await getDB();
    await db.clear(STORE_NAME);
}

export async function deleteGamesForUser(username: string): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const index = tx.store.index('username');
    let cursor = await index.openCursor(username);
    while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
    }
    await tx.done;
}

export async function deleteGamesForAccount(platform: Platform, username: string): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const index = tx.store.index('username');
    let cursor = await index.openCursor(username);
    while (cursor) {
        const gamePlatform = (cursor.value as StoredGame).platform ?? 'lichess';
        if (gamePlatform === platform) {
            await cursor.delete();
        }
        cursor = await cursor.continue();
    }
    await tx.done;
}

// ---------------------------------------------------------------------------
// Grooming
// ---------------------------------------------------------------------------

export interface GroomResult {
    deletedCount: number;
    /** Per-account max timestamp among deleted games. Key = "platform:username". */
    deletedMaxTimestamps: Map<string, number>;
}

/**
 * Keep only the top `maxKeep` games (by createdAt desc) in IndexedDB.
 * Deletes the rest and returns per-account max timestamps of deleted games
 * so callers can advance sync watermarks.
 */
export async function groomGames(maxKeep: number): Promise<GroomResult> {
    const allGames = await getAllGames(); // sorted by createdAt desc
    if (allGames.length <= maxKeep) {
        return { deletedCount: 0, deletedMaxTimestamps: new Map() };
    }

    const toDelete = allGames.slice(maxKeep);
    const deletedMaxTimestamps = new Map<string, number>();

    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (const game of toDelete) {
        await tx.store.delete(game.id);
        const platform = game.platform ?? 'lichess';
        const key = `${platform}:${game.username}`;
        const current = deletedMaxTimestamps.get(key) ?? 0;
        if (game.createdAt > current) {
            deletedMaxTimestamps.set(key, game.createdAt);
        }
    }
    await tx.done;

    return { deletedCount: toDelete.length, deletedMaxTimestamps };
}
