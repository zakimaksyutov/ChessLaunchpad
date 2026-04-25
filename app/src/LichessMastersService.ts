import { uciToSan } from './LichessCloudEvalService';

const MASTERS_API = 'https://explorer.lichess.ovh/masters';

export interface MastersMoveData {
    san: string;
    uci: string;
    white: number;
    draws: number;
    black: number;
    totalGames: number;
    whitePercent: number;
    drawPercent: number;
    blackPercent: number;
    averageRating: number;
}

export interface MastersExplorerResult {
    fen: string;
    moves: MastersMoveData[];
    totalWhite: number;
    totalDraws: number;
    totalBlack: number;
    totalGames: number;
}

/**
 * Compute win/draw/loss percentages from raw counts.
 * Returns 0 for all if totalGames is 0.
 */
export function computePercentages(
    white: number,
    draws: number,
    black: number
): { whitePercent: number; drawPercent: number; blackPercent: number } {
    const total = white + draws + black;
    if (total === 0) return { whitePercent: 0, drawPercent: 0, blackPercent: 0 };
    return {
        whitePercent: Math.round((white / total) * 100),
        drawPercent: Math.round((draws / total) * 100),
        blackPercent: Math.round((black / total) * 100),
    };
}

/** Format a game count with thousand separators. */
export function formatGameCount(n: number): string {
    return n.toLocaleString();
}

// In-memory cache keyed by FEN
const mastersCache = new Map<string, Promise<MastersExplorerResult | null>>();

/** Clear the masters cache (useful for tests). */
export function clearMastersCache(): void {
    mastersCache.clear();
}

/**
 * Fetch masters explorer with deduplication/caching.
 * Repeated calls for the same FEN return the same promise.
 */
export function fetchMastersExplorerCached(
    fen: string,
    token: string,
    fetchFn: typeof fetch = fetch
): Promise<MastersExplorerResult | null> {
    const cached = mastersCache.get(fen);
    if (cached) return cached;
    const promise = fetchMastersExplorer(fen, token, fetchFn).then((result) => {
        if (result === null) {
            mastersCache.delete(fen);
        }
        return result;
    });
    mastersCache.set(fen, promise);
    return promise;
}

/**
 * Fetch master game statistics from the Lichess Opening Explorer.
 * Returns null on error, 401, or if no data is available.
 */
export async function fetchMastersExplorer(
    fen: string,
    token: string,
    fetchFn: typeof fetch = fetch
): Promise<MastersExplorerResult | null> {
    try {
        const url = `${MASTERS_API}?fen=${encodeURIComponent(fen)}`;
        const response = await fetchFn(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            return null;
        }
        const data = await response.json();

        const moves: MastersMoveData[] = [];
        for (const m of data.moves || []) {
            const white = m.white ?? 0;
            const draws = m.draws ?? 0;
            const black = m.black ?? 0;
            const totalGames = white + draws + black;
            const { whitePercent, drawPercent, blackPercent } = computePercentages(white, draws, black);

            // Convert UCI to SAN if san not provided
            const san = m.san || uciToSan(fen, m.uci) || m.uci;

            moves.push({
                san,
                uci: m.uci || '',
                white,
                draws,
                black,
                totalGames,
                whitePercent,
                drawPercent,
                blackPercent,
                averageRating: m.averageRating ?? 0,
            });
        }

        // Sort by total games descending
        moves.sort((a, b) => b.totalGames - a.totalGames);

        const totalWhite = data.white ?? 0;
        const totalDraws = data.draws ?? 0;
        const totalBlack = data.black ?? 0;

        return {
            fen,
            moves,
            totalWhite,
            totalDraws,
            totalBlack,
            totalGames: totalWhite + totalDraws + totalBlack,
        };
    } catch {
        return null;
    }
}
