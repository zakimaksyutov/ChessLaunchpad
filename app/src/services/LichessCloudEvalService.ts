import { Chess } from 'chess.js';

/**
 * Thrown when the Lichess cloud-eval API responds with HTTP 429 (rate limit).
 *
 * A throttle must be distinguishable from a genuine "Lichess has no eval for
 * this position" miss: a miss is permanent (the position is too rare to be in
 * book), but a throttle is transient (the eval exists, we were just asked to
 * back off). The /games analysis pass catches this to **defer** the game —
 * leaving it unfrozen so it re-queues on a later pass — instead of baking a
 * less-informed verdict from a position the engine wrongly thinks has no eval.
 */
export class CloudEvalThrottledError extends Error {
    constructor() {
        super('lichess cloud-eval throttled');
        this.name = 'CloudEvalThrottledError';
    }
}

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
 * Returns null if the position has no cloud eval or on any error — *except*
 * a 429 (rate limit), which throws `CloudEvalThrottledError` so callers can
 * tell a transient throttle apart from a permanent miss.
 */
export async function fetchCloudEval(
    fen: string,
    multiPv: number = 5,
    fetchFn: typeof fetch = fetch
): Promise<CloudEvalResult | null> {
    let response: Response;
    try {
        const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
        response = await fetchFn(url);
    } catch {
        // Network failure — treat as a miss (no eval), as before.
        return null;
    }

    // A 429 is the one response a caller must react to rather than treat as a
    // miss: the eval likely exists, Lichess just rate-limited us. Surface it.
    if (response.status === 429) {
        throw new CloudEvalThrottledError();
    }
    if (!response.ok) {
        return null;
    }

    try {
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
        // Parse error — treat as a miss.
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
 *
 * Propagates `CloudEvalThrottledError` (HTTP 429) so the analysis pass can defer
 * the game rather than mistake a transient throttle for a permanent miss.
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

/**
 * Outcome of a single cloud-eval lookup, distinguishing a genuine **no-eval**
 * (HTTP 404 — Lichess has never analysed this position, the common out-of-book
 * case) from a **transient** failure (429 rate-limit, 5xx, network, parse).
 *
 * The repertoire-suggestion scorer needs this distinction: a real 404 maps to
 * the spec's "eval-missing ≈ −10 cp" fallback, but a transient error must NOT
 * be silently scored as that fallback (it would skew `dEval`). Callers abort
 * the suggestion on `error` instead — mirroring the reference scorer, which
 * aborts the position on a rate-limit rather than treating it as missing data.
 */
export type CloudCpOutcome =
    | { kind: 'ok'; cp: number }
    | { kind: 'no_eval' }
    | { kind: 'error' };

/**
 * Like `fetchCloudCp`, but surfaces the no-eval vs transient-error distinction
 * (see `CloudCpOutcome`). Shares the same 1 req/sec module-level throttle as
 * `fetchCloudCp`, so mixing the two callers stays rate-limited.
 */
export async function fetchCloudCpOutcome(
    fen: string,
    fetchFn: typeof fetch = fetch
): Promise<CloudCpOutcome> {
    await cloudRateLimitedDelay();
    try {
        const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`;
        const response = await fetchFn(url);
        // 404 is the authoritative "no cloud eval for this position".
        if (response.status === 404) return { kind: 'no_eval' };
        // Any other non-OK (429 rate-limit, 5xx, …) is transient.
        if (!response.ok) return { kind: 'error' };
        const data = await response.json();
        const pv = (data.pvs && data.pvs[0]) || null;
        if (!pv) return { kind: 'no_eval' };
        if (pv.mate !== null && pv.mate !== undefined) {
            return { kind: 'ok', cp: pv.mate > 0 ? MATE_CP : -MATE_CP };
        }
        if (typeof pv.cp === 'number') return { kind: 'ok', cp: pv.cp };
        return { kind: 'no_eval' };
    } catch {
        return { kind: 'error' };
    }
}
