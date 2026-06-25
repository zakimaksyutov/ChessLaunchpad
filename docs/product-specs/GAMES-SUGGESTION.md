# Games — Repertoire Suggestion (Draft Spec)

Goal: on a `/games` tile that shows a user error, go beyond reporting the
mistake — propose a concrete line to add to the repertoire so the user is
ready next time. See [`GAMES.md`](./GAMES.md) for the tile and error model
(deviation = user left book; EOT = opponent left book, user replied poorly).

## 1. Visualization

- **Entry point.** An inviting link **"Suggest a fix"** sits to the right of
  **"Analyze opponent"** in the summary row of any row with a user error
  (both deviation and EOT). It works independently of opponent analysis.
- **On click.** If producing the suggestion takes time, show an inline
  progress/spinner in the same style as "Analyze opponent"; otherwise resolve
  immediately.
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

2. **At the first out-of-repertoire user ply**, branch on whether the user's
   move is in the masters Top 5 for that position:

   - **(a) User's move is NOT in masters Top 5** → it's clearly off-book. Pick
     a replacement from the Top 5 via the **move-scoring** below. This is a
     deviation, so close out the line: append the chosen move, then the
     opponent's **top masters reply** (1 ply), then one more user move chosen
     via move-scoring — then **stop**.

   - **(b) User's move IS in masters Top 5** → score it with the same
     **move-scoring**. If it qualifies as **good**, accept the user's ply and
     continue the walk on the actual game (step 2 re-checks the next user ply).
     If it's **not good**, replace it and close out the line exactly as in (a).

**Continuation depth = 1.** Once we deviate (via a, or b-not-good), the line
ends after exactly: corrected user move → opponent's top masters reply → best
next user move. The only thing that keeps the walk going is case (b)-good,
which stays on the real game until the first deviation.

### Move-scoring (pick the best of masters Top 5)

For the position before the user ply, take the masters Top 5 moves and score
each on three dimensions, all from the **user's orientation**:

- **Master games** — `games(m) / Σ games(Top5)`.
- **Win%** — the move's win rate (orientation-adjusted), normalized across the 5.
- **Eval after the move** — from our DB, falling back to Lichess cloud-eval,
  normalized across the 5.

Combined score = the three normalized dimensions **multiplied**; pick the
highest. "Good" (case b) means the user's move is the top-scoring choice (or
within a tolerance of it).

**Thin masters data.** If fewer than 5 moves come back, score whatever is
returned (a missing candidate contributes zero and drops out). If the position
has **no master games at all** (rare), stop and emit the line built so far.

## Open questions

- **"Good enough" bar** in case (b) — strictly the top score, or within a
  tolerance of it?
