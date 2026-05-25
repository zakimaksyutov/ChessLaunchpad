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
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Ensure `data.activity` exists and is well-formed.
 */
export function ensureActivity(data: RepertoireData): Activity {
    if (!data.activity) {
        const today = getTodayDateString();
        const entry = createEntry(today);

        data.activity = {
            practiceLog: [entry],
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

    return data.activity;
}

/**
 * Get (or create) today's practice log entry.
 * If the latest entry is not for today, appends a new one (capping at 30).
 */
export function getTodayEntry(activity: Activity): PracticeLogEntry {
    const today = getTodayDateString();
    const log = activity.practiceLog;

    if (log.length > 0 && log[log.length - 1].date === today) {
        return log[log.length - 1];
    }

    // New day — append entry
    const entry = createEntry(today);
    log.push(entry);

    // Cap at MAX_LOG_ENTRIES
    while (log.length > MAX_LOG_ENTRIES) {
        log.shift();
    }

    return entry;
}

export interface TraversalStats {
    reviewed: number;
    mistakes: number;
    learned: number;
}

/**
 * Record a completed traversal into activity data.
 * Updates both today's entry and lifetime totals.
 * Also keeps `dailyPlayCount` in sync.
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

    // Backward compat: dailyPlayCount = today's reviewed
    data.dailyPlayCount = entry.reviewed;
}

/**
 * Record elapsed time only (e.g., on page unmount without completing a traversal).
 */
export function recordTime(data: RepertoireData, elapsedSeconds: number): void {
    if (elapsedSeconds <= 0) return;
    const activity = ensureActivity(data);
    const entry = getTodayEntry(activity);
    const rounded = Math.round(elapsedSeconds);
    entry.timeSeconds += rounded;
    activity.lifetime.timeSeconds += rounded;
}

/** Compute accuracy rate. Returns null when denominator is 0. */
export function computeAccuracy(reviewed: number, mistakes: number): number | null {
    const total = reviewed + mistakes;
    if (total === 0) return null;
    return reviewed / total;
}

/** Compute current streak (consecutive days including today with activity). */
export function computeCurrentStreak(practiceLog: PracticeLogEntry[]): number {
    if (practiceLog.length === 0) return 0;

    const today = getTodayDateString();
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
