import { Chess } from 'chess.js';

export interface CloudEvalPv {
    /** First move in SAN notation (e.g., "e4") */
    moveSan: string;
    /** First move in UCI notation (e.g., "e2e4") */
    moveUci: string;
    /** Evaluation in centipawns from White's perspective, or null if mate */
    cp: number | null;
    /** Mate in N moves (positive = White mates), or null */
    mate: number | null;
    /** Full PV line in SAN notation */
    lineSan: string[];
}

export interface CloudEvalResult {
    fen: string;
    depth: number;
    knodes: number;
    pvs: CloudEvalPv[];
}

/**
 * Convert a sequence of UCI moves to SAN, replaying from the given FEN.
 * Stops at the first illegal move.
 */
export function uciLineToSan(fen: string, uciMoves: string[]): string[] {
    const sanMoves: string[] = [];
    const chess = new Chess(fen);
    for (const uci of uciMoves) {
        const from = uci.substring(0, 2);
        const to = uci.substring(2, 4);
        const promotion = uci.length > 4 ? uci[4] : undefined;
        try {
            const result = chess.move({ from, to, promotion });
            if (result) {
                sanMoves.push(result.san);
            } else {
                break;
            }
        } catch {
            break;
        }
    }
    return sanMoves;
}

/**
 * Fetch cloud evaluations from the Lichess API for a given position.
 * Returns null if the position has no cloud eval or on any error.
 */
export async function fetchCloudEval(
    fen: string,
    multiPv: number = 5,
    fetchFn: typeof fetch = fetch
): Promise<CloudEvalResult | null> {
    try {
        const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
        const response = await fetchFn(url);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();

        const pvs: CloudEvalPv[] = [];
        for (const pv of data.pvs || []) {
            const uciMoves: string[] = (pv.moves || '').split(' ').filter(Boolean);
            if (uciMoves.length === 0) continue;

            const lineSan = uciLineToSan(fen, uciMoves);
            const firstMoveSan = lineSan.length > 0 ? lineSan[0] : uciMoves[0];

            pvs.push({
                moveSan: firstMoveSan,
                moveUci: uciMoves[0],
                cp: pv.cp ?? null,
                mate: pv.mate ?? null,
                lineSan,
            });
        }

        return {
            fen: data.fen || fen,
            depth: data.depth || 0,
            knodes: data.knodes || 0,
            pvs,
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Rate-limited single-cp fetch for the /games analysis pass
// ---------------------------------------------------------------------------

/** Large cp magnitude representing a forced mate (matches the annotation engine). */
const MATE_CP = 10_000;

/** Delay between cloud-eval API requests in milliseconds (Lichess rate limit). */
const CLOUD_EVAL_RATE_LIMIT_MS = 1000;

let lastCloudRequestTime = 0;

async function cloudRateLimitedDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastCloudRequestTime;
    if (elapsed < CLOUD_EVAL_RATE_LIMIT_MS) {
        await new Promise(resolve => setTimeout(resolve, CLOUD_EVAL_RATE_LIMIT_MS - elapsed));
    }
    lastCloudRequestTime = Date.now();
}

/**
 * Fetch a single White-POV centipawn eval for a position — used by the /games
 * analysis pass to back-fill eval gaps (positions ExplorerEvals and embedded
 * analysis both miss). Uses `multiPv=1` (only the position's top-line eval is
 * needed) and is **not** cached: the analysis pass dedups within a run via its
 * own per-pass memo and freezes the verdict into each game's `fan`, so a
 * persistent cache buys nothing (see docs/product-specs/GAMES.md).
 *
 * Mate scores are coalesced to ±MATE_CP, matching how embedded evals handle
 * mates, so a forced mate registers as a decisive swing. Returns `null` when
 * Lichess has no cloud eval for the position (common for off-book lines) or on
 * any network/parse error.
 *
 * Honors the 1 req/sec Lichess rate limit via a shared module-level throttle.
 */
export async function fetchCloudCp(
    fen: string,
    fetchFn: typeof fetch = fetch
): Promise<number | null> {
    await cloudRateLimitedDelay();
    const result = await fetchCloudEval(fen, 1, fetchFn);
    const pv = result?.pvs[0];
    if (!pv) return null;
    if (pv.mate !== null) return pv.mate > 0 ? MATE_CP : -MATE_CP;
    return pv.cp;
}
