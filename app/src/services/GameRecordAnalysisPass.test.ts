import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Chess } from 'chess.js';
import { ExplorerEvals } from '../models/ExplorerEvals';
import {
    AnalysisJob,
    AnalyzedGameOutcome,
    analyzeOneGame,
    buildAnalysisPlan,
    flushFanUpdates,
    persistOpponentAnalysis,
    persistSuggestion,
    persistGameReviewed,
    persistReannotateClear,
    persistReannotateRefresh,
} from './GameRecordAnalysisPass';
import {
    GameRecord,
    FrozenAnnotation,
    RepertoireData,
} from '../models/RepertoireData';
import { IDataAccessLayer, DataAccessError } from '../data/DataAccessLayer';
import { appendGameRecord } from './GameRecordStore';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';
import { buildRepertoireFenSets, INITIAL_POSITION_FEN } from '../models/RepertoireFenSet';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';

function makeData(): RepertoireData {
    const data: RepertoireData = {
        repertoires: pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]),
        fsrsCards: {},
        settings: { linkedAccounts: [{ platform: 'lichess', username: 'me' }] },
        activity: {
            practiceLog: [],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        },
    };
    RepertoireDataUtils.normalize(data);
    return data;
}

function rec(opts: Partial<GameRecord> & { id: string; t: number }): GameRecord {
    return {
        p: 'l',
        m: 'e4 e5 Nf3',
        wa: 'me',
        ba: 'opp',
        res: 'win',
        rt: 1,
        ...opts,
    };
}

function fanOf(hl: number[], mb = 0, alt?: string[]): FrozenAnnotation {
    return alt ? { hl, mb, alt } : { hl, mb };
}

/** A bare AnalysisJob carrier for the analyze tests. */
function job(record: GameRecord): AnalysisJob {
    return { record, userLower: 'me', repertoireFens: new Set<string>() };
}

class MockDal implements IDataAccessLayer {
    data: RepertoireData;
    retrieveCount = 0;
    storeCount = 0;
    nextStoreError: DataAccessError | null = null;

    constructor(initial: RepertoireData) {
        this.data = clone(initial);
    }
    async createAccount() {}
    async deleteAccount() {}
    async retrieveRepertoireData(): Promise<RepertoireData> {
        this.retrieveCount += 1;
        return clone(this.data);
    }
    async storeRepertoireData(data: RepertoireData): Promise<void> {
        this.storeCount += 1;
        if (this.nextStoreError) {
            const err = this.nextStoreError;
            this.nextStoreError = null;
            throw err;
        }
        this.data = clone(data);
    }
}

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

const BASE_DATE = new Date('2026-05-25T12:00:00Z').getTime();

describe('buildAnalysisPlan', () => {
    it('returns an empty plan when there are no records', async () => {
        const data = makeData();
        const plan = await buildAnalysisPlan(data);
        expect(plan).toEqual([]);
    });

    it('skips records that already have fan', async () => {
        const data = makeData();
        const r = rec({ id: 'done', t: BASE_DATE, fan: fanOf([0, 0]) });
        appendGameRecord(data.activity!, r);
        const plan = await buildAnalysisPlan(data);
        expect(plan).toEqual([]);
    });

    it('includes records lacking fan, sorted newest-first, with owner + fens attached', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'old', t: BASE_DATE - 1000 * 60 * 60 * 24 }));
        appendGameRecord(data.activity!, rec({ id: 'new', t: BASE_DATE }));
        const plan = await buildAnalysisPlan(data);
        expect(plan.map(j => j.record.id)).toEqual(['new', 'old']);
        expect(plan[0].userLower).toBe('me');
        expect(plan[0].repertoireFens).toBeInstanceOf(Set);
    });

    it('flags debug records when their key is in debugKeys', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'dbg', t: BASE_DATE }));
        const plan = await buildAnalysisPlan(data, new Set(['l:dbg']));
        expect(plan[0].debug).toBe(true);
    });

    it('seeds the start position into each job fen set so move 1 can be graded', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g', t: BASE_DATE }));
        const plan = await buildAnalysisPlan(data);
        expect(plan[0].repertoireFens.has(INITIAL_POSITION_FEN)).toBe(true);
    });

    it('orphans records whose linked account was unlinked', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'orphan', t: BASE_DATE, wa: 'stranger', ba: 'opp' }));
        const plan = await buildAnalysisPlan(data);
        expect(plan).toEqual([]);
    });
});

describe('flushFanUpdates', () => {
    it('writes frozen annotations back to the matching records', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), fan: fanOf([0, 0], 3), skipped: false },
        ];
        const { data: fresh, persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(1);
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.fan).toEqual(fanOf([0, 0], 3));
    });

    it('drops a legacy `an` field when it writes `fan`', async () => {
        const data = makeData();
        const r = rec({ id: 'g1', t: BASE_DATE });
        (r as unknown as Record<string, unknown>).an = { tv: [] }; // legacy field on an old blob
        appendGameRecord(data.activity!, r);
        const dal = new MockDal(data);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), fan: fanOf([0]), skipped: false },
        ];
        const { data: fresh, persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(1);
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.fan).toEqual(fanOf([0]));
        expect((stored as unknown as Record<string, unknown>).an).toBeUndefined();
    });

    it('skips records that were evicted between plan and flush', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'survivor', t: BASE_DATE }));
        const dal = new MockDal(data);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'gone', t: BASE_DATE }), fan: fanOf([7]), skipped: false },
            { record: rec({ id: 'survivor', t: BASE_DATE }), fan: fanOf([0, 0], 3), skipped: false },
        ];
        const { persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(1);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        expect(stored.fan).toEqual(fanOf([0, 0], 3));
    });

    it('does not write anything when all updates are skipped (errors)', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), skipped: true },
        ];
        const { persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(0);
        expect(dal.storeCount).toBe(0);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        expect(stored.fan).toBeUndefined();
    });

    it('prefers the fresh blob value when another tab already wrote fan', async () => {
        const data = makeData();
        const t = BASE_DATE;
        appendGameRecord(data.activity!, rec({ id: 'g1', t, fan: fanOf([1], 2, ['Nf3']) }));
        const dal = new MockDal(data);
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t }), fan: fanOf([0, 0], 3), skipped: false },
        ];
        const { persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(0);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        // Fresh value wins.
        expect(stored.fan).toEqual(fanOf([1], 2, ['Nf3']));
    });

    it('throws on 412 conflict without retry (modal-reload owns recovery)', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        dal.nextStoreError = new DataAccessError('etag mismatch', 412);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), fan: fanOf([0]), skipped: false },
        ];
        await expect(flushFanUpdates(dal, updates))
            .rejects.toMatchObject({ name: 'DataAccessError', statusCode: 412 });
        expect(dal.storeCount).toBe(1); // single attempt, no retry
    });

    it('handles an empty updates array by returning the fresh blob with persisted=0', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const { persisted } = await flushFanUpdates(dal, []);
        expect(persisted).toBe(0);
        expect(dal.storeCount).toBe(0);
    });

    it('back-fills ev additively for a deferred (awaiting-masters) game without overwriting existing evals', async () => {
        const data = makeData();
        const r = rec({ id: 'cc', t: BASE_DATE, p: 'c' });
        r.ev = [10, null]; // existing partial evals
        appendGameRecord(data.activity!, r);
        const dal = new MockDal(data);

        const updates: AnalyzedGameOutcome[] = [
            {
                record: rec({ id: 'cc', t: BASE_DATE, p: 'c' }),
                skipped: true,
                awaitingMasters: true,
                evUpdate: new Map([[0, 88], [1, 99], [3, 55]]),
            },
        ];
        const { persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(1);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        // index 0 keeps its existing 10 (no overwrite); index 1 fills the null;
        // index 3 extends, padding the gap at index 2 with null.
        expect(stored.ev).toEqual([10, 99, null, 55]);
        expect(stored.fan).toBeUndefined();
    });

    it('does not re-write ev (no PUT) when the back-fill changes nothing', async () => {
        const data = makeData();
        const r = rec({ id: 'cc', t: BASE_DATE, p: 'c' });
        r.ev = [null, null, 60]; // already carries the cloud eval from a prior pass
        appendGameRecord(data.activity!, r);
        const dal = new MockDal(data);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'cc', t: BASE_DATE, p: 'c' }), skipped: true, awaitingMasters: true, evUpdate: new Map([[2, 60]]) },
        ];
        const { persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(0);
        expect(dal.storeCount).toBe(0);
    });

    it('does not back-fill ev when the fresh record already has a fan', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE, fan: fanOf([0]) }));
        const dal = new MockDal(data);
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), skipped: true, awaitingMasters: true, evUpdate: new Map([[2, 33]]) },
        ];
        const { persisted } = await flushFanUpdates(dal, updates);
        expect(persisted).toBe(0);
        expect(dal.storeCount).toBe(0);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        expect(stored.ev).toBeUndefined();
    });
});

describe('analyzeOneGame', () => {
    it('freezes a game that never reaches an ambiguous position without any network call (no token)', async () => {
        // Empty repertoire FEN set: every move falls straight to "out of theory",
        // so the masters lookup is never consulted. A token-less game like this
        // freezes normally — no defer, no fetch — regardless of platform.
        const { analyzeOneGame } = await import('./GameRecordAnalysisPass');
        const j: AnalysisJob = {
            record: rec({ id: 'cc1', t: BASE_DATE, p: 'c' }),
            userLower: 'me',
            repertoireFens: new Set<string>(),
        };
        const memo = new Map();
        const noFetch = (() => Promise.reject(new Error('fetch should not be called'))) as unknown as typeof fetch;
        const outcome = await analyzeOneGame(j, null /* no lichess token */, memo, new Map(), null, undefined, noFetch);
        expect(outcome.skipped).toBe(false);
        expect(outcome.awaitingMasters).toBeUndefined();
        expect(outcome.fan).toBeDefined();
        expect(Array.isArray(outcome.fan!.hl)).toBe(true);
    });

    it('freezes a fully in-repertoire Lichess game into all-zero codes', async () => {
        const { analyzeOneGame } = await import('./GameRecordAnalysisPass');
        const fens = buildRepertoireFenSets(makeData().repertoires!);
        const j: AnalysisJob = {
            record: rec({ id: 'l-in', t: BASE_DATE, m: 'e4 e5 Nf3' }),
            userLower: 'me',
            repertoireFens: fens.whiteFens,
        };
        const outcome = await analyzeOneGame(j, null, new Map(), new Map(), null);
        expect(outcome.skipped).toBe(false);
        // User is white: two user moves (e4, Nf3), both in-repertoire -> code 0.
        expect(outcome.fan!.hl).toEqual([0, 0]);
    });
});

describe('persistOpponentAnalysis', () => {
    it('writes op to the matching record', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const op = {
            ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3',
            rb: [], ra: [], at: Date.now(),
        };
        const fresh = await persistOpponentAnalysis(dal, 'g1', 'l', op);
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.op).toEqual(op);
    });

    it('is a silent no-op when the record was evicted', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const op = {
            ply: 4, m: 100, nb: 5, na: 1, os: 'x', us: 'y',
            rb: [], ra: [], at: Date.now(),
        };
        const fresh = await persistOpponentAnalysis(dal, 'gone', 'l', op);
        expect(fresh.activity!.practiceLog).toEqual([]);
        expect(dal.storeCount).toBe(0);
    });
});

describe('persistSuggestion', () => {
    const sgFixture = () => ({
        ply: 6,
        pl: [{ s: 'e4' }, { s: 'e5' }, { s: 'Nf3', n: 1 as const }],
        pgn: '1. e4 e5 2. Nf3',
        rep: 'a3',
        at: Date.now(),
    });

    it('writes sg to the matching record', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const sg = sgFixture();
        const fresh = await persistSuggestion(dal, 'g1', 'l', sg);
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.sg).toEqual(sg);
    });

    it('is a silent no-op when the record was evicted', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const fresh = await persistSuggestion(dal, 'gone', 'l', sgFixture());
        expect(fresh.activity!.practiceLog).toEqual([]);
        expect(dal.storeCount).toBe(0);
    });

    it('throws AbortError when signal is pre-aborted', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const controller = new AbortController();
        controller.abort();
        await expect(persistSuggestion(dal, 'g1', 'l', sgFixture(), controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(dal.storeCount).toBe(0);
    });
});

describe('persistGameReviewed', () => {
    it('sets rv = 1 on the matching record when reviewed', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const fresh = await persistGameReviewed(dal, 'g1', 'l', true);
        expect(fresh.activity!.practiceLog[0].games!.records![0].rv).toBe(1);
    });

    it('deletes rv when un-reviewed', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE, rv: 1 }));
        const dal = new MockDal(data);
        const fresh = await persistGameReviewed(dal, 'g1', 'l', false);
        expect(fresh.activity!.practiceLog[0].games!.records![0].rv).toBeUndefined();
    });

    it('is a silent no-op when the record was evicted', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const fresh = await persistGameReviewed(dal, 'gone', 'l', true);
        expect(fresh.activity!.practiceLog).toEqual([]);
        expect(dal.storeCount).toBe(0);
    });

    it('throws AbortError when signal is pre-aborted', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const controller = new AbortController();
        controller.abort();
        await expect(persistGameReviewed(dal, 'g1', 'l', true, controller.signal))
            .rejects.toThrow();
        expect(dal.storeCount).toBe(0);
    });
});

describe('persistReannotateClear', () => {
    it('clears fan, op, sg, and any legacy an from the matching record', async () => {
        const data = makeData();
        const r = rec({
            id: 'g1', t: BASE_DATE,
            fan: fanOf([0, 0], 3),
            op: { ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3', rb: [], ra: [], at: 0 },
            sg: { ply: 6, pl: [{ s: 'e4' }], pgn: '1. e4', at: 0 },
        });
        (r as unknown as Record<string, unknown>).an = { tv: [{ ply: 4, in: true }] };
        appendGameRecord(data.activity!, r);
        const dal = new MockDal(data);
        const fresh = await persistReannotateClear(dal, 'g1', 'l');
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.fan).toBeUndefined();
        expect(stored.op).toBeUndefined();
        expect(stored.sg).toBeUndefined();
        expect((stored as unknown as Record<string, unknown>).an).toBeUndefined();
    });

    it('is a silent no-op when the record was evicted', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const fresh = await persistReannotateClear(dal, 'gone', 'l');
        expect(fresh.activity!.practiceLog).toEqual([]);
        expect(dal.storeCount).toBe(0);
    });
});

describe('persistReannotateRefresh', () => {
    it('replaces the cached record in place at the same slot and strips fan/op/sg', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({
            id: 'g1', t: BASE_DATE,
            m: 'e4 e5',
            ev: [10, -10],
            fan: fanOf([0], 1),
            op: { ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3', rb: [], ra: [], at: 0 },
        }));
        // Sibling record on a different day should be untouched.
        appendGameRecord(data.activity!, rec({
            id: 'g2', t: BASE_DATE + 86_400_000,
            fan: fanOf([0, 0]),
        }));
        const dal = new MockDal(data);
        const refreshed = rec({
            id: 'g1', t: BASE_DATE,
            m: 'e4 e5 Nf3 Nc6',
            ev: [10, -10, 15, -5],
            // Carry a `fan`/`op`/`sg` to prove the helper strips them.
            fan: fanOf([0, 0]),
            op: { ply: 2, m: 0, nb: 0, na: 0, os: '', us: '', rb: [], ra: [], at: 1 },
            sg: { ply: 2, pl: [{ s: 'e4' }], pgn: '1. e4', at: 1 },
        });
        const fresh = await persistReannotateRefresh(dal, refreshed);
        const entry = fresh.activity!.practiceLog.find(e =>
            e.games?.records?.some(r => r.id === 'g1'),
        );
        const stored = entry!.games!.records!.find(r => r.id === 'g1')!;
        expect(stored.m).toBe('e4 e5 Nf3 Nc6');
        expect(stored.ev).toEqual([10, -10, 15, -5]);
        expect(stored.fan).toBeUndefined();
        expect(stored.op).toBeUndefined();
        expect(stored.sg).toBeUndefined();
        // Sibling untouched.
        const g2 = fresh.activity!.practiceLog
            .flatMap(e => e.games?.records ?? [])
            .find(r => r.id === 'g2');
        expect(g2?.fan).toEqual(fanOf([0, 0]));
    });

    it('is a silent no-op when the record was evicted', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const refreshed = rec({ id: 'gone', t: BASE_DATE });
        const fresh = await persistReannotateRefresh(dal, refreshed);
        expect(fresh.activity!.practiceLog).toEqual([]);
        expect(dal.storeCount).toBe(0);
    });

    it('throws on 412 conflict without retry (modal-reload owns recovery)', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({
            id: 'g1', t: BASE_DATE,
            m: 'e4',
            fan: fanOf([0]),
        }));
        const dal = new MockDal(data);
        dal.nextStoreError = new DataAccessError('etag conflict', 412);
        const refreshed = rec({ id: 'g1', t: BASE_DATE, m: 'e4 e5' });
        await expect(persistReannotateRefresh(dal, refreshed))
            .rejects.toMatchObject({ name: 'DataAccessError', statusCode: 412 });
        expect(dal.storeCount).toBe(1);
    });
});

describe('AbortSignal support', () => {
    it('flushFanUpdates throws AbortError when signal is pre-aborted', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const controller = new AbortController();
        controller.abort();
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), fan: fanOf([0]), skipped: false },
        ];
        await expect(flushFanUpdates(dal, updates, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(dal.storeCount).toBe(0);
    });

    it('persistOpponentAnalysis throws AbortError when signal is pre-aborted', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const controller = new AbortController();
        controller.abort();
        const op = {
            ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3',
            rb: [], ra: [], at: Date.now(),
        };
        await expect(persistOpponentAnalysis(dal, 'g1', 'l', op, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(dal.storeCount).toBe(0);
    });

    it('persistReannotateClear throws AbortError when signal is pre-aborted', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE, fan: fanOf([0]) }));
        const dal = new MockDal(data);
        const controller = new AbortController();
        controller.abort();
        await expect(persistReannotateClear(dal, 'g1', 'l', controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(dal.storeCount).toBe(0);
    });

    it('persistReannotateRefresh throws AbortError when signal is pre-aborted', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const controller = new AbortController();
        controller.abort();
        const refreshed = rec({ id: 'g1', t: BASE_DATE, m: 'e4 e5' });
        await expect(persistReannotateRefresh(dal, refreshed, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(dal.storeCount).toBe(0);
    });
});

describe('analyzeOneGame — cloud-eval gap fill', () => {
    // Fake timers so the cloud-eval throttle resolves instantly. Drive the
    // analysis to completion with `runAnalysis`, which flushes pending timers.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** Replay SAN moves, returning the full FEN after each move (index 0 = start). */
    function replayFens(sans: string[]): string[] {
        const c = new Chess();
        const fens = [c.fen()];
        for (const san of sans) {
            c.move(san);
            fens.push(c.fen());
        }
        return fens;
    }

    function compact(fen: string): string {
        return fen.split(' ').slice(0, 3).join(' ');
    }

    function whiteFensFor(pgn: string): Set<string> {
        return buildRepertoireFenSets(pgnToRepertoires([{ pgn, orientation: 'white' }])).whiteFens;
    }

    /**
     * A fetch mock that dispatches by URL: cloud-eval queries resolve to the cp
     * mapped for the queried full FEN (a `null`/absent entry → 404 miss), and
     * masters queries return an empty position. Tracks per-endpoint call counts.
     */
    function makeFetch(cloudByFen: Map<string, number | null>) {
        const calls = { cloud: 0, masters: 0 };
        const fn = vi.fn(async (url: string) => {
            if (url.includes('cloud-eval')) {
                calls.cloud++;
                const fen = decodeURIComponent(url.split('fen=')[1].split('&')[0]);
                const cp = cloudByFen.get(fen);
                if (cp === undefined || cp === null) return { ok: false, status: 404 };
                return { ok: true, json: async () => ({ pvs: [{ moves: 'e2e4', cp, mate: null }], depth: 30, knodes: 1 }) };
            }
            if (url.includes('masters')) {
                calls.masters++;
                return { ok: true, json: async () => ({ moves: [] }) };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        return { fn: fn as unknown as typeof fetch, calls };
    }

    async function runAnalysis(job: AnalysisJob, evals: ExplorerEvals, fetchFn: typeof fetch, token: string | null = 'tok') {
        const p = analyzeOneGame(job, token, new Map(), new Map(), evals, undefined, fetchFn);
        await vi.runAllTimersAsync();
        return p;
    }

    it('fills the one missing position from cloud and colors the user move a blunder', async () => {
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3']);
        const evals = ExplorerEvals.fromRecord({
            [compact(fens[3])]: [50],
            [compact(fens[4])]: [50],
            [compact(fens[5])]: [45],
            [compact(fens[6])]: [40],
            // fens[7] (after the blunder Nc3) absent → the lone cloud gap
        });
        const { fn, calls } = makeFetch(new Map([[fens[7], -30]]));
        const job: AnalysisJob = {
            record: rec({ id: 'cg1', t: BASE_DATE, m: 'e4 e5 Nf3 d6 d4 Nf6 Nc3' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        const outcome = await runAnalysis(job, evals, fn);
        expect(outcome.skipped).toBe(false);
        expect(calls.cloud).toBe(1);   // exactly one cloud call — the single gap
        expect(calls.masters).toBe(0); // no ambiguous opponent moves
        // e4, Nf3 in-rep (0); d4 ok response (2); Nc3 blunder (5).
        expect(outcome.fan!.hl).toEqual([0, 0, 2, 5]);
    });

    it('a decisive cloud eval (>= 45cp) classifies the opponent out of theory without a masters call', async () => {
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'g5']);
        const evals = ExplorerEvals.fromRecord({
            [compact(fens[5])]: [30], // after Bb5 (before the opponent's g5)
            // fens[6] (after g5) absent → cloud gap
        });
        const { fn, calls } = makeFetch(new Map([[fens[6], 120]])); // black drop = 120-30 = 90 → out of theory
        const job: AnalysisJob = {
            record: rec({ id: 'cg2', t: BASE_DATE, m: 'e4 e5 Nf3 Nc6 Bb5 g5' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        const outcome = await runAnalysis(job, evals, fn);
        expect(outcome.skipped).toBe(false);
        expect(calls.cloud).toBe(1);
        expect(calls.masters).toBe(0); // cloud was decisive → masters skipped
        // Only the three in-repertoire user moves before theory ended.
        expect(outcome.fan!.hl).toEqual([0, 0, 0]);
    });

    it('a cloud miss leaves the move uncolored and still freezes the game (not skipped)', async () => {
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3']);
        const evals = ExplorerEvals.fromRecord({
            [compact(fens[3])]: [50],
            [compact(fens[4])]: [50],
            [compact(fens[5])]: [45],
            [compact(fens[6])]: [40],
        });
        // Lichess has no eval for the gap (404).
        const { fn, calls } = makeFetch(new Map([[fens[7], null]]));
        const job: AnalysisJob = {
            record: rec({ id: 'cg3', t: BASE_DATE, m: 'e4 e5 Nf3 d6 d4 Nf6 Nc3' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        const outcome = await runAnalysis(job, evals, fn);
        expect(outcome.skipped).toBe(false);
        expect(calls.cloud).toBe(1);
        // Nc3 stays code 2 (out-of-repertoire-response, no eval) — today's behavior.
        expect(outcome.fan!.hl).toEqual([0, 0, 2, 2]);
    });

    it('stops fetching once a decisive boundary eval closes the window (lazy fill)', async () => {
        // Opponent leaves the repertoire at ply 5 with a blunder, then the game
        // runs on for several more off-book plies. An eager "collect all gaps,
        // then fetch" would query every position in the window; lazy fill fetches
        // only the boundary, sees it's decisive (out of theory), and stops.
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Qh4', 'Nxh4', 'd6', 'd4', 'Nf6']);
        const evals = ExplorerEvals.fromRecord({
            [compact(fens[5])]: [30], // after Bb5 (before the blunder Qh4)
            // fens[6..10] (the whole post-blunder tail) absent
        });
        // Only the boundary position is mapped; the tail would 404 if fetched.
        const { fn, calls } = makeFetch(new Map([[fens[6], 900]])); // black drop = 870 → out of theory
        const job: AnalysisJob = {
            record: rec({ id: 'cg4', t: BASE_DATE, m: 'e4 e5 Nf3 Nc6 Bb5 Qh4 Nxh4 d6 d4 Nf6' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        const outcome = await runAnalysis(job, evals, fn);
        expect(outcome.skipped).toBe(false);
        expect(calls.cloud).toBe(1); // boundary only — the settled tail is never fetched
        // e4, Nf3, Bb5 in-rep (0); Nxh4, d4 after theory ended → out-of-theory (7).
        expect(outcome.fan!.hl).toEqual([0, 0, 0, 7, 7]);
    });

    it('defers a game that reaches an ambiguous opponent move with no token, persisting the cloud evals it gathered', async () => {
        // Opponent leaves the repertoire at ply 5 with a drop in the 15–44 band,
        // so the walk needs a masters verdict. With no token connected, the game
        // is deferred (not frozen) and the cloud eval it back-filled is handed
        // back keyed by ply so the re-run after a Lichess connect needn't refetch.
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
        const evals = ExplorerEvals.fromRecord({
            [compact(fens[5])]: [30], // after Bb5 (before the opponent's a6)
            // fens[6] (after a6) absent → cloud gap; cloud says 60 → drop = 30 (ambiguous)
        });
        const { fn, calls } = makeFetch(new Map([[fens[6], 60]]));
        const job: AnalysisJob = {
            record: rec({ id: 'cg5', t: BASE_DATE, m: 'e4 e5 Nf3 Nc6 Bb5 a6' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        const outcome = await runAnalysis(job, evals, fn, null /* no token */);
        expect(outcome.skipped).toBe(true);
        expect(outcome.awaitingMasters).toBe(true);
        expect(outcome.fan).toBeUndefined();
        expect(calls.cloud).toBe(1);
        expect(calls.masters).toBe(0); // AwaitingMastersLookup throws before any fetch
        // The cloud hit for the opponent's after-position (ply 5) was recorded.
        expect(outcome.evUpdate?.get(5)).toBe(60);
    });

    it('defers a game when the Lichess cloud-eval API throttles (429) instead of freezing a less-informed verdict', async () => {
        // The opponent leaves the repertoire at ply 5; resolving that boundary
        // needs a cloud eval, but Lichess rate-limits us (429). The throttle must
        // NOT be mistaken for a "no eval" miss (which would end theory and freeze
        // the game) — instead the game is deferred so a later pass retries.
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
        const evals = ExplorerEvals.fromRecord({
            [compact(fens[5])]: [30], // after Bb5 (before the opponent's a6)
            // fens[6] (after a6) is a cloud gap that Lichess rate-limits.
        });
        const calls = { cloud: 0, masters: 0 };
        const fn = vi.fn(async (url: string) => {
            if (url.includes('cloud-eval')) {
                calls.cloud++;
                return { ok: false, status: 429 };
            }
            if (url.includes('masters')) {
                calls.masters++;
                return { ok: true, json: async () => ({ moves: [] }) };
            }
            throw new Error(`unexpected url: ${url}`);
        }) as unknown as typeof fetch;
        const job: AnalysisJob = {
            record: rec({ id: 'ct1', t: BASE_DATE, m: 'e4 e5 Nf3 Nc6 Bb5 a6' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        // A token is connected — this is the cloud-throttle path, not the
        // no-token masters-defer path.
        const outcome = await runAnalysis(job, evals, fn, 'tok');
        expect(outcome.skipped).toBe(true);
        expect(outcome.awaitingCloudEval).toBe(true);
        expect(outcome.awaitingMasters).toBeUndefined();
        expect(outcome.fan).toBeUndefined();
        expect(calls.cloud).toBe(1);   // throttled on the boundary gap
        expect(calls.masters).toBe(0); // throttle threw before the masters check
        // The pass still hands back the (empty) cloud-eval sink to persist.
        expect(outcome.evUpdate).toBeInstanceOf(Map);
    });

    it('latches the whole pass after the first 429 — later cloud-needing games defer without re-hitting the API', async () => {
        // Two games in one pass both reach a boundary that needs a cloud eval,
        // at *distinct* FENs (after a6 vs after Nf6) so the per-FEN memo can't
        // dedup them. The first 429 latches the shared throttle, so the second
        // game must defer WITHOUT making its own cloud request.
        const whiteFens = whiteFensFor('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const afterBb5 = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])[5];
        const evals = ExplorerEvals.fromRecord({
            [compact(afterBb5)]: [30], // before each opponent's book-leaving move
        });
        const calls = { cloud: 0, masters: 0 };
        const fn = vi.fn(async (url: string) => {
            if (url.includes('cloud-eval')) {
                calls.cloud++;
                return { ok: false, status: 429 };
            }
            if (url.includes('masters')) {
                calls.masters++;
                return { ok: true, json: async () => ({ moves: [] }) };
            }
            throw new Error(`unexpected url: ${url}`);
        }) as unknown as typeof fetch;

        const memo = new Map();
        const cloudMemo = new Map();
        const throttle = { throttled: false };

        const job1: AnalysisJob = {
            record: rec({ id: 'g1', t: BASE_DATE, m: 'e4 e5 Nf3 Nc6 Bb5 a6' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };
        const job2: AnalysisJob = {
            record: rec({ id: 'g2', t: BASE_DATE, m: 'e4 e5 Nf3 Nc6 Bb5 Nf6' }),
            userLower: 'me',
            repertoireFens: whiteFens,
        };

        const p1 = analyzeOneGame(job1, 'tok', memo, cloudMemo, evals, undefined, fn, throttle);
        await vi.runAllTimersAsync();
        const o1 = await p1;

        const p2 = analyzeOneGame(job2, 'tok', memo, cloudMemo, evals, undefined, fn, throttle);
        await vi.runAllTimersAsync();
        const o2 = await p2;

        expect(o1.awaitingCloudEval).toBe(true);
        expect(o2.awaitingCloudEval).toBe(true);
        expect(throttle.throttled).toBe(true);
        // Exactly one cloud request total: the second game short-circuited on the
        // latch instead of re-hitting the rate-limited API.
        expect(calls.cloud).toBe(1);
    });
});
