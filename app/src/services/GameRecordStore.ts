import { Activity, GameRecord, PracticeLogEntry } from '../models/RepertoireData';
import { getDateStringForTimestamp, getOrCreateEntryByDate } from './ActivityService';

/**
 * Hard cap on the total number of `GameRecord` objects retained across
 * every day's `practiceLog[].games.records`. When the cap is exceeded
 * after an append, we evict the **oldest day's records as a whole**
 * (date-ascending), repeating until the total ≤ MAX_TOTAL_RECORDS.
 *
 * Eviction never partials a day; if a single day alone exceeds the cap,
 * its records are retained intact. See `docs/product-specs/GAMES-REFACTOR.md`
 * Retention section.
 */
export const MAX_TOTAL_RECORDS = 100;

/**
 * Append a `GameRecord` to the practice-log entry for the day it was played
 * (`record.t`). The entry is created via `getOrCreateEntryByDate` if needed.
 *
 * Idempotent on `(id, p)` within a day — re-appending the same record is a
 * no-op so a 412 retry that re-applies the same eligible games doesn't
 * double-up. Cross-day collisions (the same `id` in two days) are
 * impossible since `id` is a single game's provider id.
 *
 * Caller is expected to follow up with `evictOverflowingRecords(activity)`
 * after a batch of appends. We do NOT evict per-append because callers
 * often append many records in one ingest pass and a single eviction at
 * the end is both cheaper and easier to reason about.
 */
export function appendGameRecord(
    activity: Activity,
    record: GameRecord,
): void {
    const date = getDateStringForTimestamp(record.t);
    const entry = getOrCreateEntryByDate(activity, date);
    if (!entry.games) {
        entry.games = { ingested: 0, reviewed: 0, mistakes: 0 };
    }
    if (!entry.games.records) {
        entry.games.records = [];
    }
    // Dedup by (id, p). Same id can exist on both lichess (`"l"`) and chess.com (`"c"`)
    // accounts in principle — match the platform too so we don't collapse them.
    for (const existing of entry.games.records) {
        if (existing.id === record.id && existing.p === record.p) {
            return;
        }
    }
    entry.games.records.push(record);
}

/**
 * Evict whole days of records (oldest first by date) until the total
 * `record` count across `activity.practiceLog` is ≤ `MAX_TOTAL_RECORDS`.
 *
 * Eviction clears only the `records` array — `games.ingested` / `reviewed`
 * / `mistakes` stay so the Dashboard activity feed continues to show that
 * the day had ingested games. The `practiceLog` entry itself is not
 * removed (other counters may still populate it).
 *
 * If a single day alone exceeds the cap, it is preserved intact (we never
 * partial). This bounds the worst case at `cap + (one large day's
 * records)` until the next day's ingest sheds that day naturally.
 *
 * Returns the number of records dropped — useful for telemetry.
 */
export function evictOverflowingRecords(
    activity: Activity,
    maxTotal: number = MAX_TOTAL_RECORDS,
): number {
    const log = activity.practiceLog;
    let total = countRecords(log);
    if (total <= maxTotal) return 0;

    // Walk days in ascending date order (the log is kept sorted by date
    // ascending in `ActivityService.ensureActivity`). Drop entire records[]
    // arrays one at a time. Stop the moment we cross the threshold OR the
    // remaining entry is the only one left with records (cap < entry count
    // edge case — keep it intact).
    let dropped = 0;
    for (let i = 0; i < log.length; i++) {
        if (total <= maxTotal) break;
        const entry = log[i];
        const records = entry.games?.records;
        if (!records || records.length === 0) continue;

        // Single-entry overflow protection: if this is the ONLY day with
        // records AND its size alone exceeds the cap, leave it intact.
        if (countRecords(log) === records.length && records.length > maxTotal) {
            break;
        }

        const n = records.length;
        // Eviction = empty the array (`records.length = 0` would mutate;
        // assignment of `[]` keeps the same shape and is what the spec
        // describes — empty `records` with non-zero `ingested`).
        entry.games!.records = [];
        total -= n;
        dropped += n;
    }
    return dropped;
}

/**
 * Sum the per-day `records.length` across the practice log. Cheap (the
 * log is at most 30 entries).
 */
export function countRecords(log: PracticeLogEntry[]): number {
    let total = 0;
    for (const e of log) {
        const r = e.games?.records;
        if (r) total += r.length;
    }
    return total;
}

/**
 * Iterate every `GameRecord` across the practice log in date-then-time
 * order (oldest first). Useful for read-side consumers.
 */
export function* iterAllRecords(activity: Activity): Generator<GameRecord> {
    for (const entry of activity.practiceLog) {
        const records = entry.games?.records;
        if (!records || records.length === 0) continue;
        // Within a day, sort by `t` ascending so callers get a stable order.
        const sorted = [...records].sort((a, b) => a.t - b.t);
        for (const r of sorted) yield r;
    }
}

/**
 * Return all records as an array, newest first (descending by `t`).
 * The render-side ordering the /games page wants.
 */
export function getAllRecordsNewestFirst(activity: Activity): GameRecord[] {
    const all: GameRecord[] = [];
    for (const entry of activity.practiceLog) {
        const records = entry.games?.records;
        if (records && records.length > 0) all.push(...records);
    }
    all.sort((a, b) => b.t - a.t);
    return all;
}

/**
 * Remove every record belonging to the supplied set of (case-insensitive)
 * account usernames. Returns the number of records purged.
 *
 * Used on account unlink: mirrors the /games page behavior of dropping
 * cached games for a removed account so the user doesn't keep seeing
 * games on the page after disconnecting the account.
 *
 * Matching is case-insensitive against both `wa` and `ba` (provider
 * casing). Per-day counters (`ingested` / `reviewed` / `mistakes`) are
 * left alone — historical activity is not rewritten.
 */
export function purgeRecordsForAccounts(
    activity: Activity,
    removedUsernamesLower: ReadonlySet<string>,
): number {
    if (removedUsernamesLower.size === 0) return 0;
    let purged = 0;
    for (const entry of activity.practiceLog) {
        const records = entry.games?.records;
        if (!records || records.length === 0) continue;
        const kept: GameRecord[] = [];
        for (const r of records) {
            if (
                removedUsernamesLower.has(r.wa.toLowerCase())
                || removedUsernamesLower.has(r.ba.toLowerCase())
            ) {
                purged++;
            } else {
                kept.push(r);
            }
        }
        if (kept.length !== records.length) {
            entry.games!.records = kept;
        }
    }
    return purged;
}

/**
 * DEBUG / TEMP — Remove every record with `t >= fromT` from the activity
 * log. Used by the /games page's debug "Delete from here" menu to wipe
 * a record and every newer record in one shot. Per-day counters
 * (`ingested` / `reviewed` / `mistakes`) are left alone — this is a
 * debug-only purge, not a history rewrite.
 *
 * Returns the number of records purged. To be removed before the
 * containing branch merges.
 */
export function purgeRecordsFromTimestamp(
    activity: Activity,
    fromT: number,
): number {
    let purged = 0;
    for (const entry of activity.practiceLog) {
        const records = entry.games?.records;
        if (!records || records.length === 0) continue;
        const kept: GameRecord[] = [];
        for (const r of records) {
            if (r.t >= fromT) {
                purged++;
            } else {
                kept.push(r);
            }
        }
        if (kept.length !== records.length) {
            entry.games!.records = kept;
        }
    }
    return purged;
}

/**
 * Find a stored record by provider `id` + platform `p`. Walks the log;
 * cheap on real-world data (≤100 records).
 */
export function findRecord(
    activity: Activity,
    id: string,
    platform: 'l' | 'c',
): { record: GameRecord; entry: PracticeLogEntry } | null {
    for (const entry of activity.practiceLog) {
        const records = entry.games?.records;
        if (!records) continue;
        for (const r of records) {
            if (r.id === id && r.p === platform) return { record: r, entry };
        }
    }
    return null;
}
