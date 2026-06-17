import { describe, it, expect, vi } from 'vitest';
import {
    fetchMastersWithMemo,
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

describe('planAmbiguousPositions', () => {
    it('returns an empty plan for a fully in-repertoire game', () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const rec = makeRecord({ m: 'e4 e5 Nf3' });
        // Note: planAmbiguousPositions runs against the user's color implied by record.wa.
        const plan = planAmbiguousPositions(rec, 'me', fens.whiteFens, null);
        expect(plan).toEqual([]);
    });

    // Plans for games leaving the repertoire are exercised by GameAnnotationService.test
    // (this planner delegates to annotateRecord); a smoke test here is sufficient.
});
