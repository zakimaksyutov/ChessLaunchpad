# Suggest-a-Fix Examples

Captured examples from the `/games` "Suggest a fix" scorer (`GameSuggestionService.scoreMastersMoves`), used to evaluate and tune the move-scoring formula (`dGames¹ · dWin² · dEval²`).

Each entry is **one scored position**: its FEN, the PGN line that reaches it, then three tables — the **raw** masters inputs, the **current** algorithm's scores, and the **proposed** algorithm's scores. Tables are **sorted by number of games (descending)**. All columns are from the user's orientation.

---

## Example 1 — user = white

**FEN:** `rnbqkb1r/pp2pp1p/2pp1np1/8/3PPP2/2N5/PPP3PP/R1BQKBNR w KQkq - 0 5`

**PGN:** `1. e4 d6 2. d4 Nf6 3. Nc3 c6 4. f4 g6`

### Raw (masters inputs)

| move | games | margin% | evalCp |
|------|-------|---------|--------|
| Nf3  | 154   | 20.1    | 100    |
| h3   | 3     | 100     | 24     |
| Bd3  | 3     | 66.7    | 29     |
| e5   | 3     | 0       | 63     |
| a4   | 2     | 50      | 52     |

### Current algorithm

`score ∝ dGames¹ · dWin² · dEval²`, where `dWin` is a softmax (τ=0.25) over the **raw** win-margin.

| move | dGames | dWin  | dEval | score% |
|------|--------|-------|-------|--------|
| Nf3  | 0.933  | 0.028 | 0.222 | 10.2   |
| h3   | 0.018  | 0.686 | 0.186 | 82.7   |
| Bd3  | 0.018  | 0.181 | 0.188 | 5.9    |
| e5   | 0.018  | 0.013 | 0.205 | 0      |
| a4   | 0.012  | 0.093 | 0.199 | 1.2    |

`h3` wins on a 3-game 100% win-margin despite `Nf3` having 154 games — small-sample win-margin domination.

### Proposed algorithm (Bayesian shrinkage)

Same `dGames¹ · dWin² · dEval²`, but `dWin` softmaxes a **shrunk** margin `(games·margin + K·m0)/(games + K)` (K=50, prior `m0` = 22.4% = games-weighted mean) so small samples collapse toward the average.

| move | shrunk margin% | dGames | dWin  | dEval | score% |
|------|----------------|--------|-------|-------|--------|
| Nf3  | 20.7           | 0.933  | 0.179 | 0.222 | 93.3   |
| h3   | 26.8           | 0.018  | 0.228 | 0.186 | 2.1    |
| Bd3  | 24.9           | 0.018  | 0.212 | 0.188 | 1.8    |
| e5   | 21.1           | 0.018  | 0.182 | 0.205 | 1.6    |
| a4   | 23.5           | 0.012  | 0.200 | 0.199 | 1.2    |

`Nf3` (154 games) is restored to the top.
