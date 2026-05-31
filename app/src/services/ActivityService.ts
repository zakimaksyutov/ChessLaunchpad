import { RepertoireData, Activity, PracticeLogEntry, LifetimeStats } from '../models/RepertoireData';

const MAX_LOG_ENTRIES = 30;

const EMPTY_LIFETIME: LifetimeStats = {
    reviewed: 0,
    mistakes: 0,
    learned: 0,
    traversals: 0,
    timeSeconds: 0,
};

function createEntry(date: string): PracticeLogEntry {
    return { date, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 };
}

/** Get today's date string in YYYY-MM-DD (local time). */
export function getTodayDateString(): string {
    return getDateStringForTimestamp(Date.now());
}

/** Get YYYY-MM-DD (local time) for a given timestamp in milliseconds. */
export function getDateStringForTimestamp(ms: number): string {
    const d = new Date(ms);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Returns true when an entry contributes to the manual-training streak. */
export function entryHasTrainingActivity(entry: PracticeLogEntry): boolean {
    return (entry.reviewed ?? 0) + (entry.mistakes ?? 0) + (entry.learned ?? 0) > 0;
}

/** Returns true when an entry has any visible activity (training OR game ingest). */
export function entryHasAnyActivity(entry: PracticeLogEntry): boolean {
    if (entryHasTrainingActivity(entry)) return true;
    const g = entry.games;
    if (!g) return false;
    return (g.ingested ?? 0) > 0 || (g.reviewed ?? 0) > 0 || (g.mistakes ?? 0) > 0;
}

/** Returns true when every counter on the entry (training + games) is zero. */
function isEmptyEntry(e: PracticeLogEntry): boolean {
    if ((e.reviewed ?? 0) !== 0) return false;
    if ((e.mistakes ?? 0) !== 0) return false;
    if ((e.learned ?? 0) !== 0) return false;
    if ((e.traversals ?? 0) !== 0) return false;
    if ((e.timeSeconds ?? 0) !== 0) return false;
    const g = e.games;
    if (g) {
        if ((g.ingested ?? 0) !== 0) return false;
        if ((g.reviewed ?? 0) !== 0) return false;
        if ((g.mistakes ?? 0) !== 0) return false;
    }
    return true;
}

/**
 * Remove all-zero practice-log entries so they don't waste the 30-entry cap.
 * Called during normalization to clean up blanks that earlier code may have persisted.
 */
function stripEmptyEntries(activity: Activity): void {
    activity.practiceLog = activity.practiceLog.filter(e => !isEmptyEntry(e));
}

/** Sort the practice log ascending by date (YYYY-MM-DD lexicographic == chronological). */
function sortLog(activity: Activity): void {
    activity.practiceLog.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Ensure `data.activity` exists and is well-formed.
 */
export function ensureActivity(data: RepertoireData): Activity {
    if (!data.activity) {
        data.activity = {
            practiceLog: [],
            lifetime: { ...EMPTY_LIFETIME },
        };
    }

    // Ensure lifetime exists
    if (!data.activity.lifetime) {
        data.activity.lifetime = { ...EMPTY_LIFETIME };
    }

    // Ensure practiceLog is an array
    if (!Array.isArray(data.activity.practiceLog)) {
        data.activity.practiceLog = [];
    }

    // One-time cleanup: a previous version seeded reviewed from dailyPlayCount
    // without setting traversals or lifetime, producing bogus stats. Reset those entries.
    if (data.activity.lifetime.traversals === 0 && data.activity.lifetime.reviewed === 0) {
        for (const entry of data.activity.practiceLog) {
            if (entry.reviewed > 0 && entry.traversals === 0) {
                entry.reviewed = 0;
            }
        }
    }

    // Strip blank entries so they don't consume the 30-entry cap
    stripEmptyEntries(data.activity);

    // Keep log sorted by date — game ingest may insert past-date entries
    sortLog(data.activity);

    return data.activity;
}

/**
 * Get (or create) the practice-log entry for the given date (YYYY-MM-DD).
 * If absent, inserts in date-sorted position; if log exceeds MAX_LOG_ENTRIES, drops the oldest.
 */
export function getOrCreateEntryByDate(activity: Activity, date: string): PracticeLogEntry {
    const log = activity.practiceLog;
    // Linear scan — log is at most 30 entries.
    for (let i = 0; i < log.length; i++) {
        if (log[i].date === date) return log[i];
    }

    const entry = createEntry(date);
    // Find insertion index that keeps the log sorted ascending by date.
    let insertAt = log.length;
    for (let i = 0; i < log.length; i++) {
        if (log[i].date > date) {
            insertAt = i;
            break;
        }
    }
    log.splice(insertAt, 0, entry);

    // Cap at MAX_LOG_ENTRIES — drop the oldest.
    while (log.length > MAX_LOG_ENTRIES) {
        log.shift();
    }

    return entry;
}

/**
 * Get (or create) today's practice log entry.
 * Looks up by date (not "last entry") — game ingest may have inserted past-date entries.
 */
export function getTodayEntry(activity: Activity): PracticeLogEntry {
    return getOrCreateEntryByDate(activity, getTodayDateString());
}

/** Get the practice-log entry for today if one exists; otherwise null (no mutation). */
export function findEntryByDate(activity: Activity, date: string): PracticeLogEntry | null {
    for (const entry of activity.practiceLog) {
        if (entry.date === date) return entry;
    }
    return null;
}

export interface TraversalStats {
    reviewed: number;
    mistakes: number;
    learned: number;
}

/** Compute today's play count from the practice log (single source of truth). */
export function getTodayPlayCount(data: RepertoireData): number {
    if (!data.activity) return 0;
    const today = findEntryByDate(data.activity, getTodayDateString());
    return today?.reviewed ?? 0;
}

/**
 * Record a completed traversal into activity data.
 * Updates both today's entry and lifetime totals.
 * Also keeps `dailyPlayCount` in sync for backend compatibility.
 */
export function recordTraversal(
    data: RepertoireData,
    stats: TraversalStats,
    elapsedSeconds: number,
): void {
    const activity = ensureActivity(data);
    const entry = getTodayEntry(activity);

    entry.reviewed += stats.reviewed;
    entry.mistakes += stats.mistakes;
    entry.learned += stats.learned;
    entry.traversals += 1;
    entry.timeSeconds += Math.round(elapsedSeconds);

    activity.lifetime.reviewed += stats.reviewed;
    activity.lifetime.mistakes += stats.mistakes;
    activity.lifetime.learned += stats.learned;
    activity.lifetime.traversals += 1;
    activity.lifetime.timeSeconds += Math.round(elapsedSeconds);

    // Update persisted bestStreak so it survives log eviction
    const logBest = computeBestStreak(activity.practiceLog);
    activity.lifetime.bestStreak = Math.max(activity.lifetime.bestStreak ?? 0, logBest);

    // Update persisted currentStreak — use log value unless streak may extend beyond window
    const logCurrentStreak = computeCurrentStreak(activity.practiceLog);
    const mayBeTruncated = logCurrentStreak > 0
        && activity.practiceLog.length >= MAX_LOG_ENTRIES
        && logCurrentStreak >= activity.practiceLog.length - 1;
    if (mayBeTruncated) {
        activity.lifetime.currentStreak = Math.max(activity.lifetime.currentStreak ?? 0, logCurrentStreak);
    } else {
        activity.lifetime.currentStreak = logCurrentStreak;
    }
}

/**
 * Record elapsed time only (e.g., on page unmount without completing a traversal).
 */
export function recordTime(data: RepertoireData, elapsedSeconds: number): void {
    const rounded = Math.round(elapsedSeconds);
    if (rounded <= 0) return;
    const activity = ensureActivity(data);
    const entry = getTodayEntry(activity);
    entry.timeSeconds += rounded;
    activity.lifetime.timeSeconds += rounded;
}

/** Compute accuracy rate. Returns null when denominator is 0. */
export function computeAccuracy(reviewed: number, mistakes: number): number | null {
    const total = reviewed + mistakes;
    if (total === 0) return null;
    return reviewed / total;
}

/**
 * Get best streak, accounting for possible log truncation.
 * Uses persisted lifetime value when older entries have been evicted.
 */
export function getBestStreak(activity: Activity): number {
    return Math.max(
        computeBestStreak(activity.practiceLog),
        activity.lifetime.bestStreak ?? 0,
    );
}

/**
 * Get current streak, accounting for possible log truncation.
 * Uses persisted lifetime value only when the streak spans the full log window.
 */
export function getCurrentStreak(activity: Activity): number {
    const logStreak = computeCurrentStreak(activity.practiceLog);
    if (logStreak === 0) return 0;

    const persisted = activity.lifetime.currentStreak ?? 0;
    if (activity.practiceLog.length >= MAX_LOG_ENTRIES && logStreak >= activity.practiceLog.length - 1) {
        return Math.max(logStreak, persisted);
    }
    return logStreak;
}

/** Compute current streak (consecutive days including today with activity). */
export function computeCurrentStreak(practiceLog: PracticeLogEntry[]): number {
    if (practiceLog.length === 0) return 0;

    const today = getTodayDateString();
    const yesterdayStr = getPreviousDate(today);
    let streak = 0;
    let expectedDate = today;

    // Walk backward from the end of the log
    for (let i = practiceLog.length - 1; i >= 0; i--) {
        const entry = practiceLog[i];
        const total = entry.reviewed + entry.mistakes + entry.learned;
        if (entry.date === expectedDate && total > 0) {
            streak++;
            expectedDate = getPreviousDate(expectedDate);
        } else if (entry.date === expectedDate && total === 0) {
            // Today exists but no activity yet — skip without breaking
            if (i === practiceLog.length - 1) {
                expectedDate = getPreviousDate(expectedDate);
            } else {
                break;
            }
        } else if (i === practiceLog.length - 1 && entry.date === yesterdayStr && total > 0) {
            // No today entry — yesterday is active, continue streak from there
            streak++;
            expectedDate = getPreviousDate(entry.date);
        } else {
            break;
        }
    }

    return streak;
}

/** Compute best streak from the log. */
export function computeBestStreak(practiceLog: PracticeLogEntry[]): number {
    if (practiceLog.length === 0) return 0;

    let best = 0;
    let current = 0;
    let prevDate: string | null = null;

    for (const entry of practiceLog) {
        const total = entry.reviewed + entry.mistakes + entry.learned;
        if (total === 0) {
            current = 0;
            prevDate = entry.date;
            continue;
        }

        if (prevDate === null || isConsecutiveDay(prevDate, entry.date)) {
            current++;
        } else {
            current = 1;
        }
        best = Math.max(best, current);
        prevDate = entry.date;
    }

    return best;
}

function getPreviousDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d - 1); // local date, day underflow handled by Date
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isConsecutiveDay(prev: string, current: string): boolean {
    return getPreviousDate(current) === prev;
}
