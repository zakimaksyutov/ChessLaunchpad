import { describe, it, expect } from 'vitest';
import { rankMoveStats, MoveStat } from './GameSuggestionService';

// ===========================================================================
// SUGGEST-A-FIX CONTRACT TESTS
//
// Executable companion to docs/SuggestFixExamples.md. Each captured position is
// one test that pins the CHOSEN move only — it asserts the single top-ranked
// move and nothing else (no scores, margins, or other internals), so it is
// robust to scoring-algorithm tweaks.
//
// ⚠️  CONTRACT: A change to the scoring algorithm MUST NOT change any chosen
//     move asserted here. If a change flips a top move, treat it as a behavior
//     regression — do NOT edit the test to match the new output. An expectation
//     may be changed ONLY with explicit human authorization, and the paired
//     example in docs/SuggestFixExamples.md must be updated alongside it.
//
// To add a position: add it to the markdown, then add an `it(...)` here with
// the same raw rows and the expected chosen move.
// ===========================================================================

describe('Suggest-a-Fix contract — chosen move is pinned', () => {
    it('Example 1 (user = white): chooses Nf3 over the tiny-sample h3', () => {
        // 1. e4 d6 2. d4 Nf6 3. Nc3 c6 4. f4 g6 — White to move.
        const moves = ['Nf3', 'h3', 'Bd3', 'e5', 'a4'];
        const stats: MoveStat[] = [
            { games: 154, margin: 0.201, evalCp: 100 }, // Nf3
            { games: 3, margin: 1.0, evalCp: 24 },      // h3
            { games: 3, margin: 0.667, evalCp: 29 },    // Bd3
            { games: 3, margin: 0.0, evalCp: 63 },      // e5
            { games: 2, margin: 0.5, evalCp: 52 },      // a4
        ];

        const top = rankMoveStats(stats)[0];
        expect(moves[top.index]).toBe('Nf3');
    });

    it('Example 2 (user = black): chooses Bxd4 in the Italian (5. d4)', () => {
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d4 — Black to move.
        // Raw rows are in Black's orientation (margin/eval as the user sees them).
        const moves = ['Bxd4', 'exd4', 'Nxd4'];
        const stats: MoveStat[] = [
            { games: 348, margin: 0.118, evalCp: 1 },    // Bxd4
            { games: 88, margin: -0.148, evalCp: -21 },  // exd4
            { games: 7, margin: -0.286, evalCp: -86 },   // Nxd4
        ];

        const top = rankMoveStats(stats)[0];
        expect(moves[top.index]).toBe('Bxd4');
    });
});
