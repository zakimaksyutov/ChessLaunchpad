# Suggest-a-Fix Examples

Captured examples from the `/games` "Suggest a fix" scorer (`GameSuggestionService.scoreMastersMoves`), used to evaluate and tune the move-scoring formula (`dGames¹ · dWin² · dEval²`).

Each entry is **one scored position**: its FEN, the PGN line that reaches it, and the **raw scoring table** as emitted by the debug trace. Tables are **sorted by number of games (descending)**. All columns are from the user's orientation.

---

## Example 1 — user = white

**FEN:** `rnbqkb1r/pp2pp1p/2pp1np1/8/3PPP2/2N5/PPP3PP/R1BQKBNR w KQkq - 0 5`

**PGN:** `1. e4 d6 2. d4 Nf6 3. Nc3 c6 4. f4 g6`

| move | games | margin% | evalCp | dGames | dWin  | dEval | score% |
|------|-------|---------|--------|--------|-------|-------|--------|
| Nf3  | 154   | 20.1    | 100    | 0.933  | 0.028 | 0.222 | 10.2   |
| h3   | 3     | 100     | 24     | 0.018  | 0.686 | 0.186 | 82.7   |
| Bd3  | 3     | 66.7    | 29     | 0.018  | 0.181 | 0.188 | 5.9    |
| e5   | 3     | 0       | 63     | 0.018  | 0.013 | 0.205 | 0      |
| a4   | 2     | 50      | 52     | 0.012  | 0.093 | 0.199 | 1.2    |

Notes: `h3` wins on a 3-game 100% win-margin despite `Nf3` having 154 games — small-sample win-margin domination.
