import { GameRecord } from '../models/RepertoireData';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { AmbiguousTheoryPosition } from './GameAnnotationService';
import {
    MastersPositionResult,
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
 * pre-pass discovery and the final analysis annotation agree on the same set
 * of positions.
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
        // No masters lookup -> annotation engine collects ambiguous positions
        // into `ambiguousTheoryPositions` rather than resolving them.
        undefined,
    );
    return annotation?.ambiguousTheoryPositions ?? [];
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
