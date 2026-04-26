import { Chess } from 'chess.js';
import { EvalDrop } from './EvalDropService';
import { MastersExplorerResult, fetchMastersExplorer } from './LichessMastersService';
import { getCachedMasters, setCachedMasters } from './MastersCacheService';

/** Minimum share of total games for the top move to suppress a highlight. */
const MIN_TOP_MOVE_SHARE = 0.90;

/** Minimum share of total games for an alternative to be considered. */
const MIN_ALT_GAME_SHARE = 0.05;

/** Minimum win-rate advantage (percentage points) for an alternative to block suppression. */
const MIN_ALT_WINRATE_EDGE = 5;

/** If a move has at least this many master games, suppress regardless of share/alternatives. */
const MIN_GAMES_AUTO_SUPPRESS = 150;

/** Delay between Lichess API requests (ms) to respect rate limits. */
const API_THROTTLE_MS = 1000;

export interface MasterOverrideProgress {
    total: number;
    resolved: number;
    done: boolean;
}

export interface FlaggedMove {
    afterFen: string;
    previousFen: string;
    san: string;
    orientation: 'white' | 'black';
}

/**
 * Identify flagged moves (non-ok eval drops) in a single variant's PGN.
 * Returns the list of flagged moves with their before/after FENs and SAN.
 */
export function identifyFlaggedMoves(
    pgn: string,
    orientation: 'white' | 'black',
    evalDrops: Map<string, EvalDrop>
): FlaggedMove[] {
    const flagged: FlaggedMove[] = [];
    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        return flagged;
    }
    chess.deleteComments();
    const moves = chess.history({ verbose: true });
    while (chess.undo()) { /* undo all */ }

    let prevFen = chess.fen();
    for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        try { chess.move(move); } catch { break; }
        const afterFen = chess.fen();

        const drop = evalDrops.get(afterFen);
        if (drop && drop.category !== 'ok') {
            flagged.push({
                afterFen,
                previousFen: prevFen,
                san: move.san,
                orientation,
            });
        }
        prevFen = afterFen;
    }
    return flagged;
}

/**
 * Decide whether a flagged move should be suppressed based on master data.
 *
 * Returns true if the highlight should be removed.
 */
export function shouldSuppressHighlight(
    mastersResult: MastersExplorerResult,
    moveSan: string,
    orientation: 'white' | 'black'
): boolean {
    if (mastersResult.totalGames === 0 || mastersResult.moves.length === 0) {
        return false;
    }

    // Find the played move in master data
    const playedMove = mastersResult.moves.find((m) => m.san === moveSan);
    if (!playedMove) {
        return false;
    }

    // Auto-suppress if the move has enough master games on its own
    if (playedMove.totalGames >= MIN_GAMES_AUTO_SUPPRESS) {
        return true;
    }

    const topMove = mastersResult.moves[0]; // Already sorted by totalGames desc
    if (topMove.san !== moveSan) {
        return false; // Not the top master move
    }

    const share = topMove.totalGames / mastersResult.totalGames;
    if (share < MIN_TOP_MOVE_SHARE) {
        return false; // Doesn't dominate the position
    }

    // Check if any alternative move is popular enough AND has a meaningfully better win rate
    const topWinRate = orientation === 'white' ? topMove.whitePercent : topMove.blackPercent;

    for (let i = 1; i < mastersResult.moves.length; i++) {
        const alt = mastersResult.moves[i];
        const altShare = alt.totalGames / mastersResult.totalGames;
        if (altShare < MIN_ALT_GAME_SHARE) continue;

        const altWinRate = orientation === 'white' ? alt.whitePercent : alt.blackPercent;
        if (altWinRate - topWinRate >= MIN_ALT_WINRATE_EDGE) {
            return false; // A viable alternative has significantly better results
        }
    }

    return true;
}

/**
 * Apply master theory overrides to eval-drop maps for all variants.
 *
 * For each variant with flagged moves, fetches master data for the previous
 * positions and suppresses highlights where the move is the dominant master choice.
 *
 * @param allEvalDrops Map of "orientation::pgn" → Map<afterFen, EvalDrop>
 * @param variants     Array of { pgn, orientation } for each variant
 * @param token        Lichess OAuth token
 * @param onProgress   Progress callback
 * @param signal       AbortSignal to cancel the operation
 * @param fetchFn      Optional fetch override for testing
 * @returns Set of afterFENs whose highlights were suppressed, keyed by "orientation::pgn"
 */
export async function computeMasterOverrides(
    allEvalDrops: Map<string, Map<string, EvalDrop>>,
    variants: { pgn: string; orientation: 'white' | 'black' }[],
    token: string,
    onProgress: (progress: MasterOverrideProgress) => void,
    signal?: AbortSignal,
    fetchFn: typeof fetch = fetch
): Promise<Map<string, Set<string>>> {
    const t0 = performance.now();
    // Collect all flagged moves across all variants
    const allFlagged: { key: string; move: FlaggedMove }[] = [];
    for (const v of variants) {
        const key = `${v.orientation}::${v.pgn}`;
        const drops = allEvalDrops.get(key);
        if (!drops) continue;
        const flagged = identifyFlaggedMoves(v.pgn, v.orientation, drops);
        for (const fm of flagged) {
            allFlagged.push({ key, move: fm });
        }
    }

    // Deduplicate FENs to fetch
    const uniqueFens = new Set<string>();
    for (const { move } of allFlagged) {
        uniqueFens.add(move.previousFen);
    }

    const total = uniqueFens.size;
    let resolved = 0;
    let cacheHits = 0;
    let apiCalls = 0;
    onProgress({ total, resolved, done: false });

    if (total === 0) {
        onProgress({ total: 0, resolved: 0, done: true });
        return new Map();
    }

    // Fetch master data for each unique previous FEN
    const masterDataMap = new Map<string, MastersExplorerResult | null>();
    let needsThrottle = false;

    for (const fen of uniqueFens) {
        if (signal?.aborted) break;

        // Check cache (instant Map lookup when memory is hydrated)
        const cached = await getCachedMasters(fen);
        if (cached !== undefined) {
            masterDataMap.set(fen, cached);
            resolved++;
            cacheHits++;
            if (!signal?.aborted) onProgress({ total, resolved, done: false });
            continue;
        }

        // Throttle between API requests (not before the first one)
        if (needsThrottle) {
            await new Promise((r) => setTimeout(r, API_THROTTLE_MS));
        }

        const result = await fetchMastersExplorer(fen, token, fetchFn);
        masterDataMap.set(fen, result);
        needsThrottle = true;
        apiCalls++;

        // Only cache non-null results; null means transient error (429/5xx/network)
        if (result !== null) {
            try {
                await setCachedMasters(fen, result);
            } catch {
                // IndexedDB write failed — continue without caching
            }
        }

        resolved++;
        if (!signal?.aborted) onProgress({ total, resolved, done: false });
    }

    // Apply suppression logic
    const overrides = new Map<string, Set<string>>();
    for (const { key, move } of allFlagged) {
        const mastersResult = masterDataMap.get(move.previousFen);
        if (!mastersResult) continue;

        if (shouldSuppressHighlight(mastersResult, move.san, move.orientation)) {
            let fenSet = overrides.get(key);
            if (!fenSet) {
                fenSet = new Set<string>();
                overrides.set(key, fenSet);
            }
            fenSet.add(move.afterFen);
        }
    }

    if (!signal?.aborted) onProgress({ total, resolved, done: true });
    console.log('[Perf]', JSON.stringify({
        step: 'master-overrides',
        totalMs: Math.round(performance.now() - t0),
        fens: total,
        cacheHits,
        apiCalls,
    }));
    return overrides;
}

/**
 * Apply overrides to an eval-drop map: set overridden moves to 'ok'.
 * Returns a new map (does not mutate the input).
 */
export function applyOverrides(
    evalDrops: Map<string, EvalDrop>,
    suppressedFens: Set<string>
): Map<string, EvalDrop> {
    const result = new Map<string, EvalDrop>();
    for (const [fen, drop] of evalDrops) {
        if (suppressedFens.has(fen)) {
            result.set(fen, { evalDrop: drop.evalDrop, category: 'ok' });
        } else {
            result.set(fen, drop);
        }
    }
    return result;
}
