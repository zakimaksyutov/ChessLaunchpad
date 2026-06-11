import {
    Activity,
    GameRecord,
    MastersTheoryVerdict,
    RepertoireData,
} from '../models/RepertoireData';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { IDataAccessLayer, DataAccessError } from '../data/DataAccessLayer';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { getLinkedAccounts } from './LinkedAccountsService';
import { findRecord, purgeRecordsFromTimestamp } from './GameRecordStore';
import {
    AmbiguousTheoryPosition,
} from './GameAnnotationService';
import { getRecordUserColor } from './GameRecordBuilder';
import {
    planAmbiguousPositions,
    buildVerdictFromPlan,
    fetchMastersWithMemo,
    MastersMemoEntry,
} from './GameRecordAnalysisPlanner';
import { MastersLookup } from './MastersExplorerService';

const ANALYSIS_FLUSH_BATCH = 5;
const MAX_FLUSH_RETRIES = 3;

/**
 * One step in the analysis pass — a single game's pre-analysis snapshot.
 *
 *   - `record`         : the game being analyzed.
 *   - `accountKey`     : `${platform}:${usernameLower}` — used to look up
 *                       the linked account's lowercase username.
 *   - `userLower`      : linked account's lowercase username (for
 *                       `getRecordUserColor`).
 *   - `plan`           : ambiguous positions discovered before any lookup
 *                       (drives the `K` in the progress text).
 *   - `priorAn`        : the record's existing `an` field (if any) — used by
 *                       Re-annotate to roll back on transient failure.
 */
export interface AnalysisJob {
    record: GameRecord;
    accountKey: string;
    userLower: string;
    plan: AmbiguousTheoryPosition[];
    priorAn?: MastersTheoryVerdict;
}

export type AnalysisProgress =
    | { phase: 'planning' }
    | { phase: 'analyzing'; gameIndex: number; gameTotal: number; positionIndex: number; positionTotal: number }
    | { phase: 'flushing'; gameIndex?: number; gameTotal?: number }
    | { phase: 'idle' };

/**
 * Result of the analysis pass — written verdicts paired with their record
 * targets. The caller (page) consumes these to: (a) update in-memory
 * rendering, (b) include in the next flush.
 */
export interface AnalyzedGameOutcome {
    record: GameRecord;
    /** New `an` value to write (omitted when the run errored — no write). */
    an?: MastersTheoryVerdict;
    /**
     * `true` when the game was skipped (transient masters-lookup error).
     * The page should keep the row visible in its prior state — Re-annotate
     * can re-queue, or the next pass will pick it up.
     */
    skipped: boolean;
}

/**
 * Build the analysis pass plan: enumerate every record across the activity
 * log that lacks `an`, attach each to its linked-account user, and discover
 * its ambiguous positions (no network).
 *
 * Records whose linked account is no longer in `settings.linkedAccounts`
 * are skipped — they're orphaned (the account was unlinked after the
 * record was created, before purgeRecordsForAccounts swept) and analysis
 * for them is meaningless.
 */
export function buildAnalysisPlan(
    data: RepertoireData,
    explorerEvals: ExplorerEvals | null,
): AnalysisJob[] {
    const activity = data.activity;
    if (!activity) return [];
    const fenSets = buildRepertoireFenSets(data.repertoires ?? []);

    // accountKey → userLower
    const accountLookup = new Map<string, string>();
    const linked = data.settings?.linkedAccounts ?? getLinkedAccounts();
    for (const a of linked) {
        accountLookup.set(`${a.platform}:${a.username.toLowerCase()}`, a.username.toLowerCase());
    }

    const jobs: AnalysisJob[] = [];
    // Walk oldest-first. Iterate days in ascending order, then sort
    // within-day by `t` ascending.
    const sortedDays = [...activity.practiceLog].sort((a, b) => a.date.localeCompare(b.date));
    for (const day of sortedDays) {
        const records = day.games?.records;
        if (!records || records.length === 0) continue;
        const sortedRecords = [...records].sort((a, b) => a.t - b.t);
        for (const record of sortedRecords) {
            if (record.an !== undefined) continue;

            // Find the linked account that owns this record. Match `wa`/`ba`
            // case-insensitively against any linked username; pick whichever
            // platform agrees with `record.p`.
            const recordPlatform = record.p === 'c' ? 'chess.com' : 'lichess';
            let userLower: string | null = null;
            let accountKey: string | null = null;
            for (const [key, name] of accountLookup) {
                if (!key.startsWith(`${recordPlatform}:`)) continue;
                if (record.wa.toLowerCase() === name || record.ba.toLowerCase() === name) {
                    userLower = name;
                    accountKey = key;
                    break;
                }
            }
            if (!userLower || !accountKey) continue;

            // Pre-flight: ensure userColor resolves (defensive — corrupt
            // record would otherwise crash the engine).
            const color = getRecordUserColor(record, userLower);
            if (!color) continue;

            const repertoireFens = color === 'white' ? fenSets.whiteFens : fenSets.blackFens;
            const plan = planAmbiguousPositions(record, userLower, repertoireFens, explorerEvals);
            jobs.push({ record, accountKey, userLower, plan, priorAn: record.an });
        }
    }
    return jobs;
}

/**
 * Pre-analysis filter: which jobs are gated by Lichess OAuth.
 *
 * - Chess.com records: always runnable (no masters required — they always
 *   produce `an: {}`).
 * - Lichess records with K=0: always runnable (no masters required).
 * - Lichess records with K>0: require Lichess connection. When disconnected,
 *   they're held out of the pass and surface in the "Connect Lichess" prompt.
 */
export function filterRunnableJobs(jobs: AnalysisJob[], lichessConnected: boolean): {
    runnable: AnalysisJob[];
    blockedByLichess: AnalysisJob[];
} {
    const runnable: AnalysisJob[] = [];
    const blockedByLichess: AnalysisJob[] = [];
    for (const job of jobs) {
        if (job.record.p === 'l' && job.plan.length > 0 && !lichessConnected) {
            blockedByLichess.push(job);
        } else {
            runnable.push(job);
        }
    }
    return { runnable, blockedByLichess };
}

/**
 * Execute a single game's analysis: run each ambiguous lookup through the
 * shared per-pass memo, classify outcomes, and assemble the `an` payload.
 *
 * Chess.com records: the masters check is only meaningful for Lichess
 * (per the spec, lichess-only theory source). Chess.com records bypass
 * the masters loop entirely and write `an: {}` immediately — even if the
 * planner found ambiguous positions (which can happen when ExplorerEvals
 * provides the fenBefore eval but not the fenAfter, producing a 15–44 cp
 * drop the engine flags as ambiguous). Without this short-circuit, a
 * disconnected Lichess account would leave Chess.com plan>0 games stuck
 * in `skipped` forever despite `filterRunnableJobs` calling them runnable.
 *
 * Returns `skipped: true` only when:
 *   - the signal aborts mid-pass, or
 *   - a Lichess record has K>0 and the token is somehow missing
 *     (filter should have removed this; defensive only), or
 *   - any masters lookup errored — caller must NOT persist any `an` for
 *     this game (the spec requires we re-queue on transient errors rather
 *     than bake an optimistic-in-theory verdict).
 */
export async function analyzeOneGame(
    job: AnalysisJob,
    token: string | null,
    memo: Map<string, MastersMemoEntry>,
    onPositionProgress: (positionIndex: number, positionTotal: number) => void,
    signal?: AbortSignal,
    fetchFn: typeof fetch = fetch,
): Promise<AnalyzedGameOutcome> {
    const { record, plan } = job;

    // Chess.com records: always render with empty `an` (no masters), no
    // matter what the planner produced. See doc comment above.
    if (record.p === 'c') {
        return { record, an: {}, skipped: false };
    }

    // Sync-only Lichess game (K=0): nothing to query, immediate `an: {}`.
    if (plan.length === 0) {
        return { record, an: {}, skipped: false };
    }

    // K>0 but no token (Lichess game, Lichess disconnected). Filter should
    // have removed this — guard just in case.
    if (!token) return { record, skipped: true };

    const lookup = new MastersLookup();
    let anyError = false;
    for (let i = 0; i < plan.length; i++) {
        if (signal?.aborted) return { record, skipped: true };
        const pos = plan[i];
        onPositionProgress(i + 1, plan.length);
        const entry = await fetchMastersWithMemo(pos.fenBefore, token, memo, signal, fetchFn);
        if (entry.kind === 'error') {
            anyError = true;
            // Continue the loop — we still want to memoize results for the
            // non-errored positions in case other games share them. We just
            // refuse to write `an` for THIS game.
            continue;
        }
        // Add to the per-game lookup so buildVerdictFromPlan can resolve.
        // The verdict builder applies the sparse-`tv` no-data rule itself
        // (omit when `moveGames === 0` or `totalGames === 0`); we don't
        // need to pre-classify here.
        lookup.add(pos.fenBefore, entry.result);
    }
    if (anyError) {
        return { record, skipped: true };
    }
    const an = buildVerdictFromPlan(plan, record, lookup);
    return { record, an, skipped: false };
}

/**
 * Flush a batch of `(p, id) → an` updates back to the blob via the DAL,
 * with field-scoped 412 reconciliation (re-fetch fresh blob → merge in
 * pending updates by record `(p, id)` → drop merges for records that
 * no longer exist → re-PUT). Returns the fresh blob the caller should
 * adopt as its render state, plus the count of writes that landed.
 *
 * Verdicts whose target record is missing from the fresh blob (evicted
 * by a concurrent ingest, purged by an unlink) are silently dropped.
 * Verdicts for a record that already gained a non-empty `an` in the fresh
 * blob (another tab analyzed it first) prefer the fresh value — verdicts
 * are deterministic but two tabs may have used slightly different masters
 * responses; we let the freshest write win.
 */
/**
 * Flush a batch of `(p, id) → an` updates back to the blob via the DAL,
 * with field-scoped 412 reconciliation (re-fetch fresh blob → merge in
 * pending updates by record `(p, id)` → drop merges for records that
 * no longer exist → re-PUT). Returns the fresh blob the caller should
 * adopt as its render state, plus the count of writes that landed.
 *
 * Verdicts whose target record is missing from the fresh blob (evicted
 * by a concurrent ingest, purged by an unlink) are silently dropped.
 *
 * Conflict resolution: if the fresh record already has **any** `an`
 * (including an empty `{}` / `{tv: []}` sync-only done-state), defer to
 * the fresh value. A stale tab that started analyzing before a freshly
 * landed `an: {}` shouldn't overwrite it with `{ tv: [...] }` — even
 * empty `an` is a legitimate "this game has been analyzed" stamp.
 * Re-annotate handles the "I want to redo this" case explicitly via
 * `persistReannotateClear` (which deletes the `an` field) before this
 * flush runs, so the only way a deferred-update happens is a real
 * concurrent-tab race.
 */
export async function flushAnUpdates(
    dal: IDataAccessLayer,
    updates: AnalyzedGameOutcome[],
): Promise<{ data: RepertoireData; persisted: number }> {
    if (updates.length === 0) {
        const data = await dal.retrieveRepertoireData();
        return { data, persisted: 0 };
    }

    for (let attempt = 1; attempt <= MAX_FLUSH_RETRIES; attempt++) {
        const fresh = await dal.retrieveRepertoireData();
        const activity = fresh.activity;
        if (!activity) {
            // Fresh blob has no activity — nothing to merge into.
            return { data: fresh, persisted: 0 };
        }
        let persisted = 0;
        for (const upd of updates) {
            if (upd.skipped || !upd.an) continue;
            const found = findRecord(activity, upd.record.id, upd.record.p);
            if (!found) continue; // evicted / purged
            // Conflict resolution: any present `an` on the fresh record
            // wins. The fresh value is the authoritative "this game has
            // been analyzed" stamp (whether or not its `tv` is empty).
            if (found.record.an !== undefined) continue;
            found.record.an = upd.an;
            persisted++;
        }
        if (persisted === 0) {
            return { data: fresh, persisted: 0 };
        }
        try {
            const blob = RepertoireDataUtils.prepareDataForSave(fresh);
            await dal.storeRepertoireData(blob);
            return { data: fresh, persisted };
        } catch (e) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // eslint-disable-next-line no-console
                console.warn(`analysisPass: 412 conflict on flush attempt ${attempt}, retrying`);
                continue;
            }
            throw e;
        }
    }
    // eslint-disable-next-line no-console
    console.warn('analysisPass: max flush retries exhausted — verdicts deferred');
    const data = await dal.retrieveRepertoireData();
    return { data, persisted: 0 };
}

/**
 * Persist a single `op` (opponent-analysis) result back to the blob with
 * the same field-scoped 412 reconciliation as `flushAnUpdates`.
 *
 * If the target record is evicted, the op is silently dropped (we don't
 * resurrect a record just to write `op` to it).
 */
export async function persistOpponentAnalysis(
    dal: IDataAccessLayer,
    recordId: string,
    recordPlatform: 'l' | 'c',
    op: NonNullable<GameRecord['op']>,
): Promise<RepertoireData> {
    for (let attempt = 1; attempt <= MAX_FLUSH_RETRIES; attempt++) {
        const fresh = await dal.retrieveRepertoireData();
        const activity = fresh.activity;
        if (!activity) return fresh;
        const found = findRecord(activity, recordId, recordPlatform);
        if (!found) return fresh;
        found.record.op = op;
        try {
            const blob = RepertoireDataUtils.prepareDataForSave(fresh);
            await dal.storeRepertoireData(blob);
            return fresh;
        } catch (e) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // eslint-disable-next-line no-console
                console.warn(`persistOpponentAnalysis: 412 on attempt ${attempt}`);
                continue;
            }
            throw e;
        }
    }
    return await dal.retrieveRepertoireData();
}

/**
 * Persist a Re-annotate clear (drop `an` and `op` for one record) back to
 * the blob with the field-scoped 412 reconciliation. Used by the page's
 * Re-annotate action so the queue can pick the record up on the next pass.
 */
export async function persistReannotateClear(
    dal: IDataAccessLayer,
    recordId: string,
    recordPlatform: 'l' | 'c',
): Promise<RepertoireData> {
    for (let attempt = 1; attempt <= MAX_FLUSH_RETRIES; attempt++) {
        const fresh = await dal.retrieveRepertoireData();
        const activity = fresh.activity;
        if (!activity) return fresh;
        const found = findRecord(activity, recordId, recordPlatform);
        if (!found) return fresh;
        delete found.record.an;
        delete found.record.op;
        try {
            const blob = RepertoireDataUtils.prepareDataForSave(fresh);
            await dal.storeRepertoireData(blob);
            return fresh;
        } catch (e) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // eslint-disable-next-line no-console
                console.warn(`persistReannotateClear: 412 on attempt ${attempt}`);
                continue;
            }
            throw e;
        }
    }
    return await dal.retrieveRepertoireData();
}

/**
 * Persist a Re-annotate **refresh** — replace one record in place with a
 * freshly-built one (typically rebuilt from a re-fetched provider payload
 * so newer `ev` / `o` data lands) and clear its `an` / `op` so the
 * analysis pass picks it up.
 *
 * The replacement is done **in place** at the existing record's slot
 * (same `practiceLog` entry, same array index). This preserves the
 * Games-page session-order memo so the row doesn't jump around when the
 * fresh record's `t` happens to equal the cached one (which it always
 * should for Lichess — `createdAt` is immutable post-game).
 *
 * If the cached record can no longer be found in the fresh blob (e.g.
 * concurrent eviction), the call is a no-op and the fresh blob is
 * returned unchanged — same idempotence posture as `persistReannotateClear`.
 *
 * `freshRecord.id` / `freshRecord.p` must match the target — the function
 * locates the slot by `(id, p)` and `freshRecord` is written into it
 * verbatim with `an` / `op` stripped.
 */
export async function persistReannotateRefresh(
    dal: IDataAccessLayer,
    freshRecord: GameRecord,
): Promise<RepertoireData> {
    for (let attempt = 1; attempt <= MAX_FLUSH_RETRIES; attempt++) {
        const fresh = await dal.retrieveRepertoireData();
        const activity = fresh.activity;
        if (!activity) return fresh;
        let replaced = false;
        for (const entry of activity.practiceLog) {
            const records = entry.games?.records;
            if (!records) continue;
            const idx = records.findIndex(
                r => r.id === freshRecord.id && r.p === freshRecord.p,
            );
            if (idx < 0) continue;
            // Strip `an` / `op` defensively — the refresh always wants the
            // analysis pass to re-derive the verdict from the new `ev`.
            const stripped: GameRecord = { ...freshRecord };
            delete stripped.an;
            delete stripped.op;
            records[idx] = stripped;
            replaced = true;
            break;
        }
        if (!replaced) return fresh;
        try {
            const blob = RepertoireDataUtils.prepareDataForSave(fresh);
            await dal.storeRepertoireData(blob);
            return fresh;
        } catch (e) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // eslint-disable-next-line no-console
                console.warn(`persistReannotateRefresh: 412 on attempt ${attempt}`);
                continue;
            }
            throw e;
        }
    }
    return await dal.retrieveRepertoireData();
}

// Re-export for caller convenience.
export { ANALYSIS_FLUSH_BATCH };

/**
 * DEBUG / TEMP — Persist a bulk delete of every record with `t >= fromT`
 * back to the blob with the same 412 reconciliation pattern as the other
 * persist helpers. Also rewinds per-account ingest state (`watermarkMs`,
 * `recentIds`, chess.com `providerCursor`) so the next sync will re-fetch
 * and re-ingest the deleted games. Used by the /games page's debug
 * "Delete from here" menu. To be removed before the containing branch
 * merges.
 */
export async function persistDeleteRecordsFromTimestamp(
    dal: IDataAccessLayer,
    fromT: number,
): Promise<RepertoireData> {
    for (let attempt = 1; attempt <= MAX_FLUSH_RETRIES; attempt++) {
        const fresh = await dal.retrieveRepertoireData();
        const activity = fresh.activity;
        if (!activity) return fresh;
        const purged = purgeRecordsFromTimestamp(activity, fromT);
        // Rewind ingest state so the next sync re-fetches the deleted games:
        //   - watermarkMs: clamp to `fromT - 1` so deleted games are eligible again
        //   - recentIds:   drop any entry with ts >= fromT so dedup doesn't skip
        //   - providerCursor (chess.com): clear so a fresh archive fetch runs
        //                  (the etag would otherwise short-circuit on 304)
        let rewound = false;
        if (fresh.games) {
            for (const key of Object.keys(fresh.games)) {
                const state = fresh.games[key];
                if (state.watermarkMs >= fromT) {
                    state.watermarkMs = fromT - 1;
                    rewound = true;
                }
                if (state.recentIds?.length) {
                    const kept = state.recentIds.filter(r => r.ts < fromT);
                    if (kept.length !== state.recentIds.length) {
                        state.recentIds = kept;
                        rewound = true;
                    }
                }
                if (state.providerCursor) {
                    delete state.providerCursor;
                    rewound = true;
                }
            }
        }
        if (purged === 0 && !rewound) return fresh;
        try {
            const blob = RepertoireDataUtils.prepareDataForSave(fresh);
            await dal.storeRepertoireData(blob);
            return fresh;
        } catch (e) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // eslint-disable-next-line no-console
                console.warn(`persistDeleteRecordsFromTimestamp: 412 on attempt ${attempt}`);
                continue;
            }
            throw e;
        }
    }
    return await dal.retrieveRepertoireData();
}

/**
 * Silence unused-import warnings.
 * `Activity` is used implicitly through `findRecord` and the flush merge
 * walks `activity.practiceLog`; keep the import for the explicit signature.
 */
export type { Activity };