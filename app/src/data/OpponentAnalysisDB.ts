import { openDB, type IDBPDatabase } from 'idb';
import type { Platform } from '../services/LinkedAccountsService';

const DB_NAME = 'chesslaunchpad-opponent-analysis';
const DB_VERSION = 1;
const STORE_NAME = 'analyses';

export type ThreatLevel = 'low' | 'moderate' | 'high' | 'very-high';

export interface OpponentGameRef {
    /** Timestamp in milliseconds */
    date: number;
    /** URL to the game on Lichess/Chess.com */
    url: string;
}

export interface OpponentAnalysisResult {
    gameId: string;
    opponentUsername: string;
    platform: Platform;
    /** Number of opponent games downloaded and analyzed */
    gamesAnalyzed: number;
    /** How many opponent games reached the position before the user's bad move */
    positionBeforeCount: number;
    /** How many opponent games reached the position after the user's bad move */
    positionAfterCount: number;
    /** Up to 5 most recent opponent games that reached the before-position */
    recentBeforeGames: OpponentGameRef[];
    /** Up to 5 most recent opponent games that reached the after-position */
    recentAfterGames: OpponentGameRef[];
    /** The opponent's move SAN (e.g., "Nxe4") */
    opponentMoveSan: string;
    /** The user's bad move SAN (e.g., "exd6") */
    userMoveSan: string;
    /** Computed threat level */
    threatLevel: ThreatLevel;
    /** When this analysis was performed */
    analyzedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'gameId' });
                }
            },
        });
    }
    return dbPromise;
}

export function computeThreatLevel(positionBeforeCount: number): ThreatLevel {
    if (positionBeforeCount >= 25) return 'very-high';
    if (positionBeforeCount >= 10) return 'high';
    if (positionBeforeCount >= 3) return 'moderate';
    return 'low';
}

export async function saveOpponentAnalysis(result: OpponentAnalysisResult): Promise<void> {
    const db = await getDB();
    await db.put(STORE_NAME, result);
}

export async function getOpponentAnalysis(gameId: string): Promise<OpponentAnalysisResult | undefined> {
    const db = await getDB();
    return db.get(STORE_NAME, gameId);
}

export async function getAllOpponentAnalyses(): Promise<OpponentAnalysisResult[]> {
    const db = await getDB();
    return db.getAll(STORE_NAME);
}

export async function deleteOpponentAnalysis(gameId: string): Promise<void> {
    const db = await getDB();
    await db.delete(STORE_NAME, gameId);
}
