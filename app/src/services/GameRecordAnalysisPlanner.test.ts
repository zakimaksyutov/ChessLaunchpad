import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    fetchMastersWithMemo,
    fetchCloudWithMemo,
    MastersMemoEntry,
    planAmbiguousPositions,
} from './GameRecordAnalysisPlanner';
import { GameRecord } from '../models/RepertoireData';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';

function makeRecord(opts: Partial<GameRecord> & { m: string }): GameRecord {
    return {
        id: 'r1',
        p: 'l',
        t: Date.now(),
        wa: 'me',
        ba: 'opp',
        res: 'draw',
        rt: 1,
        ...opts,
    };
}

describe('fetchMastersWithMemo', () => {
    it('caches successful results across calls', async () => {
        const memo = new Map<string, MastersMemoEntry>();
        const mockFetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ moves: [{ san: 'e4', white: 100, draws: 100, black: 100 }] }),
        })) as unknown as typeof fetch;
        const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const first = await fetchMastersWithMemo(fen, 'tok', memo, undefined, mockFetch);
        const second = await fetchMastersWithMemo(fen, 'tok', memo, undefined, mockFetch);
        expect(first.kind).toBe('ok');
        expect(second.kind).toBe('ok');
        expect(mockFetch).toHaveBeenCalledOnce(); // memoized
    });

    it('caches and surfaces error outcomes (does not retry on the same pass)', async () => {
        const memo = new Map<string, MastersMemoEntry>();
        const mockFetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 })) as unknown as typeof fetch;
        const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const a = await fetchMastersWithMemo(fen, 'tok', memo, undefined, mockFetch);
        const b = await fetchMastersWithMemo(fen, 'tok', memo, undefined, mockFetch);
        expect(a.kind).toBe('error');
        expect(b.kind).toBe('error');
        expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('returns error and does not fetch when signal is pre-aborted', async () => {
        const memo = new Map<string, MastersMemoEntry>();
        const ctrl = new AbortController();
        ctrl.abort();
        const mockFetch = vi.fn() as unknown as typeof fetch;
        const out = await fetchMastersWithMemo('any', 'tok', memo, ctrl.signal, mockFetch);
        expect(out.kind).toBe('error');
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('fetchCloudWithMemo', () => {
    // Fake timers so the cloud-eval throttle resolves instantly.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    async function run<T>(p: Promise<T>): Promise<T> {
        await vi.runAllTimersAsync();
        return p;
    }

    function okCp(cp: number) {
        return vi.fn(async () => ({
            ok: true,
            json: async () => ({ pvs: [{ moves: 'e2e4', cp, mate: null }], depth: 30, knodes: 1 }),
        })) as unknown as typeof fetch;
    }

    it('memoizes a successful cp across calls (one network hit per pass)', async () => {
        const memo = new Map<string, number | null>();
        const fetchFn = okCp(42);
        const first = await run(fetchCloudWithMemo(fen, memo, undefined, fetchFn));
        const second = await run(fetchCloudWithMemo(fen, memo, undefined, fetchFn));
        expect(first).toBe(42);
        expect(second).toBe(42);
        expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('memoizes a miss (null) so it is not re-fetched within the pass', async () => {
        const memo = new Map<string, number | null>();
        const fetchFn = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
        const a = await run(fetchCloudWithMemo(fen, memo, undefined, fetchFn));
        const b = await run(fetchCloudWithMemo(fen, memo, undefined, fetchFn));
        expect(a).toBeNull();
        expect(b).toBeNull();
        expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('returns null and does not fetch when the signal is pre-aborted', async () => {
        const memo = new Map<string, number | null>();
        const ctrl = new AbortController();
        ctrl.abort();
        const fetchFn = vi.fn() as unknown as typeof fetch;
        const out = await run(fetchCloudWithMemo(fen, memo, ctrl.signal, fetchFn));
        expect(out).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe('planAmbiguousPositions', () => {
    it('returns an empty plan for a fully in-repertoire game', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const rec = makeRecord({ m: 'e4 e5 Nf3' });
        // Note: planAmbiguousPositions runs against the user's color implied by record.wa.
        const plan = await planAmbiguousPositions(rec, 'me', fens.whiteFens, null);
        expect(plan).toEqual([]);
    });

    // Plans for games leaving the repertoire are exercised by GameAnnotationService.test
    // (this planner delegates to annotateRecord); a smoke test here is sufficient.
});
