import {
    GameRecord,
    FrozenAnnotation,
    RepertoireData,
} from '../models/RepertoireData';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { IRepertoireDataStore } from '../data/DataAccessProxyLayer';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { getLinkedAccounts } from './LinkedAccountsService';
import { findRecord, purgeRecordsFromTimestamp } from './GameRecordStore';
import { annotationToFrozen } from './GameAnnotationService';
import { getRecordUserColor } from './GameRecordBuilder';
import { annotateRecord } from './RecordAnnotation';
import {
    makeCloudEvalProvider,
    OnDemandMastersLookup,
    AwaitingMastersLookup,
    AnalysisSkipError,
    AwaitingMastersError,
    MastersMemoEntry,
} from './GameRecordAnalysisPlanner';

const ANALYSIS_FLUSH_BATCH = 5;

/**
 * One step in the analysis pass — a single game's pre-analysis snapshot.
 *
 *   - `record`         : the game being analyzed.
 *   - `userLower`      : the linked-account name (lowercase) that owns it.
 *   - `repertoireFens` : the user-color FEN set this game is scored against.
 *   - `debug`          : emit a one-shot ply-by-ply trace (Re-annotate only).
 */
export interface AnalysisJob {
    record: GameRecord;
    userLower: string;
    repertoireFens: Set<string>;
    debug?: boolean;
}

export type AnalysisProgress =
    | { phase: 'planning' }
    | { phase: 'analyzing'; gameIndex: number; gameTotal: number }
    | { phase: 'flushing'; gameIndex?: number; gameTotal?: number }
    | { phase: 'idle' };

/**
 * Result of the analysis pass — frozen annotations paired with their record
 * targets. The caller (page) consumes these to: (a) update in-memory
 * rendering, (b) include in the next flush.
 */
export interface AnalyzedGameOutcome {
    record: GameRecord;
    /** New `fan` value to write (omitted when the run errored — no write). */
    fan?: FrozenAnnotation;
    /**
     * `true` when the game was not frozen this pass — a transient masters-lookup
     * error, an aborted signal, or `awaitingMasters` (see below). The page keeps
     * the row in its prior state; the next pass (or a Lichess connect) re-queues.
     */
    skipped: boolean;
    /**
     * `true` when the game reached an ambiguous position but no Lichess token
     * was connected to resolve it. The game is deferred (not frozen) and counts
     * toward the "connect Lichess" banner. `evUpdate` carries the cloud evals
     * gathered so far so the re-run after connecting needn't re-fetch them.
     */
    awaitingMasters?: boolean;
    /**
     * Cloud-eval back-fill gathered during the walk, keyed by ply index (aligns
     * 1:1 with `record.ev`). Persisted additively so a deferred game's re-run
     * resolves those plies from `ev` instead of re-hitting the rate-limited
     * cloud API. Only set on the `awaitingMasters` path.
     */
    evUpdate?: Map<number, number>;
}

/**
 * Build the analysis pass plan: enumerate every record across the activity
 * log that lacks `fan`, oldest-first, and attach each to its linked-account
 * user. No network — the per-game walk resolves evals and masters verdicts on
 * demand (and defers games that need masters when no token is connected).
 *
 * Records whose linked account is no longer in `settings.linkedAccounts`
 * are skipped — they're orphaned (the account was unlinked after the
 * record was created, before purgeRecordsForAccounts swept) and analysis
 * for them is meaningless.
 *
 * `debugKeys` flags records (`${p}:${id}`) whose final annotation should emit
 * a one-shot ply-by-ply console trace — used by Re-annotate.
 */
export function buildAnalysisPlan(
    data: RepertoireData,
    debugKeys?: ReadonlySet<string>,
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
            if (record.fan !== undefined) continue;

            // Find the linked account that owns this record. Match `wa`/`ba`
            // case-insensitively against any linked username; pick whichever
            // platform agrees with `record.p`.
            const recordPlatform = record.p === 'c' ? 'chess.com' : 'lichess';
            let userLower: string | null = null;
            for (const [key, name] of accountLookup) {
                if (!key.startsWith(`${recordPlatform}:`)) continue;
                if (record.wa.toLowerCase() === name || record.ba.toLowerCase() === name) {
                    userLower = name;
                    break;
                }
            }
            if (!userLower) continue;

            // Pre-flight: ensure userColor resolves (defensive — corrupt
            // record would otherwise crash the engine).
            const color = getRecordUserColor(record, userLower);
            if (!color) continue;

            const repertoireFens = color === 'white' ? fenSets.whiteFens : fenSets.blackFens;
            jobs.push({
                record,
                userLower,
                repertoireFens,
                debug: debugKeys?.has(`${record.p}:${record.id}`) ?? false,
            });
        }
    }
    return jobs;
}

/**
 * Execute a single game's analysis in **one** annotation-engine walk, then
 * freeze the result into a `fan` payload.
 *
 * The engine resolves evals and masters verdicts **on demand** as it walks the
 * game ply-by-ply, via two providers wired to this pass's shared memos:
 *
 *   - Cloud-eval provider (both platforms). Resolves an eval-drop's missing
 *     side — a position ExplorerEvals and embedded analysis both miss — from the
 *     Lichess cloud-eval API (public; no OAuth, so this covers Chess.com too).
 *     Because the engine's own stop conditions (opponent ≥45 → out of theory;
 *     user's first notable drop) end the walk, cloud is hit lazily, in walk
 *     order, and never for a game's already-settled tail. Each cloud hit is
 *     recorded (by ply) into `cloudEvalSink` so a deferred game can persist it.
 *
 *   - Masters provider (both platforms). When a token is connected, an
 *     `OnDemandMastersLookup` resolves ambiguous-zone (15–44 cp) opponent moves
 *     the walk actually reaches. With no token, an `AwaitingMastersLookup`
 *     throws `AwaitingMastersError` the moment the walk reaches such a move —
 *     deferring the game (banner: "connect Lichess") rather than freezing an
 *     optimistic in-theory verdict, which would mis-color out-of-theory
 *     positions (notably for Chess.com games). Games that never reach the
 *     ambiguous band freeze normally regardless of token.
 *
 * Throttling + per-pass dedup (hits and misses) live in the memos, so the same
 * boundary FEN is fetched at most once per pass.
 *
 * Returns `skipped: true` when a provider abandons the game:
 *   - `AnalysisSkipError` — the signal aborted mid-walk, or a masters lookup
 *     errored (transient). Caller must NOT persist any `fan`.
 *   - `AwaitingMastersError` — additionally sets `awaitingMasters` and
 *     `evUpdate` so the page can count the game toward the banner and persist
 *     the cloud evals gathered so far.
 *
 * A cloud-eval *miss* is not an error — it leaves the position with no eval,
 * exactly as today, and the game is still frozen.
 */
export async function analyzeOneGame(
    job: AnalysisJob,
    token: string | null,
    memo: Map<string, MastersMemoEntry>,
    cloudMemo: Map<string, number | null>,
    explorerEvals: ExplorerEvals | null,
    signal?: AbortSignal,
    fetchFn: typeof fetch = fetch,
): Promise<AnalyzedGameOutcome> {
    const { record, userLower, repertoireFens, debug } = job;
    if (signal?.aborted) return { record, skipped: true };

    // Cloud evals back-fill missing eval-drop sides on demand (both platforms).
    const cloudEval = makeCloudEvalProvider(cloudMemo, signal, fetchFn);
    // Cloud hits collected by ply so a deferred game can persist them into `ev`.
    const cloudEvalSink = new Map<number, number>();
    // Masters verdicts for ambiguous-zone opponent moves. With a token, resolve
    // on demand; without one, defer the game the moment the walk needs masters.
    const mastersLookup = token
        ? new OnDemandMastersLookup(token, memo, signal, fetchFn)
        : new AwaitingMastersLookup();

    try {
        // One engine walk — ambiguous-zone opponent moves consult `mastersLookup`;
        // eval drops resolve through ExplorerEvals → embedded → `cloudEval`. The
        // walk's stop conditions bound how far either provider is consulted.
        const annotation = await annotateRecord(
            record,
            userLower,
            repertoireFens,
            explorerEvals,
            mastersLookup,
            debug,
            cloudEval,
            cloudEvalSink,
        );
        if (!annotation) return { record, skipped: true };
        return { record, fan: annotationToFrozen(annotation), skipped: false };
    } catch (e) {
        // No token, but the walk reached an ambiguous position: defer the game
        // and hand back the cloud evals gathered so far so the re-run (after a
        // Lichess connect) resolves those plies from `ev` without re-fetching.
        if (e instanceof AwaitingMastersError) {
            return { record, skipped: true, awaitingMasters: true, evUpdate: cloudEvalSink };
        }
        // A provider abandoned the game (masters error or aborted signal): don't
        // freeze a partial/optimistic verdict — re-queue on the next pass.
        if (e instanceof AnalysisSkipError) return { record, skipped: true };
        throw e;
    }
}

/**
 * Flush a batch of analysis outcomes back to the blob via the DAL. Each outcome
 * writes either a frozen `fan` (a fully-analyzed game) or, for a deferred
 * `awaitingMasters` game, an additive `ev` cloud back-fill so its re-run after a
 * Lichess connect resolves those plies offline.
 *
 * Single-attempt: GET fresh blob → merge in pending updates by record
 * `(p, id)` → drop merges for records that no longer exist → PUT once.
 * No 412 retry loop — recovery for a concurrent-writer race is owned
 * by the app-root `<ConflictModal>` (the underlying `SessionStore.save`
 * fires the notifier on 412 before throwing). The throw still
 * propagates so the caller's catch can stop the pass.
 *
 * Verdicts whose target record is missing from the fresh blob (evicted
 * by a concurrent ingest, purged by an unlink) are silently dropped.
 *
 * Conflict resolution: if the fresh record already has a `fan`, defer to
 * the fresh value. A stale tab that started analyzing before a freshly
 * landed `fan` shouldn't overwrite it. Re-annotate handles the "I want to
 * redo this" case explicitly via `persistReannotateClear` (which deletes
 * the `fan` field) before this flush runs, so the only way a deferred
 * update happens is a real concurrent-tab race.
 *
 * Writing `fan` also drops any legacy `an` field still lingering on an old
 * blob — the migration gate is the presence of `fan`, and `an` carries no
 * meaning anymore.
 *
 * Optional `signal` short-circuits between the GET/merge and the PUT;
 * throws `DOMException('AbortError')` if aborted.
 */
export async function flushFanUpdates(
    dal: IRepertoireDataStore,
    updates: AnalyzedGameOutcome[],
    signal?: AbortSignal,
): Promise<{ data: RepertoireData; persisted: number }> {
    if (updates.length === 0) {
        const data = await dal.retrieveRepertoireData();
        return { data, persisted: 0 };
    }

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fresh = await dal.retrieveRepertoireData();
    const activity = fresh.activity;
    if (!activity) {
        // Fresh blob has no activity — nothing to merge into.
        return { data: fresh, persisted: 0 };
    }
    let persisted = 0;
    for (const upd of updates) {
        const found = findRecord(activity, upd.record.id, upd.record.p);
        if (!found) continue; // evicted / purged
        // Conflict resolution: any present `fan` on the fresh record wins —
        // the game is already analyzed, so neither a stale `fan` nor a deferred
        // `ev` back-fill should touch it.
        if (found.record.fan !== undefined) continue;

        if (!upd.skipped && upd.fan) {
            found.record.fan = upd.fan;
            // Drop the legacy masters-verdict field if an old blob still carries it.
            delete (found.record as { an?: unknown }).an;
            persisted++;
            continue;
        }

        // Deferred (awaiting-masters) game: additively back-fill the cloud evals
        // it gathered into `ev` so its re-run resolves those plies offline. Never
        // overwrites an existing eval — only fills `null`/absent slots. Only
        // persists when a slot actually changes, so a re-pass over an
        // already-cached deferred game doesn't trigger a redundant PUT.
        if (upd.evUpdate && upd.evUpdate.size > 0) {
            const ev = found.record.ev ? found.record.ev.slice() : [];
            let changed = false;
            for (const [ply, cp] of upd.evUpdate) {
                if (ply < 0) continue;
                while (ev.length <= ply) ev.push(null);
                if (ev[ply] === null || ev[ply] === undefined) {
                    ev[ply] = cp;
                    changed = true;
                }
            }
            if (changed) {
                found.record.ev = ev;
                persisted++;
            }
        }
    }
    if (persisted === 0) {
        return { data: fresh, persisted: 0 };
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = RepertoireDataUtils.prepareDataForSave(fresh);
    await dal.storeRepertoireData(blob, signal);
    return { data: fresh, persisted };
}

/**
 * Persist a single `op` (opponent-analysis) result back to the blob.
 *
 * Single-attempt: GET fresh blob → write `op` on the target record →
 * PUT once. No 412 retry — the app-root `<ConflictModal>` handles
 * recovery (`SessionStore.save` fires the notifier on 412).
 *
 * If the target record is evicted, the op is silently dropped (we don't
 * resurrect a record just to write `op` to it).
 *
 * Optional `signal` short-circuits between the GET and the PUT.
 */
export async function persistOpponentAnalysis(
    dal: IRepertoireDataStore,
    recordId: string,
    recordPlatform: 'l' | 'c',
    op: NonNullable<GameRecord['op']>,
    signal?: AbortSignal,
): Promise<RepertoireData> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fresh = await dal.retrieveRepertoireData();
    const activity = fresh.activity;
    if (!activity) return fresh;
    const found = findRecord(activity, recordId, recordPlatform);
    if (!found) return fresh;
    found.record.op = op;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = RepertoireDataUtils.prepareDataForSave(fresh);
    await dal.storeRepertoireData(blob, signal);
    return fresh;
}

/**
 * Persist a Re-annotate clear (drop `fan` and `op` for one record).
 *
 * Single-attempt: GET fresh blob → delete `fan`, `op`, and any legacy `an`
 * → PUT once. No 412 retry — the app-root `<ConflictModal>` handles
 * recovery. Clearing `fan` re-opens the record for the analysis pass (the
 * `fan`-absent gate).
 *
 * Optional `signal` short-circuits between the GET and the PUT.
 */
export async function persistReannotateClear(
    dal: IRepertoireDataStore,
    recordId: string,
    recordPlatform: 'l' | 'c',
    signal?: AbortSignal,
): Promise<RepertoireData> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fresh = await dal.retrieveRepertoireData();
    const activity = fresh.activity;
    if (!activity) return fresh;
    const found = findRecord(activity, recordId, recordPlatform);
    if (!found) return fresh;
    delete found.record.fan;
    delete found.record.op;
    delete (found.record as { an?: unknown }).an;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = RepertoireDataUtils.prepareDataForSave(fresh);
    await dal.storeRepertoireData(blob, signal);
    return fresh;
}

/**
 * Persist a Re-annotate **refresh** — replace one record in place with a
 * freshly-built one (typically rebuilt from a re-fetched provider payload
 * so newer `ev` / `o` data lands) and clear its `fan` / `op` so the
 * analysis pass picks it up.
 *
 * Single-attempt: GET fresh blob → replace the record in place → PUT
 * once. No 412 retry — the app-root `<ConflictModal>` handles recovery.
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
    dal: IRepertoireDataStore,
    freshRecord: GameRecord,
    signal?: AbortSignal,
): Promise<RepertoireData> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
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
        // Strip `fan` / `op` defensively — the refresh always wants the
        // analysis pass to re-derive the annotation from the new `ev`.
        const stripped: GameRecord = { ...freshRecord };
        delete stripped.fan;
        delete stripped.op;
        delete (stripped as { an?: unknown }).an;
        records[idx] = stripped;
        replaced = true;
        break;
    }
    if (!replaced) return fresh;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = RepertoireDataUtils.prepareDataForSave(fresh);
    await dal.storeRepertoireData(blob, signal);
    return fresh;
}

// Re-export for caller convenience.
export { ANALYSIS_FLUSH_BATCH };

/**
 * DEBUG / TEMP — Persist a bulk delete of every record with `t >= fromT`
 * back to the blob. Single-attempt (the app-root `<ConflictModal>` owns
 * 412 recovery). Also rewinds per-account ingest state (`watermarkMs`,
 * `recentIds`, chess.com `providerCursor`) so the next sync will re-fetch
 * and re-ingest the deleted games. Used by the /games page's debug
 * "Delete from here" menu. To be removed before the containing branch
 * merges.
 */
export async function persistDeleteRecordsFromTimestamp(
    dal: IRepertoireDataStore,
    fromT: number,
    signal?: AbortSignal,
): Promise<RepertoireData> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
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
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = RepertoireDataUtils.prepareDataForSave(fresh);
    await dal.storeRepertoireData(blob, signal);
    return fresh;
}
