// ---------------------------------------------------------------------------
// MastersExplorerService — Lichess Masters opening explorer client.
//
// No IndexedDB. The Games page (`docs/product-specs/GAMES.md`)
// drops the persistent masters cache: the ambiguous-zone verdict is baked
// into each game's frozen annotation (`fan.hl`) on the synced repertoire blob
// at analysis time, so a game is analyzed once and the result syncs across
// devices. Within a single analysis pass the same opening-sideline positions
// recur across games, but that dedup lives in the pass's `fetchMastersWithMemo`
// (see GameRecordAnalysisPlanner), so this client stays a thin stateless fetcher.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MastersMoveStats {
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

/** Delay between API requests in milliseconds (Lichess rate limit). */
const MASTERS_RATE_LIMIT_MS = 1000;

const MASTERS_API_URL = 'https://explorer.lichess.org/masters';

/**
 * Compact FEN key: piece placement + side + castling + en passant.
 * Strips halfmove clock and fullmove number so transpositions hit the same
 * entry across game histories.
 */
export function toMastersCacheKey(fen: string): string {
    return fen.split(' ').slice(0, 4).join(' ');
}

// ---------------------------------------------------------------------------
// Rate-limited fetch
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

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
 * Fetch outcome for a single masters position query.
 *
 *   - `{ kind: 'ok', result }` — HTTP 200, parsed body. Callers classify
 *                                "no data for this san" themselves via
 *                                `getMoveStats(...) === null` or zero counts.
 *   - `{ kind: 'error' }`      — Transient: network failure, rate-limit (429),
 *                                non-2xx response. **Do not** treat as no-data
 *                                — the analysis pass refuses to write `fan` for
 *                                a game with an erroring ply so it re-queues
 *                                next pass.
 *
 * The distinction matters because the engine's optimistic fallback (`docs/product-specs/GAMES.md`)
 * treats a no-data ambiguous ply as in-theory. Conflating "we couldn't reach
 * the server" with "200 + zero games" would freeze a potentially-wrong
 * optimistic verdict into `fan` forever.
 */
export type MastersFetchOutcome =
    | { kind: 'ok'; result: MastersPositionResult }
    | { kind: 'error' };

/**
 * Fetch masters data for a single position from the Lichess API, surfacing
 * the HTTP/network error vs. success distinction. Always honors the 1 req/sec
 * rate limit (via the shared `lastRequestTime` inside the fetcher).
 *
 * Caller is responsible for caching — within one `/games` analysis pass the
 * page does that via a single `MastersLookup` instance accumulated for the
 * batch; across passes the verdict is frozen into each game's `fan`.
 */
export async function fetchMastersOutcome(
    fen: string,
    token: string,
    fetchFn: typeof fetch = fetch,
): Promise<MastersFetchOutcome> {
    await rateLimitedDelay();
    try {
        const url = `${MASTERS_API_URL}?fen=${encodeURIComponent(fen)}`;
        const response = await fetchFn(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!response.ok) return { kind: 'error' };
        const data = await response.json();
        return { kind: 'ok', result: parseApiResponse(data, fen) };
    } catch {
        return { kind: 'error' };
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
export function classifyOutOfTheory(stats: MoveStats | null): boolean | null {
    if (stats === null) return null;
    if (stats.moveGames >= MIN_MASTER_GAMES_ABSOLUTE) return false;
    return stats.moveGames < MIN_MASTER_GAMES || stats.percentage < MIN_MOVE_PERCENTAGE;
}

/**
 * In-memory lookup for a batch of fetched master positions, satisfying
 * the duck-typed `MastersLookupLike` interface that `GameAnnotationService`
 * consumes. Build by calling `add(fen, result)` for each fetched position;
 * `getMoveStats` returns `null` for any position not added.
 */
export class MastersLookup {
    private results = new Map<string, MastersPositionResult>();

    add(fen: string, result: MastersPositionResult): void {
        this.results.set(toMastersCacheKey(fen), result);
    }

    /** Number of positions cached. */
    get size(): number {
        return this.results.size;
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
