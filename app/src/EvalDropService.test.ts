import { describe, it, expect } from 'vitest';
import { ExplorerEvals } from './ExplorerEvals';
import { computeEvalDrops, categorizeEvalDrop } from './EvalDropService';

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

describe('computeEvalDrops', () => {
    // Positions after: start, 1.e4, 1...e5, 2.Nf3
    // We'll create eval data that simulates a drop on a specific move.
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
    const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq';
    const afterNf3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq';

    it('computes eval drops for white moves (white orientation)', () => {
        // White plays e4: eval goes from 19 to 18 → drop = 19-18 = 1 (ok)
        // White plays Nf3: eval goes from 35 to 30 → drop = 35-30 = 5 (ok)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: 19,
            [afterE4]: 18,
            [afterE5]: 35,
            [afterNf3]: 30,
        });

        const drops = computeEvalDrops('1. e4 e5 2. Nf3', evals, 'white');

        // Only user (white) moves should be in the result
        // Move 1. e4: afterFen has full FEN from chess.js, need to check it matches
        expect(drops.size).toBe(2); // e4 and Nf3
    });

    it('detects inaccuracy for white', () => {
        // White plays e4: eval drops from 19 to -20 → drop = 19-(-20) = 39 (inaccuracy)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: 19,
            [afterE4]: -20,
        });

        const drops = computeEvalDrops('1. e4', evals, 'white');
        expect(drops.size).toBe(1);
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(39);
        expect(drop.category).toBe('inaccuracy');
    });

    it('detects mistake for white', () => {
        // White plays e4: eval drops from 19 to -40 → drop = 59 (mistake)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: 19,
            [afterE4]: -40,
        });

        const drops = computeEvalDrops('1. e4', evals, 'white');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(59);
        expect(drop.category).toBe('mistake');
    });

    it('computes eval drops for black moves (black orientation)', () => {
        // Black plays e5: eval goes from 18 to 35
        // From Black's perspective: drop = evalAfter - evalBefore = 35 - 18 = 17
        // (positive means position got better for White, worse for Black)
        const evals = ExplorerEvals.fromRecord({
            [startFen]: 19,
            [afterE4]: 18,
            [afterE5]: 35,
            [afterNf3]: 30,
        });

        const drops = computeEvalDrops('1. e4 e5 2. Nf3', evals, 'black');

        // Only black's move (e5) should be evaluated
        expect(drops.size).toBe(1);
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(17); // 35 - 18
        expect(drop.category).toBe('ok');
    });

    it('detects blunder for black', () => {
        // Black plays e5: eval goes from 18 to 100 → drop = 100-18 = 82 (blunder)
        const evals = ExplorerEvals.fromRecord({
            [afterE4]: 18,
            [afterE5]: 100,
        });

        const drops = computeEvalDrops('1. e4 e5', evals, 'black');
        const drop = Array.from(drops.values())[0];
        expect(drop.evalDrop).toBe(82);
        expect(drop.category).toBe('blunder');
    });

    it('skips moves where eval data is missing', () => {
        // Only have eval for start position, not after e4
        const evals = ExplorerEvals.fromRecord({
            [startFen]: 19,
        });

        const drops = computeEvalDrops('1. e4 e5 2. Nf3', evals, 'white');
        expect(drops.size).toBe(0);
    });

    it('returns empty map for invalid PGN', () => {
        const evals = ExplorerEvals.fromRecord({ [startFen]: 19 });
        const drops = computeEvalDrops('invalid pgn garbage', evals, 'white');
        expect(drops.size).toBe(0);
    });

    it('returns empty map for empty PGN', () => {
        const evals = ExplorerEvals.fromRecord({ [startFen]: 19 });
        const drops = computeEvalDrops('', evals, 'white');
        expect(drops.size).toBe(0);
    });
});
