import { describe, it, expect } from 'vitest';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { computeEvalDrops, categorizeEvalDrop, computeConservativeDrop } from './EvalDropService';

describe('categorizeEvalDrop', () => {
    it('returns ok for small drops', () => {
        expect(categorizeEvalDrop(0)).toBe('ok');
        expect(categorizeEvalDrop(15)).toBe('ok');
        expect(categorizeEvalDrop(29)).toBe('ok');
    });

    it('returns inaccuracy for 30-49cp drops', () => {
        expect(categorizeEvalDrop(30)).toBe('inaccuracy');
        expect(categorizeEvalDrop(49)).toBe('inaccuracy');
    });

    it('returns mistake for 50-69cp drops', () => {
        expect(categorizeEvalDrop(50)).toBe('mistake');
        expect(categorizeEvalDrop(69)).toBe('mistake');
    });

    it('returns blunder for >=70cp drops', () => {
        expect(categorizeEvalDrop(70)).toBe('blunder');
        expect(categorizeEvalDrop(200)).toBe('blunder');
    });
});

describe('computeConservativeDrop', () => {
    it('returns single-value drop for White move', () => {
        // before=19, after=-20 → drop = 19-(-20) = 39
        expect(computeConservativeDrop([19], [-20], true)).toBe(39);
    });

    it('returns single-value drop for Black move', () => {
        // before=18, after=100 → drop = 100-18 = 82
        expect(computeConservativeDrop([18], [100], false)).toBe(82);
    });

    it('picks minimum drop for White move with unstable before evals', () => {
        // before=[89, 54], after=[49] → pairings: 89-49=40, 54-49=5 → min=5
        expect(computeConservativeDrop([89, 54], [49], true)).toBe(5);
    });

    it('picks minimum drop for White move with unstable after evals', () => {
        // before=[50], after=[10, 40] → pairings: 50-10=40, 50-40=10 → min=10
        expect(computeConservativeDrop([50], [10, 40], true)).toBe(10);
    });

    it('picks minimum drop for White move with both sides unstable', () => {
        // before=[89, 54], after=[49, 49] → min pairing: 54-49=5
        expect(computeConservativeDrop([89, 54], [49, 49], true)).toBe(5);
    });

    it('picks minimum drop for Black move with unstable evals', () => {
        // Black: drop = after - before
        // before=[18, 48], after=[35, 42]
        // Pairings: 35-18=17, 42-18=24, 35-48=-13, 42-48=-6 → min=-13
        expect(computeConservativeDrop([18, 48], [35, 42], false)).toBe(-13);
    });

    it('returns negative drop when mover improved position (White)', () => {
        // before=[20], after=[30] → drop = 20-30 = -10 (White improved)
        expect(computeConservativeDrop([20], [30], true)).toBe(-10);
    });

    it('returns negative drop when mover improved position (Black)', () => {
        // before=[30], after=[20] → drop = 20-30 = -10 (Black improved)
        expect(computeConservativeDrop([30], [20], false)).toBe(-10);
    });
});

describe('computeEvalDrops', () => {
    // Positions after: start, 1.e4, 1...e5, 2.Nf3
    // We'll create eval data that simulates a drop on a specific move.
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
    const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq';
    const afterNf3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq';

    it('computes eval drops for white moves (white orientation)', () => {
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [19, 19],
            [afterE4]: [18, 18],
            [afterE5]: [35, 35],
            [afterNf3]: [30, 30],
        });

        const drops = computeEvalDrops('1. e4 e5 2. Nf3', evals, 'white');
        expect(drops.size).toBe(2); // e4 and Nf3
    });

    it('detects inaccuracy for white (single-value)', () => {
        // White plays e4: min drop from [19] to [-20] = 19-(-20) = 39 (inaccuracy)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [19],
            [afterE4]: [-20],
        });

        const drops = computeEvalDrops('1. e4', evals, 'white');
        expect(drops.size).toBe(1);
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(39);
        expect(drop.category).toBe('inaccuracy');
    });

    it('detects mistake for white (single-value)', () => {
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [19],
            [afterE4]: [-40],
        });

        const drops = computeEvalDrops('1. e4', evals, 'white');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(59);
        expect(drop.category).toBe('mistake');
    });

    it('suppresses false positive for white when evals are unstable', () => {
        // Before: [89, 54], After: [49, 49]
        // Primary-only would give 89-49=40 (inaccuracy), but conservative
        // min pairing is 54-49=5 (ok)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [89, 54],
            [afterE4]: [49, 49],
        });

        const drops = computeEvalDrops('1. e4', evals, 'white');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(5);
        expect(drop.category).toBe('ok');
    });

    it('still highlights when all pairings exceed threshold for white', () => {
        // Before: [80, 75], After: [10, 5]
        // Pairings: 80-10=70, 80-5=75, 75-10=65, 75-5=70 → min=65 (mistake)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [80, 75],
            [afterE4]: [10, 5],
        });

        const drops = computeEvalDrops('1. e4', evals, 'white');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(65);
        expect(drop.category).toBe('mistake');
    });

    it('computes eval drops for black moves (black orientation)', () => {
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [19, 19],
            [afterE4]: [18, 18],
            [afterE5]: [35, 35],
            [afterNf3]: [30, 30],
        });

        const drops = computeEvalDrops('1. e4 e5 2. Nf3', evals, 'black');
        expect(drops.size).toBe(1);
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(17); // 35 - 18
        expect(drop.category).toBe('ok');
    });

    it('detects blunder for black (single-value)', () => {
        const evals = ExplorerEvals.fromRecord({
            [afterE4]: [18],
            [afterE5]: [100],
        });

        const drops = computeEvalDrops('1. e4 e5', evals, 'black');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(82);
        expect(drop.category).toBe('blunder');
    });

    it('suppresses false positive for black when evals are unstable', () => {
        // Black move: drop = after - before
        // Before: [18, 48], After: [100, 42]
        // Pairings: 100-18=82, 42-18=24, 100-48=52, 42-48=-6 → min=-6 (ok)
        const evals = ExplorerEvals.fromRecord({
            [afterE4]: [18, 48],
            [afterE5]: [100, 42],
        });

        const drops = computeEvalDrops('1. e4 e5', evals, 'black');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(-6);
        expect(drop.category).toBe('ok');
    });

    it('still highlights when all pairings exceed threshold for black', () => {
        // Black move: drop = after - before
        // Before: [10, 15], After: [80, 85]
        // Pairings: 80-10=70, 85-10=75, 80-15=65, 85-15=70 → min=65 (mistake)
        const evals = ExplorerEvals.fromRecord({
            [afterE4]: [10, 15],
            [afterE5]: [80, 85],
        });

        const drops = computeEvalDrops('1. e4 e5', evals, 'black');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(65);
        expect(drop.category).toBe('mistake');
    });

    it('skips moves where eval data is missing', () => {
        const evals = ExplorerEvals.fromRecord({
            [startFen]: [19],
        });

        const drops = computeEvalDrops('1. e4 e5 2. Nf3', evals, 'white');
        expect(drops.size).toBe(0);
    });

    it('skips moves where eval data is an empty array', () => {
        // Empty arrays should be treated the same as missing data
        const data: Record<string, number[]> = {
            [startFen]: [],
            [afterE4]: [18],
        };
        const evals = ExplorerEvals.fromRecord(data);
        const drops = computeEvalDrops('1. e4', evals, 'white');
        expect(drops.size).toBe(0);
    });

    it('returns empty map for invalid PGN', () => {
        const evals = ExplorerEvals.fromRecord({ [startFen]: [19] });
        const drops = computeEvalDrops('invalid pgn garbage', evals, 'white');
        expect(drops.size).toBe(0);
    });

    it('returns empty map for empty PGN', () => {
        const evals = ExplorerEvals.fromRecord({ [startFen]: [19] });
        const drops = computeEvalDrops('', evals, 'white');
        expect(drops.size).toBe(0);
    });
});
