import { StoredGame, storeGames } from './GamesDB';
import { getSyncTimestampKey } from './LinkedAccountsService';
import { SyncProgress } from './LichessGamesService';

const BATCH_SIZE = 50; // Max games to store on initial sync

function getLastSyncTimestamp(username: string): number | null {
    const key = getSyncTimestampKey('chess.com', username);
    const raw = localStorage.getItem(key);
    return raw ? parseInt(raw, 10) : null;
}

function setLastSyncTimestamp(username: string, timestamp: number): void {
    const key = getSyncTimestampKey('chess.com', username);
    localStorage.setItem(key, timestamp.toString());
}

interface ChesscomGame {
    url: string;
    pgn: string;
    time_control: string;
    end_time: number;
    rated: boolean;
    time_class: string;
    rules: string;
    uuid: string;
    white: { username: string; rating: number; result: string };
    black: { username: string; rating: number; result: string };
    initial_setup?: string;
    accuracies?: { white: number; black: number };
}

interface ChesscomArchivesResponse {
    archives: string[];
}

interface ChesscomGamesResponse {
    games: ChesscomGame[];
}

/**
 * Fetch the list of monthly archive URLs for a Chess.com user.
 */
async function fetchArchives(username: string): Promise<string[]> {
    const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Chess.com API error: ${response.status} ${response.statusText}`);
    }
    const data: ChesscomArchivesResponse = await response.json();
    return data.archives || [];
}

/**
 * Fetch games for a specific monthly archive URL.
 */
async function fetchMonthGames(archiveUrl: string): Promise<ChesscomGame[]> {
    const response = await fetch(archiveUrl);
    if (!response.ok) {
        throw new Error(`Chess.com API error: ${response.status} ${response.statusText}`);
    }
    const data: ChesscomGamesResponse = await response.json();
    return data.games || [];
}

/**
 * Filter games to only include rated blitz/rapid standard chess games.
 */
function filterGames(games: ChesscomGame[]): ChesscomGame[] {
    return games.filter(g =>
        g.rated &&
        (g.time_class === 'blitz' || g.time_class === 'rapid') &&
        g.rules === 'chess'
    );
}

/**
 * Determine which archive months to fetch based on the sync watermark.
 * For incremental sync: all months from the watermark month onward.
 * For initial sync: return all archives (newest first) so we can stop once we have enough games.
 */
function getArchivesToFetch(archives: string[], lastSyncMs: number | null): string[] {
    if (lastSyncMs === null) {
        // Initial sync: return all archives newest-first; caller will stop once BATCH_SIZE is reached
        return [...archives].reverse();
    }

    // Incremental sync: find which months we need
    const watermarkDate = new Date(lastSyncMs);
    const watermarkYear = watermarkDate.getUTCFullYear();
    const watermarkMonth = watermarkDate.getUTCMonth() + 1; // 1-based

    return archives.filter(url => {
        // URL format: https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}
        const parts = url.split('/');
        const month = parseInt(parts[parts.length - 1], 10);
        const year = parseInt(parts[parts.length - 2], 10);
        // Include the watermark month and all months after
        return year > watermarkYear || (year === watermarkYear && month >= watermarkMonth);
    });
}

/**
 * Download recent games for a Chess.com user.
 * Stores results in IndexedDB and tracks sync timestamps for incremental fetches.
 */
export async function syncChesscomGamesForUser(
    username: string,
    onProgress?: (progress: SyncProgress) => void
): Promise<number> {
    const archives = await fetchArchives(username);
    if (archives.length === 0) {
        onProgress?.({ username, gamesDownloaded: 0, done: true });
        return 0;
    }

    const lastSync = getLastSyncTimestamp(username);
    const archivesToFetch = getArchivesToFetch(archives, lastSync);

    const games: StoredGame[] = [];
    let maxTimestamp = lastSync ?? 0;
    let minTimestamp = Infinity;

    for (const archiveUrl of archivesToFetch) {
        const monthGames = await fetchMonthGames(archiveUrl);
        const filtered = filterGames(monthGames);

        for (const game of filtered) {
            const createdAtMs = game.end_time * 1000;

            // Skip games we've already synced
            if (lastSync !== null && createdAtMs <= lastSync) continue;

            const gameId = `chesscom_${game.uuid}`;

            games.push({
                id: gameId,
                createdAt: createdAtMs,
                username: username.toLowerCase(),
                platform: 'chess.com',
                data: game as unknown as Record<string, unknown>,
            });

            if (createdAtMs > maxTimestamp) {
                maxTimestamp = createdAtMs;
            }
            if (createdAtMs < minTimestamp) {
                minTimestamp = createdAtMs;
            }

            onProgress?.({
                username,
                gamesDownloaded: games.length,
                done: false,
            });

            // Cap initial sync
            if (lastSync === null && games.length >= BATCH_SIZE) break;
        }

        // Cap initial sync across months
        if (lastSync === null && games.length >= BATCH_SIZE) break;
    }

    // Batched write to IndexedDB
    if (games.length > 0) {
        await storeGames(games);
        // For initial sync, use the oldest fetched game as the watermark.
        // This ensures incremental sync refetches from the oldest month forward,
        // picking up any games that were missed due to the BATCH_SIZE cap.
        // Duplicate IDs are handled by IndexedDB put (idempotent overwrite).
        const watermark = lastSync === null ? minTimestamp : maxTimestamp;
        setLastSyncTimestamp(username, watermark);
    }

    onProgress?.({
        username,
        gamesDownloaded: games.length,
        done: true,
    });

    return games.length;
}

/**
 * Parse Chess.com time_control string into a human-readable format.
 * Examples: "600" → "10+0", "300+5" → "5+5", "180" → "3+0"
 */
export function parseChesscomTimeControl(tc: string): string {
    if (!tc) return '';
    if (tc.includes('+')) {
        const [base, inc] = tc.split('+');
        const minutes = Math.floor(parseInt(base, 10) / 60);
        return `${minutes}+${inc}`;
    }
    if (tc.includes('/')) {
        // Daily/correspondence format
        return tc;
    }
    const seconds = parseInt(tc, 10);
    if (isNaN(seconds)) return tc;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}+0`;
}
