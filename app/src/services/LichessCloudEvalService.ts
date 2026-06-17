import { Chess } from 'chess.js';
import { openDB, type IDBPDatabase } from 'idb';

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
 * Convert a single UCI move to SAN given a FEN position.
 * Returns null if the move is illegal or the FEN is invalid.
 */
export function uciToSan(fen: string, uciMove: string): string | null {
    try {
        const chess = new Chess(fen);
        const from = uciMove.substring(0, 2);
        const to = uciMove.substring(2, 4);
        const promotion = uciMove.length > 4 ? uciMove[4] : undefined;
        const result = chess.move({ from, to, promotion });
        return result ? result.san : null;
    } catch {
        return null;
    }
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
 * Format a centipawn or mate eval as a human-readable string.
 * Examples: "+0.35", "-1.20", "M3", "-M5"
 */
export function formatEval(cp: number | null, mate: number | null): string {
    if (mate !== null) {
        return mate >= 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
    }
    if (cp !== null) {
        const sign = cp >= 0 ? '+' : '';
        return `${sign}${(cp / 100).toFixed(2)}`;
    }
    return '?';
}

/**
 * Build a display string for a move with its move number.
 * E.g., "5. Nf3" (white) or "5... Nf6" (black).
 */
export function formatMoveWithNumber(
    fen: string,
    moveSan: string
): string {
    const parts = fen.split(' ');
    const sideToMove = parts[1] || 'w';
    const fullmoveNumber = parseInt(parts[5] || '1', 10);

    if (sideToMove === 'w') {
        return `${fullmoveNumber}. ${moveSan}`;
    } else {
        return `${fullmoveNumber}... ${moveSan}`;
    }
}

// ---------------------------------------------------------------------------
// IndexedDB persistence for cloud eval results
// ---------------------------------------------------------------------------
const CLOUD_EVAL_DB_NAME = 'chesslaunchpad-cloud-evals';
const CLOUD_EVAL_DB_VERSION = 1;
const CLOUD_EVAL_STORE = 'evals';

let cloudEvalDbPromise: Promise<IDBPDatabase> | null = null;

function getCloudEvalDB(): Promise<IDBPDatabase> {
    if (!cloudEvalDbPromise) {
        cloudEvalDbPromise = openDB(CLOUD_EVAL_DB_NAME, CLOUD_EVAL_DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(CLOUD_EVAL_STORE)) {
                    db.createObjectStore(CLOUD_EVAL_STORE);
                }
            },
        });
    }
    return cloudEvalDbPromise;
}

async function getPersistedCloudEval(key: string): Promise<CloudEvalResult | null> {
    try {
        const db = await getCloudEvalDB();
        const val = await db.get(CLOUD_EVAL_STORE, key);
        return val ?? null;
    } catch {
        return null;
    }
}

async function persistCloudEval(key: string, result: CloudEvalResult): Promise<void> {
    try {
        const db = await getCloudEvalDB();
        await db.put(CLOUD_EVAL_STORE, result, key);
    } catch {
        // Best-effort persistence — don't break the caller
    }
}

// In-memory cache for cloud eval responses (keyed by "fen::multiPv")
const evalCache = new Map<string, Promise<CloudEvalResult | null>>();

/**
 * Fetch cloud eval with deduplication/caching.
 * Checks: in-memory cache → IndexedDB → Lichess API.
 * Successful results are persisted to IndexedDB for cross-session reuse.
 */
export function fetchCloudEvalCached(
    fen: string,
    multiPv: number = 5,
    fetchFn: typeof fetch = fetch
): Promise<CloudEvalResult | null> {
    const key = `${fen}::${multiPv}`;
    const cached = evalCache.get(key);
    if (cached) return cached;

    const promise = (async () => {
        // Check IndexedDB first
        const persisted = await getPersistedCloudEval(key);
        if (persisted) return persisted;

        // Fall back to network
        const result = await fetchCloudEval(fen, multiPv, fetchFn);
        if (result) {
            await persistCloudEval(key, result);
        }
        return result;
    })().then((result) => {
        // Don't keep failures in the in-memory cache
        if (result === null) {
            evalCache.delete(key);
        }
        return result;
    });

    evalCache.set(key, promise);
    return promise;
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
