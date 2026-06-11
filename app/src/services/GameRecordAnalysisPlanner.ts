import { Chess } from 'chess.js';
import {
    GameRecord,
    MastersTheoryVerdict,
    MastersTheoryPlyVerdict,
} from '../models/RepertoireData';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { AmbiguousTheoryPosition } from './GameAnnotationService';
import {
    MastersLookup,
    MastersPositionResult,
    MoveStats,
    classifyOutOfTheory,
    fetchMastersOutcome,
    toMastersCacheKey,
} from './MastersExplorerService';
import { annotateRecord } from './RecordAnnotation';

/**
 * Discover the ambiguous-zone opponent moves that need a masters DB lookup
 * for a given record.
 *
 * Delegates to the canonical annotation engine (`annotateRecord`) without a
 * masters lookup so the engine populates `ambiguousTheoryPositions` for
 * every opponent move that:
 *   - leaves the user's repertoire
 *   - has an eval drop in `[AMBIGUOUS_THEORY_THRESHOLD, OUT_OF_THEORY_THRESHOLD)`
 *
 * Using the engine itself (rather than a hand-rolled walk) guarantees the
 * pre-pass discovery and the post-pass render agree on the same set of
 * positions.
 */
export function planAmbiguousPositions(
    record: GameRecord,
    accountUsernameLower: string,
    repertoireFens: Set<string>,
    explorerEvals: ExplorerEvals | null,
): AmbiguousTheoryPosition[] {
    const annotation = annotateRecord(
        record,
        accountUsernameLower,
        repertoireFens,
        explorerEvals,
        // No masters lookup → annotation engine collects ambiguous positions
        // into `ambiguousTheoryPositions` rather than resolving them.
        undefined,
    );
    return annotation?.ambiguousTheoryPositions ?? [];
}

/**
 * Build a `MastersTheoryVerdict` from a per-pass `MastersLookup` and the
 * planned ambiguous positions. Verdicts are sparse — only positions the
 * lookup returned data for **and** has a definite verdict for are emitted.
 *
 * Routes through `classifyLookupOutcome`-style classification:
 *   - `ok-with-data`  → emit `{ ply, in: !outOfTheory }`
 *   - `ok-no-data`    → omit (sparse `tv` per spec)
 *   - lookup miss     → omit (same path; caller refused to add to lookup)
 *
 * The "no-data ⇒ omit" rule is what makes the spec's optimistic-in-theory
 * fallback work at render time and what lets a future pass retry only
 * no-data plies (`docs/product-specs/GAMES-REFACTOR.md`).
 *
 * Empty `tv` is the valid done-with-no-resolved-verdicts state.
 */
export function buildVerdictFromPlan(
    plan: AmbiguousTheoryPosition[],
    record: GameRecord,
    lookup: MastersLookup,
): MastersTheoryVerdict {
    const tv: MastersTheoryPlyVerdict[] = [];
    for (const pos of plan) {
        const stats = lookup.getMoveStats(pos.fenBefore, pos.moveSan);
        if (stats === null) continue;
        // No-data classification: HTTP 200 but masters reports zero games
        // for either the position or the specific SAN. Sparse-map rule:
        // omit and let render fall through to the optimistic in-theory
        // default. Conflating this with "confirmed out of theory" is a
        // one-way door the spec explicitly forbids.
        if (stats.totalGames === 0 || stats.moveGames === 0) continue;
        const verdict = classifyOutOfTheory(stats);
        if (verdict === null) continue;
        tv.push({ ply: pos.plyIndex, in: !verdict });
    }
    void record;
    if (tv.length === 0) return {};
    return { tv };
}

/**
 * Hydrate a `MastersLookupLike` from persisted `record.an.tv` verdicts so
 * the render-side annotation can replay without re-querying the API.
 *
 * Returns an object that satisfies the `MastersLookupLike` interface but
 * stores per-`(fen-key, san)` verdicts directly — NOT synthesized
 * `MastersPositionResult` shims. This is necessary because:
 *
 *   - The annotation engine queries `isOutOfTheory(fen, san)` and treats
 *     `null` as "no data → optimistic in-theory default" (spec §`an`).
 *   - A position-result shim that "knows about" san=X cannot also report
 *     `null` for san=Y at the same position — `getMoveStats(fen, Y)` would
 *     synthesize zero stats, and `classifyOutOfTheory` would lock it in as
 *     "out of theory" rather than falling through to the optimistic default.
 *   - This matters at transpositions where two ambiguous plies reach the
 *     same FEN-key with different SANs, and only one of them has a stored
 *     verdict in `tv`.
 *
 * The lookup returns synthesized stats only for queries that match a stored
 * `(key, san)` verdict; all other queries return `null`, mirroring the
 * "no data" semantics of the live API.
 */
export interface AnVerdictLookup {
    getMoveStats(fen: string, moveSan: string): MoveStats | null;
    isOutOfTheory(fen: string, moveSan: string): boolean | null;
    /** Number of distinct verdicts stored (debugging / tests). */
    readonly size: number;
}

export function buildLookupFromAn(record: GameRecord): AnVerdictLookup {
    const verdicts = record.an?.tv;
    const sans = record.m.split(/\s+/).filter(Boolean);

    // Map per-(fen-cache-key, san) → in-theory boolean. Absence == "no data".
    const verdictByKeySan = new Map<string, boolean>();

    if (verdicts && verdicts.length > 0 && sans.length > 0) {
        const verdictByPly = new Map<number, MastersTheoryPlyVerdict>(
            verdicts.map(v => [v.ply, v]),
        );
        const chess = new Chess();
        for (let i = 0; i < sans.length; i++) {
            const v = verdictByPly.get(i);
            if (v) {
                const key = toMastersCacheKey(chess.fen());
                verdictByKeySan.set(`${key}::${sans[i]}`, v.in);
                verdictByPly.delete(i);
                if (verdictByPly.size === 0) break;
            }
            try {
                const moved = chess.move(sans[i]);
                if (!moved) break;
            } catch {
                break;
            }
        }
    }

    return {
        size: verdictByKeySan.size,
        getMoveStats(fen: string, moveSan: string): MoveStats | null {
            const key = `${toMastersCacheKey(fen)}::${moveSan}`;
            if (!verdictByKeySan.has(key)) return null;
            const inTheory = verdictByKeySan.get(key)!;
            // Synthesize totals such that `classifyOutOfTheory` reproduces
            // the stored verdict — exact numbers don't matter at render
            // (`GameAnnotationService` formats `stats.moveGames` /
            // `stats.percentage` into a debug-only log string).
            if (inTheory) {
                // moveGames ≥ MIN_MASTER_GAMES_ABSOLUTE → false (in theory)
                return { moveGames: 100, totalGames: 100, percentage: 100 };
            }
            // moveGames=0 → true (out of theory)
            return { moveGames: 0, totalGames: 1, percentage: 0 };
        },
        isOutOfTheory(fen: string, moveSan: string): boolean | null {
            const stats = this.getMoveStats(fen, moveSan);
            return classifyOutOfTheory(stats);
        },
    };
}

/**
 * Outcome of analyzing a single ambiguous position in the pass.
 *
 *   - `'ok-with-data'` — masters returned a result; verdict resolved.
 *   - `'ok-no-data'`   — masters returned a result but with no relevant
 *                       moves for this san; verdict treated as null → ply
 *                       omitted from `tv` (sparse map; optimistic default).
 *   - `'error'`        — transient HTTP/network failure; the parent game
 *                       must NOT be marked analyzed so it re-queues next pass.
 */
export type AmbiguousLookupOutcome = 'ok-with-data' | 'ok-no-data' | 'error';

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
 * error-vs-ok distinction so the analysis pass can refuse to bake `an`
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
 * Classify a memo entry + masters move stats into the per-position outcome
 * used by the analysis pass.
 */
export function classifyLookupOutcome(
    memoEntry: MastersMemoEntry,
    moveSan: string,
): AmbiguousLookupOutcome {
    if (memoEntry.kind === 'error') return 'error';
    const stats = computeMoveStatsFromResult(memoEntry.result, moveSan);
    // Treat "0 master games at this san" as no-data — same as the sparse
    // map's no-data semantics. classifyOutOfTheory of a non-null stats with
    // 0 games returns `true` (out of theory by the < MIN_MASTER_GAMES rule),
    // but the spec says we should treat that as "no data → omit" rather
    // than "confirmed out of theory" — out-of-theory is reserved for moves
    // that ARE played by masters but in low proportion.
    //
    // Re-reading the spec lines 119–120 ("no data → omit"): the conservative
    // read is that "no data for this exact san" means absence of a verdict.
    // We bias toward omission to keep `tv` honest.
    if (stats.totalGames === 0) return 'ok-no-data';
    if (stats.moveGames === 0) return 'ok-no-data';
    return 'ok-with-data';
}

function computeMoveStatsFromResult(result: MastersPositionResult, moveSan: string): MoveStats {
    const moveData = result.moves.find(m => m.san === moveSan);
    const moveGames = moveData ? moveData.total : 0;
    const totalGames = result.totalGames;
    const percentage = totalGames > 0 ? (moveGames / totalGames) * 100 : 0;
    return { moveGames, totalGames, percentage };
}
