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
  shown on an EOT row (for discoverability) regardless of Lichess connection
  state — **until a fix has been suggested**, at which point the link hides and
  the saved suggestion is shown instead (mirroring "Analyze opponent").
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
  - The user's own in-repertoire plies get the same **greenish background** as
    the tile's main PGN (the in-repertoire styling / FEN-set check). Opponent
    plies are greyed regardless of repertoire membership — matching the main
    tile, where repertoire membership is only surfaced on the user's moves.
  - Moves that **differ from the played game** (the corrected move and its
    continuation) are **bold**; everything before reads as "same as you
    played". The first bold move carries a muted **"(instead of X)"** note,
    where `X` is the user's actual move it replaces.
  - **Open in Lichess Opening Explorer** — link to study the line further; the
    replaced move `X` is appended as a one-ply `(…)` variation so both can be
    compared.
  - **Add to repertoire** — deep-links into the Explorer Review & Save flow to
    add the corrected line (without the `X` variation). **Save** or **Discard**
    returns the user to `/games`, scrolled to the row (highlighted on Save).
    Once added, the action is replaced by a persistent **"Added to repertoire"**
    confirmation (see below).
    - **"Already exists in the repertoire".** When **every** ply of the
      suggested line is already in the repertoire there is nothing to add (e.g.
      the user added the identical fix from an earlier game with the same
      opening), so the "Add to repertoire" action is replaced by an
      **"Already exists in the repertoire"** confirmation. Derived live from the
      line's per-ply in-repertoire flags (`GameRecord.sg.pl[].r`), which are
      persisted with the suggestion, so it survives reloads with no extra flag.
- One suggestion per row. **Persisted to the game record** (`GameRecord.sg`,
  anchored on the EOT user ply like the saved `op`) so it survives reloads and
  the link can hide on return visits. Re-annotate clears it; a repertoire change
  that moves the anchored deviation marks the saved suggestion stale and
  re-offers the action (recompute on the next click).
  - **"Added to repertoire" confirmation.** Committing the suggestion stamps
    `GameRecord.sg.ap = 1`. The row annotation is **frozen** (`fan`) and keeps
    offering "Add to repertoire" until the next Re-annotate, so this sticky flag
    is what flips the label. It rides along in the activity blob (no backend
    change).

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
