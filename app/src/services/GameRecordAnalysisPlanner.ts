import {
    MastersLookupLike,
    CloudEvalProvider,
} from './GameAnnotationService';
import {
    MastersPositionResult,
    MoveStats,
    MastersLookup,
    fetchMastersOutcome,
    toMastersCacheKey,
} from './MastersExplorerService';
import { fetchCloudCp, CloudEvalThrottledError } from './LichessCloudEvalService';

/**
 * Pass-level latch tracking whether the Lichess cloud-eval API has 429'd during
 * the current analysis pass. Created once per pass and shared (like the memos)
 * across every game's provider: once Lichess rate-limits us, there's no point
 * hammering it again for the rest of the pass — every subsequent cloud-needing
 * game short-circuits straight to a `CloudEvalThrottledError` (and defers) so
 * the whole pass backs off together. A fresh pass starts with `throttled: false`
 * and retries the cloud.
 */
export interface CloudEvalThrottleState {
    throttled: boolean;
}

/**
 * Thrown by the on-demand cloud/masters providers when the analysis pass must
 * abandon (not freeze) the current game: a transient masters error, or an
 * aborted signal. `analyzeOneGame` catches it and returns `skipped: true` so
 * the game re-queues on the next pass instead of baking an optimistic verdict.
 */
export class AnalysisSkipError extends Error {
    constructor() {
        super('analysis skipped');
        this.name = 'AnalysisSkipError';
    }
}

/**
 * Thrown by the no-token masters lookup when the walk actually reaches an
 * ambiguous-zone opponent move. Distinct from `AnalysisSkipError`: it means
 * "this game needs a masters verdict but no Lichess token is connected," so the
 * pass defers the game (banner: "connect Lichess"), persists the cloud evals it
 * already gathered, and re-derives once a token is available — rather than
 * baking an optimistic in-theory verdict (which would mis-color out-of-theory
 * positions for Chess.com games; see docs/product-specs/GAMES.md).
 */
export class AwaitingMastersError extends Error {
    constructor() {
        super('awaiting masters connection');
        this.name = 'AwaitingMastersError';
    }
}

/**
 * Per-pass dedup memo entry. Distinguishes successful (cached) results
 * from errors so a single recurring failure isn't re-tried at full rate
 * within the same pass.
 */
export type MastersMemoEntry =
    | { kind: 'ok'; result: MastersPositionResult }
    | { kind: 'error' };

/**
 * Per-pass dedup memo + rate-limited fetch helper that surfaces the
 * error-vs-ok distinction so the analysis pass can refuse to bake `fan`
 * for games whose lookups failed.
 *
 * The memo is shared across all games in a pass — a repertoire-trainer
 * plays the same openings repeatedly, so the same opening-sideline FEN
 * often appears across many games in one pass; deduping collapses N
 * lookups into one without re-introducing IndexedDB.
 *
 * Honors `AbortSignal` so the page can cancel mid-pass (Re-annotate, nav).
 */
export async function fetchMastersWithMemo(
    fen: string,
    token: string,
    memo: Map<string, MastersMemoEntry>,
    signal?: AbortSignal,
    fetchFn: typeof fetch = fetch,
): Promise<MastersMemoEntry> {
    if (signal?.aborted) return { kind: 'error' };
    const key = toMastersCacheKey(fen);
    const cached = memo.get(key);
    if (cached) return cached;
    const outcome = await fetchMastersOutcome(fen, token, fetchFn);
    if (signal?.aborted) return { kind: 'error' };
    const entry: MastersMemoEntry = outcome.kind === 'ok'
        ? { kind: 'ok', result: outcome.result }
        : { kind: 'error' };
    memo.set(key, entry);
    return entry;
}

/**
 * Per-pass dedup memo + rate-limited cloud-eval fetch. Mirrors
 * `fetchMastersWithMemo`: the memo is shared across all games in a pass so the
 * same repertoire-boundary FEN isn't fetched twice (each cloud call costs a
 * full second under the 1 req/sec throttle). The memo also stores misses
 * (`null`) so a position Lichess has no eval for isn't re-hit for sibling
 * games in the same pass.
 *
 * Unlike masters, a cloud miss is **not** a transient error — it just means no
 * eval is available, which the engine treats exactly as a missing eval does
 * today. So there's no error/ok distinction to surface; the value is the cp or
 * `null`.
 *
 * Honors `AbortSignal` so the page can cancel mid-pass (Re-annotate, nav). Keys
 * by the raw FEN — identical to what the engine emits and looks up — so the
 * back-filled map and the engine's cloud-eval lookups always agree.
 */
export async function fetchCloudWithMemo(
    fen: string,
    memo: Map<string, number | null>,
    signal?: AbortSignal,
    fetchFn: typeof fetch = fetch,
): Promise<number | null> {
    if (signal?.aborted) return null;
    if (memo.has(fen)) return memo.get(fen) ?? null;
    const cp = await fetchCloudCp(fen, fetchFn);
    if (signal?.aborted) return null;
    memo.set(fen, cp);
    return cp;
}

/**
 * Build the engine's on-demand cloud-eval provider for a single pass.
 *
 * The engine awaits this only at plies that ExplorerEvals and embedded analysis
 * both miss, and only until its stop conditions end the walk — so the cloud API
 * is hit lazily, in walk order, and never for a game's settled tail. Results
 * (hits and misses) dedup through the shared `cloudMemo`.
 *
 * A miss returns `null` (no eval — same as today). An aborted signal throws
 * `AnalysisSkipError` so the pass abandons the game rather than freezing a
 * partial annotation; `fetchCloudWithMemo` itself returns `null` on abort, so
 * the post-await guard is what distinguishes "aborted" from "genuine miss".
 *
 * `throttle` (when supplied) latches the pass: the moment the cloud API 429's,
 * every later call across the whole pass short-circuits to a
 * `CloudEvalThrottledError` without touching the network, so all cloud-needing
 * games defer together instead of each re-hitting the rate-limited API.
 */
export function makeCloudEvalProvider(
    cloudMemo: Map<string, number | null>,
    signal?: AbortSignal,
    fetchFn: typeof fetch = fetch,
    throttle?: CloudEvalThrottleState,
): CloudEvalProvider {
    return async (fen: string): Promise<number[] | null> => {
        if (signal?.aborted) throw new AnalysisSkipError();
        // Already throttled this pass — don't bother the rate-limited API again.
        if (throttle?.throttled) throw new CloudEvalThrottledError();
        try {
            const cp = await fetchCloudWithMemo(fen, cloudMemo, signal, fetchFn);
            if (signal?.aborted) throw new AnalysisSkipError();
            return cp === null ? null : [cp];
        } catch (e) {
            // First 429 of the pass: latch so the rest of the pass backs off.
            if (e instanceof CloudEvalThrottledError && throttle) {
                throttle.throttled = true;
            }
            throw e;
        }
    };
}

/**
 * On-demand masters lookup satisfying `MastersLookupLike`. The engine awaits
 * `isOutOfTheory` only at ambiguous-zone (15–44 cp) opponent moves the walk
 * actually reaches, so the masters API is hit lazily — no upfront plan, no
 * fetches past theory's end. Verdicts dedup across games via the shared `memo`.
 *
 * A transient masters error (or an aborted signal, which surfaces as an error
 * entry) throws `AnalysisSkipError`: the spec requires the pass to re-queue
 * such a game rather than bake an optimistic in-theory verdict into `fan`. A
 * 200-but-no-data result is *not* an error — it resolves to `null` (unknown),
 * and the engine falls back to its optimistic default.
 *
 * `getMoveStats` is consulted right after a non-null verdict, reading the
 * position `isOutOfTheory` already cached this pass, so it stays synchronous.
 */
export class OnDemandMastersLookup implements MastersLookupLike {
    private readonly cache = new MastersLookup();
    private readonly fetched = new Set<string>();

    constructor(
        private readonly token: string,
        private readonly memo: Map<string, MastersMemoEntry>,
        private readonly signal?: AbortSignal,
        private readonly fetchFn: typeof fetch = fetch,
    ) {}

    async isOutOfTheory(fen: string, moveSan: string): Promise<boolean | null> {
        await this.ensure(fen);
        return this.cache.isOutOfTheory(fen, moveSan);
    }

    getMoveStats(fen: string, moveSan: string): MoveStats | null {
        return this.cache.getMoveStats(fen, moveSan);
    }

    private async ensure(fen: string): Promise<void> {
        if (this.signal?.aborted) throw new AnalysisSkipError();
        const key = toMastersCacheKey(fen);
        if (this.fetched.has(key)) return;
        const entry = await fetchMastersWithMemo(fen, this.token, this.memo, this.signal, this.fetchFn);
        if (entry.kind === 'error') throw new AnalysisSkipError();
        this.cache.add(fen, entry.result);
        this.fetched.add(key);
    }
}

/**
 * Masters lookup used when no Lichess token is connected. The engine consults a
 * masters lookup only at ambiguous-zone (15–44 cp) opponent moves, so the first
 * such consultation throws `AwaitingMastersError` — deferring the game until a
 * token is available instead of falling through to the engine's optimistic
 * in-theory default. Games that never reach the ambiguous band never consult
 * this and freeze normally.
 *
 * `getMoveStats` is never reached (the engine only calls it after a non-null
 * verdict, and `isOutOfTheory` always throws first).
 */
export class AwaitingMastersLookup implements MastersLookupLike {
    isOutOfTheory(): never {
        throw new AwaitingMastersError();
    }

    getMoveStats(): MoveStats | null {
        return null;
    }
}
