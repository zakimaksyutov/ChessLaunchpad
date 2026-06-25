# Analyze Position — Suggestion Move Scorer

Interactive harness for the move-scoring step of the Games repertoire-suggestion
algorithm ([`GAMES-SUGGESTION.md`](../../docs/product-specs/GAMES-SUGGESTION.md)).
Paste a FEN at the `FEN>` prompt; it scores the masters Top-5 via
`dGames^wG * dWin^wW * dEval^wE` (L1-normalized).

```bash
node tools/analyze-position/suggest-score.cjs -skip 1,2,2 0.5,2,2
```

- `"wG,wW,wE"` — extra weight triples, each adds a `p_sum_N` column (baseline `p_sum` = `1,1,1`).
- `-skip` — skip cloud-eval (dEval neutral).
- `-tau=<n>` — win-margin softmax temperature (default `0.25`).

Needs `LICHESS_TOKEN` in repo-root `.env` and `chess.js` in `app/node_modules`.
