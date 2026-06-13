export type ThreatLevel = 'low' | 'moderate' | 'high' | 'very-high';

export interface OpponentGameRef {
    /** Timestamp in milliseconds. */
    date: number;
    /** URL to the game on Lichess / Chess.com. */
    url: string;
}

/**
 * In-memory shape of an opponent-analysis result. The persisted shape
 * (`GameRecord.op`) is more compact — it stores raw counts/refs and the
 * page derives `threatLevel` at render.
 *
 * This type is kept for the analysis pipeline (`OpponentAnalysisService`)
 * and the live UI; the page maps between this and `OpponentAnalysisRecord`
 * (the persisted form) when reading and writing the blob.
 */
export interface OpponentAnalysisResult {
    /** Ply of the analyzed user deviation in the source record's `m`. */
    targetPly: number;
    /** Number of opponent games downloaded and scanned. */
    gamesAnalyzed: number;
    /** How many opponent games reached the position BEFORE the user's bad move. */
    positionBeforeCount: number;
    /** How many opponent games reached the position AFTER the user's bad move. */
    positionAfterCount: number;
    /** Up to 5 most recent opponent games that reached the before-position. */
    recentBeforeGames: OpponentGameRef[];
    /** Up to 5 most recent opponent games that reached the after-position. */
    recentAfterGames: OpponentGameRef[];
    /** Opponent's preceding move SAN (e.g. "Nxe4"). */
    opponentMoveSan: string;
    /** User's bad move SAN (e.g. "exd6"). */
    userMoveSan: string;
    /** Computed threat level. */
    threatLevel: ThreatLevel;
    /** When this analysis was performed (ms). */
    analyzedAt: number;
}

/**
 * Map a `positionBeforeCount` into the four-band threat level used by the
 * UI. Thresholds match the original `GAMES.md` spec — pure function, no
 * persistence dependency.
 */
export function computeThreatLevel(positionBeforeCount: number): ThreatLevel {
    if (positionBeforeCount >= 25) return 'very-high';
    if (positionBeforeCount >= 10) return 'high';
    if (positionBeforeCount >= 3) return 'moderate';
    return 'low';
}
