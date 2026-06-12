import { GameRecord } from '../models/RepertoireData';

/**
 * Output entry for `selectRenderableRows`. `pending: true` marks a record
 * that has no annotation yet but is queued for analysis in the current
 * pass — the page renders these as skeleton placeholders so their slot is
 * reserved before the verdict lands. This prevents the "row pops in,
 * pushes everything down" jumping effect during an analysis pass.
 */
export interface RenderableRow {
    record: GameRecord;
    userLower: string;
    pending: boolean;
}

/**
 * Decide which records appear as visible rows on the Games page, in
 * priority order:
 *
 *   1. `an` present                           → render normally
 *   2. re-annotation in flight (priorAn set)  → render with cloned
 *                                               record carrying priorAn
 *                                               (row stays visible while
 *                                               new verdict is computed)
 *   3. queued for the current analysis pass   → render as skeleton
 *                                               placeholder
 *
 * Records that fall into none of the above (e.g. blocked-by-Lichess
 * Lichess records when disconnected) are filtered out — they surface
 * via the "N games awaiting…" banner instead.
 *
 * Note: re-annotation takes precedence over pending. A row that's
 * being re-annotated AND is also a pending job in the next pass should
 * keep showing its prior `an` overlay, not a skeleton.
 */
export function selectRenderableRows(
    allRecords: ReadonlyArray<{ record: GameRecord; userLower: string }>,
    reannotatingKeys: ReadonlySet<string>,
    priorAnByKey: ReadonlyMap<string, NonNullable<GameRecord['an']>>,
    pendingAnalysisKeys: ReadonlySet<string>,
): RenderableRow[] {
    const out: RenderableRow[] = [];
    for (const r of allRecords) {
        const key = `${r.record.p}:${r.record.id}`;
        if (r.record.an !== undefined) {
            out.push({ record: r.record, userLower: r.userLower, pending: false });
        } else if (reannotatingKeys.has(key)) {
            const prior = priorAnByKey.get(key);
            if (prior !== undefined) {
                out.push({
                    record: { ...r.record, an: prior },
                    userLower: r.userLower,
                    pending: false,
                });
            }
        } else if (pendingAnalysisKeys.has(key)) {
            out.push({ record: r.record, userLower: r.userLower, pending: true });
        }
    }
    return out;
}
