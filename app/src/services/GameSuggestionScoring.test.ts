import { describe, it, expect } from 'vitest';
import { rankMoveStats, MoveStat } from './GameSuggestionService';

// ---------------------------------------------------------------------------
// Dedicated tests for the pure scoring core `rankMoveStats` — raw per-move
// stats in → ranked moves out, with no chess.js / FEN / eval I/O. This is the
// exact function `scoreMastersMoves` delegates to, so these lock the ranking
// behavior at the algorithm level. Position-specific captured examples live in
// SuggestFixContractTests.test.ts (paired with docs/SuggestFixExamples.md).
// ---------------------------------------------------------------------------

/** Convenience: the input index of the best-scoring move. */
function topIndex(stats: MoveStat[]): number {
    return rankMoveStats(stats)[0].index;
}

describe('rankMoveStats — top move', () => {
    it('prefers the popular move over a 3-game 100% even with no evals', () => {
        const top = topIndex([
            { games: 154, margin: 0.195, evalCp: null },
            { games: 3, margin: 1.0, evalCp: null },
        ]);
        expect(top).toBe(0);
    });

    it('lets eval break ties between equal popularity and margin', () => {
        const ranked = rankMoveStats([
            { games: 1000, margin: 0.2, evalCp: 80 },
            { games: 1000, margin: 0.2, evalCp: -20 },
        ]);
        expect(ranked[0].index).toBe(0);
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('treats a missing eval as a small disadvantage, not elimination', () => {
        const ranked = rankMoveStats([
            { games: 1000, margin: 0.2, evalCp: 0 },    // even eval
            { games: 1000, margin: 0.2, evalCp: null }, // missing → ~ -10cp
        ]);
        expect(ranked[0].index).toBe(0);                 // even eval edges ahead
        const missing = ranked.find(r => r.index === 1)!;
        expect(missing.score).toBeGreaterThan(0);        // still scored, not zeroed
    });
});

describe('rankMoveStats — shrinkage behavior', () => {
    it('barely moves a large-sample margin', () => {
        const ranked = rankMoveStats([
            { games: 100000, margin: 0.3, evalCp: 0 },
            { games: 100000, margin: 0.1, evalCp: 0 },
        ]);
        const big = ranked.find(r => r.index === 0)!;
        expect(big.shrunkMargin).toBeCloseTo(0.3, 2);
    });

    it('pulls a tiny-sample margin toward the games-weighted prior', () => {
        const ranked = rankMoveStats([
            { games: 200, margin: 0.2, evalCp: 0 },
            { games: 2, margin: 1.0, evalCp: 0 },
        ]);
        const tiny = ranked.find(r => r.index === 1)!;
        // Raw margin 1.0, but with only 2 games it collapses toward the prior.
        expect(tiny.shrunkMargin).toBeLessThan(0.3);
    });
});

describe('rankMoveStats — invariants', () => {
    it('returns scores that sum to 1, sorted best-first', () => {
        const ranked = rankMoveStats([
            { games: 5000, margin: 0.3, evalCp: 50 },
            { games: 4000, margin: 0.25, evalCp: 30 },
            { games: 1000, margin: 0.1, evalCp: 10 },
        ]);
        expect(ranked.reduce((a, r) => a + r.score, 0)).toBeCloseTo(1, 6);
        for (let i = 1; i < ranked.length; i++) {
            expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
        }
    });

    it('returns an empty ranking for empty input', () => {
        expect(rankMoveStats([])).toEqual([]);
    });
});
