import { StoredGame, storeGames } from '../data/GamesDB';
import { getSyncTimestampKey } from './LinkedAccountsService';

const BATCH_SIZE = 100;

function getLastSyncTimestamp(username: string): number | null {
    const raw = localStorage.getItem(getSyncTimestampKey('lichess', username));
    return raw ? parseInt(raw, 10) : null;
}

function setLastSyncTimestamp(username: string, timestamp: number): void {
    localStorage.setItem(getSyncTimestampKey('lichess', username), timestamp.toString());
}

export interface SyncProgress {
    username: string;
    gamesDownloaded: number;
    done: boolean;
}

/**
 * Parse one NDJSON game payload and push it into `games`.
 * Updates `state.maxTimestamp` and (optionally) reports progress.
 * Silently ignores malformed JSON.
 */
function pushGame(
    rawJson: string,
    username: string,
    games: StoredGame[],
    state: { maxTimestamp: number },
    onProgress?: (progress: SyncProgress) => void
): void {
    try {
        const gameData = JSON.parse(rawJson);
        const createdAt = gameData.createdAt as number;
        const gameId = gameData.id as string;

        games.push({
            id: gameId,
            createdAt,
            username: username.toLowerCase(),
            platform: 'lichess',
            data: gameData,
        });

        if (createdAt > state.maxTimestamp) {
            state.maxTimestamp = createdAt;
        }

        onProgress?.({
            username,
            gamesDownloaded: games.length,
            done: false,
        });
    } catch {
        // Skip malformed JSON
    }
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
    const state = { maxTimestamp: lastSync ?? 0 };

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
                pushGame(trimmed, username, games, state, onProgress);
            }
        }

        // Process any remaining data in buffer (no progress callback — final
        // progress event is emitted below with done:true)
        const tail = buffer.trim();
        if (tail) {
            pushGame(tail, username, games, state);
        }
    } finally {
        reader.cancel().catch(() => { /* best-effort cleanup */ });
    }

    // Batched write to IndexedDB
    if (games.length > 0) {
        await storeGames(games);
        setLastSyncTimestamp(username, state.maxTimestamp);
    }

    onProgress?.({
        username,
        gamesDownloaded: games.length,
        done: true,
    });

    return games.length;
}
