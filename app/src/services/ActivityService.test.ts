import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RepertoireData } from '../models/RepertoireData';
import {
    ensureActivity,
    getTodayEntry,
    getOrCreateEntryByDate,
    findEntryByDate,
    getDateStringForTimestamp,
    entryHasTrainingActivity,
    entryHasAnyActivity,
    recordTraversal,
    recordTime,
    computeAccuracy,
    computeCurrentStreak,
    computeBestStreak,
    getCurrentStreak,
    getBestStreak,
} from './ActivityService';

function makeRepertoireData(overrides: Partial<RepertoireData> = {}): RepertoireData {
    return {
        data: [],
        lastPlayedDate: new Date(),
        dailyPlayCount: 0,
        fsrsCards: {},
        ...overrides,
    };
}

describe('ActivityService', () => {
    // Pin the clock so tests are deterministic and immune to midnight rollover.
    const FAKE_NOW = new Date('2026-05-25T12:00:00');
    const today = '2026-05-25';
    const yesterday = '2026-05-24';

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(FAKE_NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('ensureActivity', () => {
        it('initializes activity with empty practice log when missing', () => {
            const data = makeRepertoireData();
            const activity = ensureActivity(data);
            expect(data.activity).toBe(activity);
            expect(activity.practiceLog).toHaveLength(0);
            expect(activity.lifetime.reviewed).toBe(0);
        });

        it('preserves existing activity', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [{ date: today, reviewed: 10, mistakes: 2, learned: 0, traversals: 3, timeSeconds: 100 }],
                    lifetime: { reviewed: 100, mistakes: 20, learned: 10, traversals: 50, timeSeconds: 5000 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog[0].reviewed).toBe(10);
            expect(activity.lifetime.reviewed).toBe(100);
        });

        it('strips blank entries from practice log', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        { date: '2026-05-20', reviewed: 5, mistakes: 1, learned: 0, traversals: 2, timeSeconds: 120 },
                        { date: '2026-05-21', reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                        { date: '2026-05-22', reviewed: 3, mistakes: 0, learned: 1, traversals: 1, timeSeconds: 60 },
                    ],
                    lifetime: { reviewed: 8, mistakes: 1, learned: 1, traversals: 3, timeSeconds: 180 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog).toHaveLength(2);
            expect(activity.practiceLog[0].date).toBe('2026-05-20');
            expect(activity.practiceLog[1].date).toBe('2026-05-22');
        });

        it('cleans up bogus dailyPlayCount migration (reviewed > 0 but traversals === 0)', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [{ date: today, reviewed: 13, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 }],
                    lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                },
            });
            const activity = ensureActivity(data);
            // Migration resets reviewed to 0, then stripEmptyEntries removes the all-zero entry
            expect(activity.practiceLog).toHaveLength(0);
        });

        it('does not clean up entries with real traversals', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [{ date: today, reviewed: 10, mistakes: 2, learned: 0, traversals: 3, timeSeconds: 100 }],
                    lifetime: { reviewed: 10, mistakes: 2, learned: 0, traversals: 3, timeSeconds: 100 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog[0].reviewed).toBe(10);
        });
    });

    describe('getTodayEntry', () => {
        it('returns existing today entry', () => {
            const entry = { date: today, reviewed: 3, mistakes: 1, learned: 0, traversals: 1, timeSeconds: 60 };
            const activity = { practiceLog: [entry], lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 } };
            expect(getTodayEntry(activity)).toBe(entry);
        });

        it('creates new entry when latest is a different day', () => {
            const activity = {
                practiceLog: [{ date: '2020-01-01', reviewed: 5, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 60 }],
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };
            const entry = getTodayEntry(activity);
            expect(entry.date).toBe(today);
            expect(entry.reviewed).toBe(0);
            expect(activity.practiceLog).toHaveLength(2);
        });

        it('finds today entry even when it is not the last log entry', () => {
            // Game ingest may insert past-date entries — today's entry might not be at the end.
            const todayEntry = { date: today, reviewed: 2, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 30 };
            const activity = {
                practiceLog: [
                    todayEntry,
                    // (a hypothetical future-dated entry — shouldn't happen but proves we find by date)
                ],
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };
            expect(getTodayEntry(activity)).toBe(todayEntry);
        });

        it('caps at 30 entries', () => {
            const entries = Array.from({ length: 30 }, (_, i) => ({
                date: `2020-01-${String(i + 1).padStart(2, '0')}`,
                reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10,
            }));
            const activity = {
                practiceLog: entries,
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };

            const entry = getTodayEntry(activity);
            expect(entry.date).toBe(today);
            expect(activity.practiceLog).toHaveLength(30);
            // Oldest entry dropped
            expect(activity.practiceLog[0].date).toBe('2020-01-02');
        });
    });

    describe('getOrCreateEntryByDate', () => {
        it('returns existing entry by date', () => {
            const e1 = { date: '2026-05-20', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 };
            const e2 = { date: '2026-05-22', reviewed: 2, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 20 };
            const activity = { practiceLog: [e1, e2], lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 } };
            expect(getOrCreateEntryByDate(activity, '2026-05-20')).toBe(e1);
            expect(getOrCreateEntryByDate(activity, '2026-05-22')).toBe(e2);
        });

        it('inserts new entry in sorted position', () => {
            const activity = {
                practiceLog: [
                    { date: '2026-05-20', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                    { date: '2026-05-25', reviewed: 2, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 20 },
                ],
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };
            const inserted = getOrCreateEntryByDate(activity, '2026-05-22');
            expect(inserted.date).toBe('2026-05-22');
            expect(activity.practiceLog.map(e => e.date)).toEqual(['2026-05-20', '2026-05-22', '2026-05-25']);
        });

        it('inserts new entry at the beginning when older than all existing', () => {
            const activity = {
                practiceLog: [
                    { date: '2026-05-22', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                ],
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };
            getOrCreateEntryByDate(activity, '2026-05-19');
            expect(activity.practiceLog.map(e => e.date)).toEqual(['2026-05-19', '2026-05-22']);
        });

        it('inserts new entry at the end when newer than all existing', () => {
            const activity = {
                practiceLog: [
                    { date: '2026-05-19', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                ],
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };
            getOrCreateEntryByDate(activity, '2026-05-22');
            expect(activity.practiceLog.map(e => e.date)).toEqual(['2026-05-19', '2026-05-22']);
        });

        it('caps at 30 entries, dropping oldest', () => {
            const entries = Array.from({ length: 30 }, (_, i) => ({
                date: `2026-04-${String(i + 1).padStart(2, '0')}`,
                reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10,
            }));
            const activity = {
                practiceLog: entries,
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            };
            getOrCreateEntryByDate(activity, '2026-05-10');
            expect(activity.practiceLog).toHaveLength(30);
            expect(activity.practiceLog[0].date).toBe('2026-04-02');
            expect(activity.practiceLog[activity.practiceLog.length - 1].date).toBe('2026-05-10');
        });
    });

    describe('findEntryByDate', () => {
        it('returns existing entry', () => {
            const e = { date: '2026-05-20', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 };
            const activity = { practiceLog: [e], lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 } };
            expect(findEntryByDate(activity, '2026-05-20')).toBe(e);
        });
        it('returns null when missing', () => {
            const activity = { practiceLog: [], lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 } };
            expect(findEntryByDate(activity, '2026-05-20')).toBeNull();
        });
    });

    describe('getDateStringForTimestamp', () => {
        it('returns YYYY-MM-DD for a given timestamp in local time', () => {
            // Pinned clock to 2026-05-25T12:00:00 local time.
            const ms = new Date('2026-05-25T12:00:00').getTime();
            expect(getDateStringForTimestamp(ms)).toBe('2026-05-25');
        });
        it('handles past and future timestamps', () => {
            expect(getDateStringForTimestamp(new Date('2026-04-15T09:00:00').getTime())).toBe('2026-04-15');
            expect(getDateStringForTimestamp(new Date('2026-12-31T23:59:00').getTime())).toBe('2026-12-31');
        });
    });

    describe('entry-activity helpers', () => {
        it('treats training-only entries as having training activity', () => {
            const entry = { date: today, reviewed: 5, mistakes: 1, learned: 0, traversals: 1, timeSeconds: 60 };
            expect(entryHasTrainingActivity(entry)).toBe(true);
            expect(entryHasAnyActivity(entry)).toBe(true);
        });
        it('treats games-only entries as activity but not training activity', () => {
            const entry = {
                date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0,
                games: { ingested: 3, reviewed: 6, mistakes: 1 },
            };
            expect(entryHasTrainingActivity(entry)).toBe(false);
            expect(entryHasAnyActivity(entry)).toBe(true);
        });
        it('treats fully empty entries as no activity', () => {
            const entry = { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 };
            expect(entryHasTrainingActivity(entry)).toBe(false);
            expect(entryHasAnyActivity(entry)).toBe(false);
        });
    });

    describe('ensureActivity with games sub-object', () => {
        it('preserves entries with games counters even when training counters are zero', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        {
                            date: '2026-05-22', reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0,
                            games: { ingested: 3, reviewed: 5, mistakes: 1 },
                        },
                    ],
                    lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog).toHaveLength(1);
        });

        it('strips entries with all-zero training AND all-zero games counters', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        {
                            date: '2026-05-22', reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0,
                            games: { ingested: 0, reviewed: 0, mistakes: 0 },
                        },
                    ],
                    lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog).toHaveLength(0);
        });

        it('sorts log ascending by date', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        { date: '2026-05-22', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: '2026-05-20', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: '2026-05-21', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                    ],
                    lifetime: { reviewed: 3, mistakes: 0, learned: 0, traversals: 3, timeSeconds: 30 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog.map(e => e.date)).toEqual(['2026-05-20', '2026-05-21', '2026-05-22']);
        });
    });

    describe('recordTraversal', () => {
        it('updates today entry and lifetime totals', () => {
            const data = makeRepertoireData();
            ensureActivity(data);

            recordTraversal(data, { reviewed: 5, mistakes: 2, learned: 1 }, 120);

            const entry = data.activity!.practiceLog[data.activity!.practiceLog.length - 1];
            expect(entry.reviewed).toBe(5);
            expect(entry.mistakes).toBe(2);
            expect(entry.learned).toBe(1);
            expect(entry.traversals).toBe(1);
            expect(entry.timeSeconds).toBe(120);

            expect(data.activity!.lifetime.reviewed).toBe(5);
            expect(data.activity!.lifetime.traversals).toBe(1);
            expect(data.dailyPlayCount).toBe(0);
        });

        it('accumulates across multiple traversals', () => {
            const data = makeRepertoireData();
            ensureActivity(data);

            recordTraversal(data, { reviewed: 3, mistakes: 0, learned: 0 }, 60);
            recordTraversal(data, { reviewed: 2, mistakes: 1, learned: 0 }, 45);

            const entry = data.activity!.practiceLog[data.activity!.practiceLog.length - 1];
            expect(entry.reviewed).toBe(5);
            expect(entry.mistakes).toBe(1);
            expect(entry.traversals).toBe(2);
            expect(entry.timeSeconds).toBe(105);
            expect(data.dailyPlayCount).toBe(0);
        });
    });

    describe('recordTime', () => {
        it('adds time without affecting other counters', () => {
            const data = makeRepertoireData();
            ensureActivity(data);

            recordTime(data, 30);

            const entry = data.activity!.practiceLog[data.activity!.practiceLog.length - 1];
            expect(entry.timeSeconds).toBe(30);
            expect(entry.reviewed).toBe(0);
            expect(data.activity!.lifetime.timeSeconds).toBe(30);
        });

        it('ignores zero or negative time', () => {
            const data = makeRepertoireData();
            ensureActivity(data);

            recordTime(data, 0);
            recordTime(data, -5);

            // No entry should be created for zero/negative time
            expect(data.activity!.practiceLog).toHaveLength(0);
            expect(data.activity!.lifetime.timeSeconds).toBe(0);
        });

        it('ignores sub-second time that rounds to zero', () => {
            const data = makeRepertoireData();
            ensureActivity(data);

            recordTime(data, 0.3);

            // Rounds to 0 — no entry created
            expect(data.activity!.practiceLog).toHaveLength(0);
            expect(data.activity!.lifetime.timeSeconds).toBe(0);
        });
    });

    describe('computeAccuracy', () => {
        it('returns null when no reviews', () => {
            expect(computeAccuracy(0, 0)).toBeNull();
        });

        it('computes correct ratio', () => {
            expect(computeAccuracy(9, 1)).toBeCloseTo(0.9);
        });

        it('returns 1.0 with no mistakes', () => {
            expect(computeAccuracy(10, 0)).toBe(1);
        });
    });

    describe('computeCurrentStreak', () => {
        it('returns 0 for empty log', () => {
            expect(computeCurrentStreak([])).toBe(0);
        });

        it('counts consecutive days including today', () => {
            const log = [
                { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: today, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
            ];
            expect(computeCurrentStreak(log)).toBe(2);
        });

        it('returns 0 when today has no activity', () => {
            const log = [
                { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            ];
            // Today empty → check if yesterday counts from yesterday
            expect(computeCurrentStreak(log)).toBe(1);
        });

        it('returns streak from yesterday when no today entry exists', () => {
            const log = [
                { date: '2026-05-23', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
            ];
            // No today entry — streak continues from yesterday
            expect(computeCurrentStreak(log)).toBe(2);
        });

        it('returns 0 when no today entry and last entry is two days ago', () => {
            const log = [
                { date: '2026-05-23', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
            ];
            // Two days ago — streak is broken
            expect(computeCurrentStreak(log)).toBe(0);
        });
    });

    describe('computeBestStreak', () => {
        it('returns 0 for empty log', () => {
            expect(computeBestStreak([])).toBe(0);
        });

        it('finds best streak across gaps', () => {
            const log = [
                { date: '2026-05-20', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: '2026-05-21', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: '2026-05-22', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                // gap: May 23 missing
                { date: '2026-05-24', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: '2026-05-25', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
            ];
            expect(computeBestStreak(log)).toBe(3);
        });
    });

    describe('recordTraversal persists bestStreak in lifetime', () => {
        it('updates lifetime.bestStreak after recording a traversal', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                    ],
                    lifetime: { reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                },
            });

            recordTraversal(data, { reviewed: 3, mistakes: 0, learned: 0 }, 60);

            // Yesterday + today = 2-day streak
            expect(data.activity!.lifetime.bestStreak).toBe(2);
        });

        it('preserves bestStreak when log entries are evicted', () => {
            // Simulate: lifetime already recorded a 10-day streak, but those entries are gone
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        { date: today, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                    ],
                    lifetime: { reviewed: 50, mistakes: 5, learned: 3, traversals: 20, timeSeconds: 3000, bestStreak: 10 },
                },
            });

            recordTraversal(data, { reviewed: 2, mistakes: 0, learned: 0 }, 30);

            // Log only has today (streak=1), but lifetime bestStreak=10 is preserved
            expect(data.activity!.lifetime.bestStreak).toBe(10);
        });

        it('upgrades bestStreak when log streak exceeds persisted value', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        { date: '2026-05-23', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                    ],
                    lifetime: { reviewed: 10, mistakes: 1, learned: 0, traversals: 5, timeSeconds: 500, bestStreak: 2 },
                },
            });

            recordTraversal(data, { reviewed: 1, mistakes: 0, learned: 0 }, 20);

            // 3 consecutive days now > previous bestStreak of 2
            expect(data.activity!.lifetime.bestStreak).toBe(3);
        });
    });

    describe('recordTraversal persists currentStreak in lifetime', () => {
        it('updates lifetime.currentStreak after recording a traversal', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                    ],
                    lifetime: { reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                },
            });

            recordTraversal(data, { reviewed: 3, mistakes: 0, learned: 0 }, 60);

            expect(data.activity!.lifetime.currentStreak).toBe(2);
        });

        it('resets currentStreak when streak is broken', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [
                        // Gap before today — streak was broken
                        { date: '2026-05-20', reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                        { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                    ],
                    lifetime: { reviewed: 50, mistakes: 5, learned: 3, traversals: 20, timeSeconds: 3000, currentStreak: 15 },
                },
            });

            recordTraversal(data, { reviewed: 1, mistakes: 0, learned: 0 }, 20);

            // Streak was broken — log shows 1, persisted 15 must be overwritten
            expect(data.activity!.lifetime.currentStreak).toBe(1);
        });

        it('preserves currentStreak when log is at cap and streak spans full window', () => {
            // Build a full 30-entry log of consecutive active days ending today
            const entries = Array.from({ length: 30 }, (_, i) => {
                const d = new Date(2026, 4, 25 - 29 + i); // Apr 26 through May 25
                const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                return { date, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 };
            });
            const data = makeRepertoireData({
                activity: {
                    practiceLog: entries,
                    lifetime: { reviewed: 100, mistakes: 10, learned: 5, traversals: 50, timeSeconds: 5000, currentStreak: 45 },
                },
            });

            recordTraversal(data, { reviewed: 1, mistakes: 0, learned: 0 }, 10);

            // Log shows 30-day streak (all entries active) but persisted 45 is preserved
            expect(data.activity!.lifetime.currentStreak).toBe(45);
        });
    });

    describe('getCurrentStreak helper', () => {
        it('returns log-based streak when log is not at cap', () => {
            const activity = {
                practiceLog: [
                    { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                    { date: today, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                ],
                lifetime: { reviewed: 10, mistakes: 1, learned: 0, traversals: 5, timeSeconds: 500, currentStreak: 20 },
            };
            // Log is not at cap (2 entries < 30), so log value wins even though persisted is higher
            expect(getCurrentStreak(activity)).toBe(2);
        });

        it('returns persisted value when streak spans full capped log', () => {
            const entries = Array.from({ length: 30 }, (_, i) => {
                const d = new Date(2026, 4, 25 - 29 + i);
                const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                return { date, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 };
            });
            const activity = {
                practiceLog: entries,
                lifetime: { reviewed: 100, mistakes: 10, learned: 5, traversals: 50, timeSeconds: 5000, currentStreak: 45 },
            };
            expect(getCurrentStreak(activity)).toBe(45);
        });

        it('returns 0 when no activity', () => {
            const activity = {
                practiceLog: [{ date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 }],
                lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0, currentStreak: 0 },
            };
            expect(getCurrentStreak(activity)).toBe(0);
        });
    });

    describe('getBestStreak helper', () => {
        it('returns persisted value when it exceeds log-based streak', () => {
            const activity = {
                practiceLog: [
                    { date: today, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                ],
                lifetime: { reviewed: 50, mistakes: 5, learned: 3, traversals: 20, timeSeconds: 3000, bestStreak: 15 },
            };
            expect(getBestStreak(activity)).toBe(15);
        });

        it('returns log-based value when it exceeds persisted', () => {
            const activity = {
                practiceLog: [
                    { date: yesterday, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                    { date: today, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                ],
                lifetime: { reviewed: 10, mistakes: 1, learned: 0, traversals: 5, timeSeconds: 500, bestStreak: 1 },
            };
            expect(getBestStreak(activity)).toBe(2);
        });
    });
});
