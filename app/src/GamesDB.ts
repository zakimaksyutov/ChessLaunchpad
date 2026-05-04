import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'chesslaunchpad-games-db';
const DB_VERSION = 1;
const STORE_NAME = 'games';

export interface StoredGame {
    id: string;
    createdAt: number;
    username: string;
    data: Record<string, unknown>;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
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
