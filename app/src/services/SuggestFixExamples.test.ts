import { describe, it, expect } from 'vitest';
import { rankMoveStats, MoveStat } from './GameSuggestionService';

// ---------------------------------------------------------------------------
// Executable companion to docs/SuggestFixExamples.md. Each captured position is
// one test: feed its raw masters inputs (Algorithm 2 / Shrinkage) through the
// shared `rankMoveStats` core and assert the top move and published scores.
//
// To add a position: add it to the markdown table, then add an `it(...)` here
// with the same raw rows and expected top move.
// ---------------------------------------------------------------------------

describe('SuggestFixExamples — rankMoveStats matches docs/SuggestFixExamples.md', () => {
    it('Example 1 (user = white): Nf3 stays on top of a tiny-sample h3', () => {
        // 1. e4 d6 2. d4 Nf6 3. Nc3 c6 4. f4 g6 — White to move (index 0 = Nf3).
        const stats: MoveStat[] = [
            { games: 154, margin: 0.201, evalCp: 100 }, // Nf3
            { games: 3, margin: 1.0, evalCp: 24 },      // h3
            { games: 3, margin: 0.667, evalCp: 29 },    // Bd3
            { games: 3, margin: 0.0, evalCp: 63 },      // e5
            { games: 2, margin: 0.5, evalCp: 52 },      // a4
        ];
        const ranked = rankMoveStats(stats);

        expect(ranked[0].index).toBe(0); // Nf3 wins
        // Regression-lock the published Algorithm 2 score table.
        expect(ranked[0].score * 100).toBeCloseTo(93.3, 1);
        const h3 = ranked.find(r => r.index === 1)!;
        expect(h3.score * 100).toBeCloseTo(2.1, 1);
        // h3's raw 100% margin is shrunk toward the prior (~22.4%).
        expect(h3.shrunkMargin).toBeCloseTo(0.268, 2);
    });
});
