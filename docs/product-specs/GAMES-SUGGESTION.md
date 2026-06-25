# Games — Repertoire Suggestion (Draft Spec)

Goal: on a `/games` tile that shows a user error, go beyond reporting the
mistake — propose a concrete line to add to the repertoire so the user is
ready next time. See [`GAMES.md`](./GAMES.md) for the tile and error model
(deviation = user left book; EOT = opponent left book, user replied poorly).

## 1. Visualization

- **Entry point.** An inviting link **"Suggest a fix"** sits to the right of
  **"Analyze opponent"** on **EOT** rows. **Not shown on deviation rows** — the
  user left their own repertoire, which already holds the intended move, so they
  already know the fix. It works independently of opponent analysis, and is
  **always shown** on an EOT row (for discoverability) regardless of
  Lichess connection state.
- **On click.** If producing the suggestion takes time, show an inline
  progress/spinner in the same style as "Analyze opponent"; otherwise resolve
  immediately.
  - **Requires a connected Lichess account** — the algorithm depends on the
    masters explorer, which needs a live OAuth token. (Cloud-eval is public and
    needs no token.) If no token is available at click time, render an inline
    **connect-Lichess prompt** (link to Settings) in the result area instead of
    computing, reusing the page's existing connect call-to-action.
- **Result.** A suggested **PGN** appears below the tile's existing content:
  the game's moves up to the critical position, then the recommended
  continuation.
  - Plies already in the repertoire get the same **greenish background** as
    the tile's main PGN (reuse the in-repertoire styling / FEN-set check).
  - **Open in Lichess Opening Explorer** — link to study the line further.
  - **Add to repertoire** — link to add the suggested line to the repertoire.
- One suggestion per row, **recomputed on each click** (not persisted to the
  record for now).

## 2. Suggestion algorithm

Walk the game's plies from the start, building the recommended PGN.

1. **Replay the in-repertoire prefix.** While each ply is already in the
   repertoire, append it as-is and continue.

   The first ply that leaves the repertoire is either the **user's**
   (deviation) or the **opponent's** (EOT). If it's the opponent's, append that
   move as-is — for an EOT row that reaches this feature it's a sound,
   still-in-theory move (genuine opponent blunders end analysis upstream and
   never get a "Suggest a fix" link) — then advance to the user's reply.

2. **At that user ply** (the first out-of-repertoire user move), branch on
   whether the user's move is in the masters Top 5 for that position:

   - **(a) User's move is NOT in masters Top 5** → it's clearly off-book. Pick
     a replacement from the Top 5 via the **move-scoring** below. This is a
     deviation, so close out the line: append the chosen move, then the
     opponent's **top masters reply** (1 ply), then one more user move chosen
     via move-scoring — then **stop**.

   - **(b) User's move IS in masters Top 5** → if it has **> 5,000 master
     games**, accept it immediately (popular enough to trust — no eval/scoring
     needed) and continue the walk. Otherwise score it with the same
     **move-scoring**. If it qualifies as **good**, accept the user's ply and
     continue the walk on the actual game (step 2 re-checks the next user ply).
     If it's **not good**, replace it and close out the line exactly as in (a).

**Continuation depth = 1.** Once we deviate (via a, or b-not-good), the line
ends after exactly: corrected user move → opponent's top masters reply → best
next user move. The only thing that keeps the walk going is case (b)-good,
which stays on the real game until the first deviation.

**Cost / latency (no cap).** Each scored position needs a masters call plus an
eval-after for up to 5 candidate FENs, resolved by the existing priority
(static → embedded → cloud-eval); out-of-book candidates usually fall to
cloud-eval, serialized at Lichess's ~1 req/sec. A click can therefore take
several seconds (more when case (b)-good chains across plies) — this is
surfaced via the inline spinner from §1, not bounded by a budget.

### Move-scoring (pick the best of masters Top 5)

For the position before the user ply, take the masters Top 5 moves and score
each on three dimensions, all from the **user's orientation**:

- **Master games** (`dGames`) — `games(m) / Σ games(Top5)`.
- **Win%** (`dWin`) — softmax over win-margin (win% − loss%, user orientation),
  with temperature `τ = 0.25`; strictly positive, so it never collapses even
  when every Top-5 move is below even (e.g. Black in most openings).
- **Eval after the move** (`dEval`) — eval-after in centipawns (user
  orientation, from our DB, falling back to Lichess cloud-eval), mapped to an
  expected score in 0–1 via the logistic `1 / (1 + 10^(−cp/400))`, then
  L1-normalized across the 5. **Eval-missing** (our-DB miss *and* cloud-eval
  404 — the common case for out-of-book candidates) is treated as ≈ **−10 cp**
  (a small disadvantage), never 0, so a sound popular move is never silently
  eliminated and the candidates can't all collapse to zero.

Combined score = the three normalized dimensions raised to per-dimension
weights **`(wG, wW, wE) = (1, 2, 2)`** and **multiplied**
(`dGames¹ · dWin² · dEval²`), then L1-normalized across the Top-5 so the five
scores sum to 100%. Pick the highest as the replacement move.

**"Good" bar (case b).** Accept the user's ply and keep walking the real game
if its normalized score is **≥ 10%**; otherwise treat it as not good and close
out the line as in (a).

**Thin masters data.** If fewer than 5 moves come back, score whatever is
returned (a missing candidate contributes zero and drops out). If the position
has **no master games at all** (rare), stop and emit the line built so far.

**Reference implementation.** `tools/analyze-position/suggest-score.cjs` (with
its [`README`](../../tools/analyze-position/README.md)) is an interactive
harness for this move-scoring — exactly the `dGames`/`dWin`/`dEval` dimensions,
weights, and mappings above. Explore it as a potential reference implementation
when building this feature.
