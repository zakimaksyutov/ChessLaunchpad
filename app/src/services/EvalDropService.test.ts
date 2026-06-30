import { describe, it, expect } from 'vitest';
import { categorizeEvalDrop, computeConservativeDrop } from './EvalDropService';

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
