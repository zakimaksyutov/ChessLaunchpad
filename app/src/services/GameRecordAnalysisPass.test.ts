import { describe, it, expect } from 'vitest';
import {
    AnalysisJob,
    AnalyzedGameOutcome,
    buildAnalysisPlan,
    filterRunnableJobs,
    flushFanUpdates,
    persistOpponentAnalysis,
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
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
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

/** A bare AnalysisJob carrier for the filter/analyze tests. */
function job(record: GameRecord, plan: AnalysisJob['plan']): AnalysisJob {
    return { record, userLower: 'me', repertoireFens: new Set<string>(), plan };
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
    it('returns an empty plan when there are no records', () => {
        const data = makeData();
        const plan = buildAnalysisPlan(data, null);
        expect(plan).toEqual([]);
    });

    it('skips records that already have fan', () => {
        const data = makeData();
        const r = rec({ id: 'done', t: BASE_DATE, fan: fanOf([0, 0]) });
        appendGameRecord(data.activity!, r);
        const plan = buildAnalysisPlan(data, null);
        expect(plan).toEqual([]);
    });

    it('includes records lacking fan, sorted oldest-first, with owner + fens attached', () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'old', t: BASE_DATE - 1000 * 60 * 60 * 24 }));
        appendGameRecord(data.activity!, rec({ id: 'new', t: BASE_DATE }));
        const plan = buildAnalysisPlan(data, null);
        expect(plan.map(j => j.record.id)).toEqual(['old', 'new']);
        expect(plan[0].userLower).toBe('me');
        expect(plan[0].repertoireFens).toBeInstanceOf(Set);
    });

    it('flags debug records when their key is in debugKeys', () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'dbg', t: BASE_DATE }));
        const plan = buildAnalysisPlan(data, null, new Set(['l:dbg']));
        expect(plan[0].debug).toBe(true);
    });

    it('orphans records whose linked account was unlinked', () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'orphan', t: BASE_DATE, wa: 'stranger', ba: 'opp' }));
        const plan = buildAnalysisPlan(data, null);
        expect(plan).toEqual([]);
    });
});

describe('filterRunnableJobs', () => {
    it('runs Chess.com games regardless of Lichess connection', () => {
        const j = job(rec({ id: 'cc', t: BASE_DATE, p: 'c' as const }), [{ moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' }]);
        const { runnable, blockedByLichess } = filterRunnableJobs([j], false);
        expect(runnable).toEqual([j]);
        expect(blockedByLichess).toEqual([]);
    });

    it('runs Lichess sync-only games (K=0) regardless of connection', () => {
        const j = job(rec({ id: 'l1', t: BASE_DATE }), []);
        const { runnable, blockedByLichess } = filterRunnableJobs([j], false);
        expect(runnable).toEqual([j]);
        expect(blockedByLichess).toEqual([]);
    });

    it('blocks Lichess K>0 games when disconnected', () => {
        const j = job(rec({ id: 'l1', t: BASE_DATE }), [{ moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' }]);
        const { runnable, blockedByLichess } = filterRunnableJobs([j], false);
        expect(runnable).toEqual([]);
        expect(blockedByLichess).toEqual([j]);
    });

    it('runs Lichess K>0 games when connected', () => {
        const j = job(rec({ id: 'l1', t: BASE_DATE }), [{ moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' }]);
        const { runnable, blockedByLichess } = filterRunnableJobs([j], true);
        expect(runnable).toEqual([j]);
        expect(blockedByLichess).toEqual([]);
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
});

describe('analyzeOneGame', () => {
    it('produces a frozen annotation for Chess.com records without touching masters (even with ambiguous plan + no token)', async () => {
        const { analyzeOneGame } = await import('./GameRecordAnalysisPass');
        const j: AnalysisJob = {
            record: rec({ id: 'cc1', t: BASE_DATE, p: 'c' }),
            userLower: 'me',
            repertoireFens: new Set<string>(),
            // Chess.com can land in the ambiguous zone via ExplorerEvals; the
            // masters loop must be bypassed entirely for p='c'.
            plan: [
                { moveIndex: 0, plyIndex: 4, fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moveSan: 'a3' },
            ],
        };
        const memo = new Map();
        const noFetch = (() => Promise.reject(new Error('fetch should not be called for chess.com records'))) as unknown as typeof fetch;
        const outcome = await analyzeOneGame(j, null /* no lichess token */, memo, null, undefined, noFetch);
        expect(outcome.skipped).toBe(false);
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
            plan: [],
        };
        const outcome = await analyzeOneGame(j, null, new Map(), null);
        expect(outcome.skipped).toBe(false);
        // User is white: two user moves (e4, Nf3), both in-repertoire -> code 0.
        expect(outcome.fan!.hl).toEqual([0, 0]);
    });

    it('still skips Lichess K>0 games without a token (filter is defense-in-depth)', async () => {
        const { analyzeOneGame } = await import('./GameRecordAnalysisPass');
        const j: AnalysisJob = {
            record: rec({ id: 'l1', t: BASE_DATE }),
            userLower: 'me',
            repertoireFens: new Set<string>(),
            plan: [
                { moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' },
            ],
        };
        const memo = new Map();
        const noFetch = (() => Promise.reject(new Error('should not fetch without token'))) as unknown as typeof fetch;
        const outcome = await analyzeOneGame(j, null, memo, null, undefined, noFetch);
        expect(outcome.skipped).toBe(true);
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

describe('persistReannotateClear', () => {
    it('clears fan, op, and any legacy an from the matching record', async () => {
        const data = makeData();
        const r = rec({
            id: 'g1', t: BASE_DATE,
            fan: fanOf([0, 0], 3),
            op: { ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3', rb: [], ra: [], at: 0 },
        });
        (r as unknown as Record<string, unknown>).an = { tv: [{ ply: 4, in: true }] };
        appendGameRecord(data.activity!, r);
        const dal = new MockDal(data);
        const fresh = await persistReannotateClear(dal, 'g1', 'l');
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.fan).toBeUndefined();
        expect(stored.op).toBeUndefined();
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
    it('replaces the cached record in place at the same slot and strips fan/op', async () => {
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
            // Carry a `fan`/`op` to prove the helper strips them.
            fan: fanOf([0, 0]),
            op: { ply: 2, m: 0, nb: 0, na: 0, os: '', us: '', rb: [], ra: [], at: 1 },
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
