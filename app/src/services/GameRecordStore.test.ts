import { describe, it, expect } from 'vitest';
import {
    appendGameRecord,
    countRecords,
    evictOverflowingRecords,
    findRecord,
    getAllRecordsNewestFirst,
    iterAllRecords,
    purgeRecordsForAccounts,
    MAX_TOTAL_RECORDS,
} from './GameRecordStore';
import { Activity, GameRecord } from '../models/RepertoireData';

function emptyActivity(): Activity {
    return {
        practiceLog: [],
        lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
    };
}

function makeRecord(opts: Partial<GameRecord> & { id: string; t: number; p?: 'l' | 'c' }): GameRecord {
    return {
        m: 'e4 e5',
        wa: 'me',
        ba: 'opp',
        res: 'draw',
        rt: 1,
        p: 'l',
        ...opts,
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_DATE = new Date('2026-05-25T12:00:00Z').getTime();

describe('appendGameRecord', () => {
    it('creates the per-day games object on first append', () => {
        const activity = emptyActivity();
        const rec = makeRecord({ id: 'a1', t: BASE_DATE });
        appendGameRecord(activity, rec);
        const day = activity.practiceLog[0];
        expect(day.games).toEqual({ ingested: 0, reviewed: 0, mistakes: 0, records: [rec] });
    });

    it('appends to the same day when called twice on the same date', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'a1', t: BASE_DATE }));
        appendGameRecord(activity, makeRecord({ id: 'a2', t: BASE_DATE + 1000 }));
        expect(activity.practiceLog).toHaveLength(1);
        expect(activity.practiceLog[0].games!.records!).toHaveLength(2);
    });

    it('dedups by (id, platform) within a day — re-append is a no-op', () => {
        const activity = emptyActivity();
        const rec = makeRecord({ id: 'a1', t: BASE_DATE });
        appendGameRecord(activity, rec);
        appendGameRecord(activity, rec);
        expect(activity.practiceLog[0].games!.records!).toHaveLength(1);
    });

    it('does NOT dedup across different platforms with same id', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'shared', t: BASE_DATE, p: 'l' }));
        appendGameRecord(activity, makeRecord({ id: 'shared', t: BASE_DATE, p: 'c' }));
        expect(activity.practiceLog[0].games!.records!).toHaveLength(2);
    });

    it('writes to the correct day based on record.t', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'today', t: BASE_DATE }));
        appendGameRecord(activity, makeRecord({ id: 'yesterday', t: BASE_DATE - DAY_MS }));
        expect(activity.practiceLog).toHaveLength(2);
        // ActivityService keeps log sorted ascending by date.
        expect(activity.practiceLog[0].games!.records!.map(r => r.id)).toEqual(['yesterday']);
        expect(activity.practiceLog[1].games!.records!.map(r => r.id)).toEqual(['today']);
    });

    it('preserves existing counters on the day', () => {
        const activity: Activity = {
            practiceLog: [
                { date: '2026-05-25', reviewed: 5, mistakes: 1, learned: 0, traversals: 1, timeSeconds: 60, games: { ingested: 2, reviewed: 1, mistakes: 0 } },
            ],
            lifetime: { reviewed: 5, mistakes: 1, learned: 0, traversals: 1, timeSeconds: 60 },
        };
        appendGameRecord(activity, makeRecord({ id: 'r1', t: BASE_DATE }));
        const d = activity.practiceLog[0];
        expect(d.games!.ingested).toBe(2);
        expect(d.games!.reviewed).toBe(1);
        expect(d.games!.records!).toHaveLength(1);
    });
});

describe('evictOverflowingRecords', () => {
    it('returns 0 when under the cap', () => {
        const activity = emptyActivity();
        for (let i = 0; i < 10; i++) {
            appendGameRecord(activity, makeRecord({ id: `r${i}`, t: BASE_DATE + i * 1000 }));
        }
        expect(evictOverflowingRecords(activity)).toBe(0);
        expect(countRecords(activity.practiceLog)).toBe(10);
    });

    it('evicts the oldest day whole when over the cap', () => {
        const activity = emptyActivity();
        // Day 1 (oldest): 5 records
        for (let i = 0; i < 5; i++) {
            appendGameRecord(activity, makeRecord({ id: `old${i}`, t: BASE_DATE - DAY_MS + i * 1000 }));
        }
        // Day 2: 50 records
        for (let i = 0; i < 50; i++) {
            appendGameRecord(activity, makeRecord({ id: `mid${i}`, t: BASE_DATE + i * 1000 }));
        }
        // Day 3: 50 records — totals 105 > 100
        for (let i = 0; i < 50; i++) {
            appendGameRecord(activity, makeRecord({ id: `new${i}`, t: BASE_DATE + DAY_MS + i * 1000 }));
        }
        const dropped = evictOverflowingRecords(activity, 100);
        expect(dropped).toBe(5);
        // Oldest day's records should be empty; other days intact.
        expect(activity.practiceLog[0].games!.records!).toHaveLength(0);
        expect(countRecords(activity.practiceLog)).toBe(100);
    });

    it('preserves a single oversized day intact (never partials)', () => {
        const activity = emptyActivity();
        for (let i = 0; i < 150; i++) {
            appendGameRecord(activity, makeRecord({ id: `g${i}`, t: BASE_DATE + i * 1000 }));
        }
        const dropped = evictOverflowingRecords(activity, 100);
        expect(dropped).toBe(0);
        expect(activity.practiceLog[0].games!.records!).toHaveLength(150);
    });

    it('evicts multiple oldest days if needed', () => {
        const activity = emptyActivity();
        // 5 days × 30 records = 150
        for (let d = 0; d < 5; d++) {
            for (let i = 0; i < 30; i++) {
                appendGameRecord(activity, makeRecord({
                    id: `d${d}r${i}`,
                    t: BASE_DATE - (4 - d) * DAY_MS + i * 1000,
                }));
            }
        }
        const dropped = evictOverflowingRecords(activity, 100);
        // Drops day 0 (30) — total 120 still > 100, drops day 1 (30) → 90.
        expect(dropped).toBe(60);
        expect(activity.practiceLog[0].games!.records!).toHaveLength(0);
        expect(activity.practiceLog[1].games!.records!).toHaveLength(0);
        expect(activity.practiceLog[2].games!.records!).toHaveLength(30);
        expect(countRecords(activity.practiceLog)).toBe(90);
    });

    it('honors MAX_TOTAL_RECORDS default', () => {
        const activity = emptyActivity();
        for (let i = 0; i < MAX_TOTAL_RECORDS + 1; i++) {
            appendGameRecord(activity, makeRecord({
                id: `r${i}`,
                t: BASE_DATE + Math.floor(i / 10) * DAY_MS + (i % 10) * 1000,
            }));
        }
        evictOverflowingRecords(activity);
        expect(countRecords(activity.practiceLog)).toBeLessThanOrEqual(MAX_TOTAL_RECORDS);
    });
});

describe('purgeRecordsForAccounts', () => {
    it('removes records where the user played as wa (case-insensitive)', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'a', t: BASE_DATE, wa: 'Alice', ba: 'bob' }));
        appendGameRecord(activity, makeRecord({ id: 'b', t: BASE_DATE + 1000, wa: 'eve', ba: 'mallory' }));
        const removed = purgeRecordsForAccounts(activity, new Set(['alice']));
        expect(removed).toBe(1);
        expect(activity.practiceLog[0].games!.records!.map(r => r.id)).toEqual(['b']);
    });

    it('removes records where the user played as ba', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'a', t: BASE_DATE, wa: 'opp', ba: 'Alice' }));
        const removed = purgeRecordsForAccounts(activity, new Set(['alice']));
        expect(removed).toBe(1);
    });

    it('keeps records where neither side matches', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'a', t: BASE_DATE, wa: 'eve', ba: 'mallory' }));
        const removed = purgeRecordsForAccounts(activity, new Set(['alice']));
        expect(removed).toBe(0);
        expect(activity.practiceLog[0].games!.records!).toHaveLength(1);
    });

    it('leaves the day\'s ingested/reviewed/mistakes counters alone (historical activity)', () => {
        const activity: Activity = {
            practiceLog: [
                {
                    date: '2026-05-25',
                    reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0,
                    games: {
                        ingested: 3, reviewed: 2, mistakes: 1,
                        records: [
                            makeRecord({ id: 'a', t: BASE_DATE, wa: 'Alice', ba: 'opp' }),
                            makeRecord({ id: 'b', t: BASE_DATE, wa: 'opp', ba: 'eve' }),
                            makeRecord({ id: 'c', t: BASE_DATE, wa: 'Alice', ba: 'opp' }),
                        ],
                    },
                },
            ],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        };
        purgeRecordsForAccounts(activity, new Set(['alice']));
        const games = activity.practiceLog[0].games!;
        expect(games.ingested).toBe(3);
        expect(games.reviewed).toBe(2);
        expect(games.mistakes).toBe(1);
        expect(games.records!).toHaveLength(1);
    });

    it('is a no-op for an empty removed set', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'a', t: BASE_DATE, wa: 'alice', ba: 'opp' }));
        expect(purgeRecordsForAccounts(activity, new Set())).toBe(0);
        expect(activity.practiceLog[0].games!.records!).toHaveLength(1);
    });
});

describe('findRecord / iterAllRecords / getAllRecordsNewestFirst', () => {
    it('findRecord returns the record + its entry', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'a', t: BASE_DATE }));
        const found = findRecord(activity, 'a', 'l');
        expect(found?.record.id).toBe('a');
        expect(found?.entry).toBe(activity.practiceLog[0]);
    });

    it('findRecord respects platform discrimination', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'shared', t: BASE_DATE, p: 'l' }));
        appendGameRecord(activity, makeRecord({ id: 'shared', t: BASE_DATE, p: 'c' }));
        expect(findRecord(activity, 'shared', 'l')?.record.p).toBe('l');
        expect(findRecord(activity, 'shared', 'c')?.record.p).toBe('c');
    });

    it('findRecord returns null when missing', () => {
        const activity = emptyActivity();
        expect(findRecord(activity, 'nope', 'l')).toBeNull();
    });

    it('iterAllRecords yields oldest-first', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'today', t: BASE_DATE }));
        appendGameRecord(activity, makeRecord({ id: 'yesterday', t: BASE_DATE - DAY_MS }));
        const ids = [...iterAllRecords(activity)].map(r => r.id);
        expect(ids).toEqual(['yesterday', 'today']);
    });

    it('getAllRecordsNewestFirst yields newest-first', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord({ id: 'old', t: BASE_DATE - DAY_MS }));
        appendGameRecord(activity, makeRecord({ id: 'new', t: BASE_DATE }));
        appendGameRecord(activity, makeRecord({ id: 'mid', t: BASE_DATE - 1000 }));
        const ids = getAllRecordsNewestFirst(activity).map(r => r.id);
        expect(ids).toEqual(['new', 'mid', 'old']);
    });
});

describe('invariant: records.length ≤ ingested (relaxed from the spec)', () => {
    it('records.length can be less than ingested after a build-failure simulation', () => {
        // Simulate ingest counting a game but failing to build its record
        // (e.g., provider payload malformed). The day's ingested counter is
        // ahead of records.length — that's allowed.
        const activity: Activity = {
            practiceLog: [
                {
                    date: '2026-05-25',
                    reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0,
                    games: { ingested: 3, reviewed: 0, mistakes: 0, records: [] },
                },
            ],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        };
        appendGameRecord(activity, makeRecord({ id: 'x', t: BASE_DATE }));
        const games = activity.practiceLog[0].games!;
        // records.length (1) < ingested (3) — invariant holds (≤).
        expect(games.records!.length).toBeLessThanOrEqual(games.ingested);
    });
});
