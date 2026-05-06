import { StoredGame, storeGames } from './GamesDB';

const SYNC_TIMESTAMP_PREFIX = 'chesslaunchpad:lastSyncTimestamp:';
const BATCH_SIZE = 20;

function getLastSyncTimestamp(username: string): number | null {
    const raw = localStorage.getItem(SYNC_TIMESTAMP_PREFIX + username);
    return raw ? parseInt(raw, 10) : null;
}

function setLastSyncTimestamp(username: string, timestamp: number): void {
    localStorage.setItem(SYNC_TIMESTAMP_PREFIX + username, timestamp.toString());
}

export interface SyncProgress {
    username: string;
    gamesDownloaded: number;
    done: boolean;
}

/**
 * Download recent games for a Lichess user via the NDJSON streaming API.
 * Stores results in IndexedDB and tracks sync timestamps for incremental fetches.
 */
export async function syncGamesForUser(
    username: string,
    onProgress?: (progress: SyncProgress) => void
): Promise<number> {
    const params = new URLSearchParams({
        rated: 'true',
        perfType: 'blitz,rapid',
        clocks: 'true',
        evals: 'true',
        opening: 'true',
    });

    const lastSync = getLastSyncTimestamp(username);
    if (lastSync !== null) {
        params.set('since', (lastSync + 1).toString());
        // Use ascending order for incremental syncs so the watermark advances
        // continuously through the backlog instead of jumping to the newest.
        params.set('sort', 'dateAsc');
    } else {
        // Initial fetch: newest first, capped
        params.set('max', BATCH_SIZE.toString());
    }

    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;

    const response = await fetch(url, {
        headers: {
            'Accept': 'application/x-ndjson',
        },
    });

    if (!response.ok) {
        throw new Error(`Lichess API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const games: StoredGame[] = [];
    let maxTimestamp = lastSync ?? 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Split on newlines, process complete lines
            const lines = buffer.split('\n');
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const gameData = JSON.parse(trimmed);
                    const createdAt = gameData.createdAt as number;
                    const gameId = gameData.id as string;

                    games.push({
                        id: gameId,
                        createdAt,
                        username: username.toLowerCase(),
                        data: gameData,
                    });

                    if (createdAt > maxTimestamp) {
                        maxTimestamp = createdAt;
                    }

                    onProgress?.({
                        username,
                        gamesDownloaded: games.length,
                        done: false,
                    });
                } catch {
                    // Skip malformed lines
                }
            }
        }

        // Process any remaining data in buffer
        if (buffer.trim()) {
            try {
                const gameData = JSON.parse(buffer.trim());
                const createdAt = gameData.createdAt as number;
                const gameId = gameData.id as string;

                games.push({
                    id: gameId,
                    createdAt,
                    username: username.toLowerCase(),
                    data: gameData,
                });

                if (createdAt > maxTimestamp) {
                    maxTimestamp = createdAt;
                }
            } catch {
                // Skip malformed data
            }
        }
    } finally {
        reader.cancel().catch(() => { /* best-effort cleanup */ });
    }

    // Batched write to IndexedDB
    if (games.length > 0) {
        await storeGames(games);
        setLastSyncTimestamp(username, maxTimestamp);
    }

    onProgress?.({
        username,
        gamesDownloaded: games.length,
        done: true,
    });

    return games.length;
}
