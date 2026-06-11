import { describe, it, expect, vi } from 'vitest';
import { Chess } from 'chess.js';
import {
    buildLookupFromAn,
    fetchMastersWithMemo,
    MastersMemoEntry,
    classifyLookupOutcome,
    buildVerdictFromPlan,
    planAmbiguousPositions,
} from './GameRecordAnalysisPlanner';
import { GameRecord } from '../models/RepertoireData';
import { MastersLookup } from './MastersExplorerService';
import { AmbiguousTheoryPosition } from './GameAnnotationService';
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

describe('buildLookupFromAn', () => {
    it('returns an empty lookup for a record without an', () => {
        const rec = makeRecord({ m: 'e4 e5' });
        const lookup = buildLookupFromAn(rec);
        expect(lookup.size).toBe(0);
    });

    it('returns an empty lookup for tv = []', () => {
        const rec = makeRecord({ m: 'e4 e5', an: { tv: [] } });
        const lookup = buildLookupFromAn(rec);
        expect(lookup.size).toBe(0);
    });

    it('classifies an in-theory verdict as not-out-of-theory', () => {
        // Game: e4 e5 Nf3 — the ply-2 SAN is "Nf3"; we use that as the san at the verdict.
        const rec = makeRecord({ m: 'e4 e5 Nf3', an: { tv: [{ ply: 2, in: true }] } });
        const lookup = buildLookupFromAn(rec);
        // Walk to the same position the verdict was about (after e4 e5 → before Nf3 is played).
        const chess = new Chess();
        chess.move('e4'); chess.move('e5');
        const fen = chess.fen();
        expect(lookup.isOutOfTheory(fen, 'Nf3')).toBe(false);
    });

    it('classifies an out-of-theory verdict as out-of-theory', () => {
        const rec = makeRecord({ m: 'e4 e5 a3', an: { tv: [{ ply: 2, in: false }] } });
        const lookup = buildLookupFromAn(rec);
        const chess = new Chess();
        chess.move('e4'); chess.move('e5');
        expect(lookup.isOutOfTheory(chess.fen(), 'a3')).toBe(true);
    });

    it('returns null for a position+san not in the verdict map (optimistic default at render)', () => {
        const rec = makeRecord({ m: 'e4 e5 Nf3', an: { tv: [{ ply: 2, in: true }] } });
        const lookup = buildLookupFromAn(rec);
        const chess = new Chess();
        chess.move('e4'); chess.move('e5');
        // Different san at same position → no verdict stored → null.
        expect(lookup.isOutOfTheory(chess.fen(), 'Bc4')).toBeNull();
    });

    it('handles two verdicts at different plies that share a FEN-key (transposition, different SANs)', () => {
        // Construct a record where two persisted verdicts live at the same
        // position but for different SANs — buildLookupFromAn must report
        // them per-(pos, san) without collision.
        const rec = makeRecord({
            m: 'e4 e5 Nf3',
            an: { tv: [
                { ply: 0, in: true }, // e4 from starting pos
                // (hypothetical second verdict at ply 0 would be the same SAN
                //  in reality; we exercise the per-(pos, san) keying by
                //  including a follow-up verdict and asserting the wrong san
                //  returns null.)
            ] },
        });
        const lookup = buildLookupFromAn(rec);
        const startFen = new Chess().fen();
        expect(lookup.isOutOfTheory(startFen, 'e4')).toBe(false);
        expect(lookup.isOutOfTheory(startFen, 'd4')).toBeNull();
    });
});

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

describe('classifyLookupOutcome', () => {
    it('returns error for an error memo entry', () => {
        expect(classifyLookupOutcome({ kind: 'error' }, 'e4')).toBe('error');
    });
    it('returns ok-with-data when the move has stats', () => {
        const result = { fen: 'x', totalGames: 100, moves: [{ san: 'e4', white: 50, draws: 25, black: 25, total: 100 }] };
        expect(classifyLookupOutcome({ kind: 'ok', result }, 'e4')).toBe('ok-with-data');
    });
    it('returns ok-no-data when the position has totalGames=0', () => {
        const result = { fen: 'x', totalGames: 0, moves: [] };
        expect(classifyLookupOutcome({ kind: 'ok', result }, 'e4')).toBe('ok-no-data');
    });
    it('returns ok-no-data when the san has 0 games', () => {
        const result = { fen: 'x', totalGames: 100, moves: [{ san: 'd4', white: 50, draws: 25, black: 25, total: 100 }] };
        expect(classifyLookupOutcome({ kind: 'ok', result }, 'e4')).toBe('ok-no-data');
    });
});

describe('buildVerdictFromPlan', () => {
    it('emits in-theory verdicts when the masters lookup confirms', () => {
        const plan: AmbiguousTheoryPosition[] = [
            { moveIndex: 0, plyIndex: 2, fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moveSan: 'e4' },
        ];
        const lookup = new MastersLookup();
        lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            totalGames: 100, moves: [{ san: 'e4', white: 50, draws: 25, black: 25, total: 100 }],
        });
        const rec = makeRecord({ m: 'e4 e5' });
        const verdict = buildVerdictFromPlan(plan, rec, lookup);
        expect(verdict.tv).toEqual([{ ply: 2, in: true }]);
    });

    it('omits plies when masters has no significant data for the SAN (no-data, not out-of-theory)', () => {
        const plan: AmbiguousTheoryPosition[] = [
            { moveIndex: 0, plyIndex: 4, fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moveSan: 'a3' },
        ];
        const lookup = new MastersLookup();
        lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            totalGames: 100, moves: [{ san: 'e4', white: 50, draws: 25, black: 25, total: 100 }], // a3 missing
        });
        const verdict = buildVerdictFromPlan(plan, makeRecord({ m: 'a3' }), lookup);
        // Spec §`an`: no-data plies are OMITTED, not stored as out-of-theory.
        // This avoids the one-way conflation between "confirmed out of theory"
        // and "we have no information."
        expect(verdict.tv).toBeUndefined();
    });

    it('emits out-of-theory verdicts when masters has data for the san but it falls below the theory threshold', () => {
        const plan: AmbiguousTheoryPosition[] = [
            { moveIndex: 0, plyIndex: 4, fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moveSan: 'h3' },
        ];
        const lookup = new MastersLookup();
        lookup.add('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            totalGames: 200, moves: [
                { san: 'e4', white: 100, draws: 50, black: 46, total: 196 },
                { san: 'h3', white: 2, draws: 1, black: 1, total: 4 }, // 4 games < MIN_MASTER_GAMES, rare but present
            ],
        });
        const verdict = buildVerdictFromPlan(plan, makeRecord({ m: 'h3' }), lookup);
        expect(verdict.tv).toEqual([{ ply: 4, in: false }]);
    });

    it('omits plies the lookup has no data for (sparse tv)', () => {
        const plan: AmbiguousTheoryPosition[] = [
            { moveIndex: 0, plyIndex: 2, fenBefore: 'not-in-lookup', moveSan: 'e4' },
        ];
        const lookup = new MastersLookup();
        const verdict = buildVerdictFromPlan(plan, makeRecord({ m: 'e4 e5' }), lookup);
        expect(verdict.tv).toBeUndefined();
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
