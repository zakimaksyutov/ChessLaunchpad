import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RepertoireData } from '../models/RepertoireData';
import {
    ensureActivity,
    getTodayEntry,
    recordTraversal,
    recordTime,
    computeAccuracy,
    computeCurrentStreak,
    computeBestStreak,
    getTodayDateString,
} from './ActivityService';

function makeRepertoireData(overrides: Partial<RepertoireData> = {}): RepertoireData {
    return {
        data: [],
        currentEpoch: 0,
        lastPlayedDate: new Date(),
        dailyPlayCount: 0,
        fsrsCards: {},
        ...overrides,
    };
}

describe('ActivityService', () => {
    const today = getTodayDateString();

    describe('ensureActivity', () => {
        it('initializes activity when missing', () => {
            const data = makeRepertoireData();
            const activity = ensureActivity(data);
            expect(data.activity).toBe(activity);
            expect(activity.practiceLog).toHaveLength(1);
            expect(activity.practiceLog[0].date).toBe(today);
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

        it('cleans up bogus dailyPlayCount migration (reviewed > 0 but traversals === 0)', () => {
            const data = makeRepertoireData({
                activity: {
                    practiceLog: [{ date: today, reviewed: 13, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 }],
                    lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                },
            });
            const activity = ensureActivity(data);
            expect(activity.practiceLog[0].reviewed).toBe(0);
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

            expect(data.activity!.practiceLog[0].timeSeconds).toBe(0);
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
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

            const log = [
                { date: yStr, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: today, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
            ];
            expect(computeCurrentStreak(log)).toBe(2);
        });

        it('returns 0 when today has no activity', () => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

            const log = [
                { date: yStr, reviewed: 1, mistakes: 0, learned: 0, traversals: 1, timeSeconds: 10 },
                { date: today, reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
            ];
            // Today empty → check if yesterday counts from yesterday
            expect(computeCurrentStreak(log)).toBe(1);
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
});
