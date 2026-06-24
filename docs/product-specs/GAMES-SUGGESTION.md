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
- One suggestion per row; the result may persist on the record like opponent
  analysis (TBD — see open questions).

## 2. Suggestion algorithm — 3 options to brainstorm

All start from the **critical position**: the deviation point (user error) or
the opponent's out-of-book move (EOT). The suggested PGN is that position's
recommended continuation, extended a few plies.

- **A. Theory-driven (masters book).** Query Lichess Masters at the critical
  position and walk the most-played / best-scoring line.
  *+* Sound, established theory; reuses `MastersExplorerService`.
  *–* Masters rarely cover the offbeat amateur moves that caused the error —
  often thin or empty exactly where it's needed.

- **B. Engine-driven (cloud eval).** Take the engine's top move(s) at the
  critical position and extend its principal variation.
  *+* Works for rare positions masters never reached; directly answers "what
  should I have played." Reuses `LichessCloudEvalService`.
  *–* Cloud-eval has gaps (404) for very rare positions and is rate-limited;
  PV depth/quality varies.

- **C. Population-driven (what you'll actually face).** Use the broader
  Lichess explorer (amateur, rating-banded) — and optionally the opponent's
  own games — to find the moves *real opponents play* at the critical
  position, then pair the most frequent one(s) with a recommended reply (from
  A/B).
  *+* Prioritizes coverage of what the user actually meets at their level, not
  just textbook lines.
  *–* Heavier (extra downloads); risks over-fitting to one opponent.

A practical hybrid is likely: **C to pick which move(s) to prepare for, B (or
A where available) to pick the reply.**

## Open questions

- Does the suggestion apply to deviation rows, EOT rows, or both?
- Persist the suggested PGN on the record, or recompute each click?
- How deep should the suggested line go (single best reply vs. a few plies)?
