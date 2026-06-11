import { describe, it, expect, vi } from 'vitest';
import {
    AnalysisJob,
    AnalyzedGameOutcome,
    buildAnalysisPlan,
    filterRunnableJobs,
    flushAnUpdates,
    persistOpponentAnalysis,
    persistReannotateClear,
    persistReannotateRefresh,
} from './GameRecordAnalysisPass';
import {
    GameRecord,
    RepertoireData,
} from '../models/RepertoireData';
import { IDataAccessLayer, DataAccessError } from '../data/DataAccessLayer';
import { appendGameRecord } from './GameRecordStore';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';
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
    async fetchEtagOnly() { this.retrieveCount += 1; }
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

    it('skips records that already have an', () => {
        const data = makeData();
        const r = rec({ id: 'done', t: BASE_DATE, an: { tv: [] } });
        appendGameRecord(data.activity!, r);
        const plan = buildAnalysisPlan(data, null);
        expect(plan).toEqual([]);
    });

    it('includes records lacking an, sorted newest-first', () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'old', t: BASE_DATE - 1000 * 60 * 60 * 24 }));
        appendGameRecord(data.activity!, rec({ id: 'new', t: BASE_DATE }));
        const plan = buildAnalysisPlan(data, null);
        expect(plan.map(j => j.record.id)).toEqual(['new', 'old']);
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
        const job = {
            record: rec({ id: 'cc', t: BASE_DATE, p: 'c' as const }),
            accountKey: 'chess.com:me',
            userLower: 'me',
            plan: [{ moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' }],
        };
        const { runnable, blockedByLichess } = filterRunnableJobs([job], false);
        expect(runnable).toEqual([job]);
        expect(blockedByLichess).toEqual([]);
    });

    it('runs Lichess sync-only games (K=0) regardless of connection', () => {
        const job = {
            record: rec({ id: 'l1', t: BASE_DATE }),
            accountKey: 'lichess:me',
            userLower: 'me',
            plan: [],
        };
        const { runnable, blockedByLichess } = filterRunnableJobs([job], false);
        expect(runnable).toEqual([job]);
        expect(blockedByLichess).toEqual([]);
    });

    it('blocks Lichess K>0 games when disconnected', () => {
        const job = {
            record: rec({ id: 'l1', t: BASE_DATE }),
            accountKey: 'lichess:me',
            userLower: 'me',
            plan: [{ moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' }],
        };
        const { runnable, blockedByLichess } = filterRunnableJobs([job], false);
        expect(runnable).toEqual([]);
        expect(blockedByLichess).toEqual([job]);
    });

    it('runs Lichess K>0 games when connected', () => {
        const job = {
            record: rec({ id: 'l1', t: BASE_DATE }),
            accountKey: 'lichess:me',
            userLower: 'me',
            plan: [{ moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' }],
        };
        const { runnable, blockedByLichess } = filterRunnableJobs([job], true);
        expect(runnable).toEqual([job]);
        expect(blockedByLichess).toEqual([]);
    });
});

describe('flushAnUpdates', () => {
    it('writes verdicts back to the matching records', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), an: { tv: [{ ply: 4, in: true }] }, skipped: false },
        ];
        const { data: fresh, persisted } = await flushAnUpdates(dal, updates);
        expect(persisted).toBe(1);
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.an).toEqual({ tv: [{ ply: 4, in: true }] });
    });

    it('skips records that were evicted between plan and flush', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'survivor', t: BASE_DATE }));
        const dal = new MockDal(data);

        // Pretend we planned a verdict for a record that's no longer there.
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'gone', t: BASE_DATE }), an: { tv: [] }, skipped: false },
            { record: rec({ id: 'survivor', t: BASE_DATE }), an: { tv: [{ ply: 4, in: false }] }, skipped: false },
        ];
        const { persisted } = await flushAnUpdates(dal, updates);
        expect(persisted).toBe(1);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        expect(stored.an).toEqual({ tv: [{ ply: 4, in: false }] });
    });

    it('does not write anything when all updates are skipped (errors)', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), skipped: true },
        ];
        const { persisted } = await flushAnUpdates(dal, updates);
        expect(persisted).toBe(0);
        expect(dal.storeCount).toBe(0);
        // Record's an should still be undefined (no write).
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        expect(stored.an).toBeUndefined();
    });

    it('prefers the fresh blob value when another tab already wrote an', async () => {
        const data = makeData();
        const t = BASE_DATE;
        appendGameRecord(data.activity!, rec({ id: 'g1', t, an: { tv: [{ ply: 4, in: false }] } }));
        const dal = new MockDal(data);
        // Try to overwrite with a different verdict.
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t }), an: { tv: [{ ply: 4, in: true }] }, skipped: false },
        ];
        const { persisted } = await flushAnUpdates(dal, updates);
        expect(persisted).toBe(0);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        // Fresh value wins.
        expect(stored.an).toEqual({ tv: [{ ply: 4, in: false }] });
    });

    it('defers to fresh-blob empty-tv an (sync-only done state) — concurrent-tab race protection', async () => {
        // An empty `tv` is a legitimate "done analyzed" stamp (sync-only
        // game or all-no-data). A stale tab that started analyzing this
        // game before another tab landed `an: {}` must not clobber it.
        // (Re-annotate deletes `an` outright, bypassing this conflict.)
        const data = makeData();
        const t = BASE_DATE;
        appendGameRecord(data.activity!, rec({ id: 'g1', t, an: { tv: [] } }));
        const dal = new MockDal(data);
        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t }), an: { tv: [{ ply: 4, in: true }] }, skipped: false },
        ];
        const { persisted } = await flushAnUpdates(dal, updates);
        expect(persisted).toBe(0);
        const stored = dal.data.activity!.practiceLog[0].games!.records![0];
        expect(stored.an).toEqual({ tv: [] });
    });

    it('retries on 412 conflict and succeeds on retry', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({ id: 'g1', t: BASE_DATE }));
        const dal = new MockDal(data);
        dal.nextStoreError = new DataAccessError('etag mismatch', 412);

        const updates: AnalyzedGameOutcome[] = [
            { record: rec({ id: 'g1', t: BASE_DATE }), an: { tv: [{ ply: 4, in: true }] }, skipped: false },
        ];
        // Silence the expected "412 retry" warning.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { persisted } = await flushAnUpdates(dal, updates);
            expect(persisted).toBe(1);
            expect(dal.storeCount).toBe(2); // first attempt 412'd, second succeeded
        } finally {
            warn.mockRestore();
        }
    });

    it('handles an empty updates array by returning the fresh blob with persisted=0', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const { persisted } = await flushAnUpdates(dal, []);
        expect(persisted).toBe(0);
        expect(dal.storeCount).toBe(0);
    });
});

describe('analyzeOneGame — Chess.com short-circuit (review feedback)', () => {
    it('writes an: {} immediately for Chess.com records, even when the planner produced ambiguous positions and Lichess is disconnected', async () => {
        const { analyzeOneGame } = await import('./GameRecordAnalysisPass');
        const job: AnalysisJob = {
            record: rec({ id: 'cc1', t: BASE_DATE, p: 'c' }),
            accountKey: 'chess.com:me',
            userLower: 'me',
            // Chess.com can land in the ambiguous zone via ExplorerEvals
            // (fenBefore has evals, fenAfter doesn't → engine flags ambiguous).
            // The short-circuit must bypass the masters loop entirely.
            plan: [
                { moveIndex: 0, plyIndex: 4, fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moveSan: 'a3' },
            ],
        };
        const memo = new Map();
        const noFetch = (() => Promise.reject(new Error('fetch should not be called for chess.com records'))) as unknown as typeof fetch;
        const outcome = await analyzeOneGame(job, null /* no lichess token */, memo, () => {}, undefined, noFetch);
        expect(outcome.skipped).toBe(false);
        expect(outcome.an).toEqual({});
    });

    it('still skips Lichess K>0 games without a token (filter is defense-in-depth)', async () => {
        const { analyzeOneGame } = await import('./GameRecordAnalysisPass');
        const job: AnalysisJob = {
            record: rec({ id: 'l1', t: BASE_DATE }),
            accountKey: 'lichess:me',
            userLower: 'me',
            plan: [
                { moveIndex: 0, plyIndex: 4, fenBefore: 'x', moveSan: 'a3' },
            ],
        };
        const memo = new Map();
        const noFetch = (() => Promise.reject(new Error('should not fetch without token'))) as unknown as typeof fetch;
        const outcome = await analyzeOneGame(job, null, memo, () => {}, undefined, noFetch);
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
    it('clears an and op from the matching record', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({
            id: 'g1', t: BASE_DATE,
            an: { tv: [{ ply: 4, in: true }] },
            op: { ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3', rb: [], ra: [], at: 0 },
        }));
        const dal = new MockDal(data);
        const fresh = await persistReannotateClear(dal, 'g1', 'l');
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.an).toBeUndefined();
        expect(stored.op).toBeUndefined();
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
    it('replaces the cached record in place at the same slot and strips an/op', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({
            id: 'g1', t: BASE_DATE,
            m: 'e4 e5',
            ev: [10, -10],
            an: { tv: [{ ply: 4, in: true }] },
            op: { ply: 4, m: 100, nb: 5, na: 1, os: 'Nf3', us: 'a3', rb: [], ra: [], at: 0 },
        }));
        // Sibling record on a different day should be untouched.
        appendGameRecord(data.activity!, rec({
            id: 'g2', t: BASE_DATE + 86_400_000,
            an: { tv: [] },
        }));
        const dal = new MockDal(data);
        const refreshed = rec({
            id: 'g1', t: BASE_DATE,
            m: 'e4 e5 Nf3 Nc6',
            ev: [10, -10, 15, -5],
            // Carry an `an`/`op` to prove the helper strips them.
            an: { tv: [{ ply: 2, in: true }] },
            op: { ply: 2, m: 0, nb: 0, na: 0, os: '', us: '', rb: [], ra: [], at: 1 },
        });
        const fresh = await persistReannotateRefresh(dal, refreshed);
        const entry = fresh.activity!.practiceLog.find(e =>
            e.games?.records?.some(r => r.id === 'g1'),
        );
        const stored = entry!.games!.records!.find(r => r.id === 'g1')!;
        expect(stored.m).toBe('e4 e5 Nf3 Nc6');
        expect(stored.ev).toEqual([10, -10, 15, -5]);
        expect(stored.an).toBeUndefined();
        expect(stored.op).toBeUndefined();
        // Sibling untouched.
        const g2 = fresh.activity!.practiceLog
            .flatMap(e => e.games?.records ?? [])
            .find(r => r.id === 'g2');
        expect(g2?.an).toEqual({ tv: [] });
    });

    it('is a silent no-op when the record was evicted', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const refreshed = rec({ id: 'gone', t: BASE_DATE });
        const fresh = await persistReannotateRefresh(dal, refreshed);
        expect(fresh.activity!.practiceLog).toEqual([]);
        expect(dal.storeCount).toBe(0);
    });

    it('retries on a 412 conflict and ultimately persists the replacement', async () => {
        const data = makeData();
        appendGameRecord(data.activity!, rec({
            id: 'g1', t: BASE_DATE,
            m: 'e4',
            an: { tv: [] },
        }));
        const dal = new MockDal(data);
        dal.nextStoreError = new DataAccessError('etag conflict', 412);
        const refreshed = rec({ id: 'g1', t: BASE_DATE, m: 'e4 e5' });
        const fresh = await persistReannotateRefresh(dal, refreshed);
        const stored = fresh.activity!.practiceLog[0].games!.records![0];
        expect(stored.m).toBe('e4 e5');
        expect(stored.an).toBeUndefined();
        expect(dal.storeCount).toBe(2);
    });
});
