# Games — Stored Annotation Spec

## Goal

Freeze each game's annotation at analysis time and store everything the
`/games` view needs to render it. Rendering becomes a **pure read** of the
stored annotation — no repertoire lookups, no eval lookups, no masters
queries at view time.

This fixes two problems:

1. **Retroactive false mistakes.** Today the deviation/highlight is recomputed
   against the *current* repertoire on every render. Extending your repertoire
   later makes an old, previously-fine game show a new "mistake." Freezing the
   verdict eliminates this.
2. **Load-order flash.** Today the view needs a separately-loaded eval resource
   to compute highlights, so rows render unfiltered and then collapse. A stored
   annotation ships with the record and renders correctly on first paint.

## Principle

- **Render = pure read.** The view paints from the stored annotation only.
- **Analysis runs only on the analyze / Re-analyze paths.** Re-analyze
  re-fetches the game, re-queries masters, reads the *current* repertoire and
  evals, recomputes the annotation, and overwrites the stored value. It is the
  user's deliberate "apply my current repertoire to this game" action.
- No automatic recomputation happens between those points.

## What we store

Per game, the frozen annotation holds:

- **A highlight code per user move** (table below). Only the **user's** moves
  carry a code — opponent moves always render neutral, so nothing is stored for
  them. At render the move list is replayed and the user's side is known, so the
  codes map back to the right plies. Codes are listed in move order.
- **The deviation alternatives** — the repertoire move(s) that were available at
  the deviation point — needed for the green arrows and the deviation summary,
  since they are not derivable from the move list alone. Present only when the
  game has a deviation (code `1`).

Everything else the view shows (board position, SANs, move numbers, side to
move, orientation) is deterministically replayed from the stored move list and
is not part of the annotation.

### Examples

`ecEK6zTr` (user is Black; in-rep for three moves, then a blunder, then
out-of-theory to the end) stores just the user-move codes, in order:

```
[0, 0, 0, 5, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]
```

No deviation alternatives, since the game has no code `1`. The `5` makes it a
non-clean game (blunder → purple row border).

`Zw3l4cYE` (user is Black; the opponent leaves book early, the user answers with
several ok responses, then one inaccuracy, then out-of-theory):

```
[0, 2, 2, 2, 2, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7]
```

Again no deviation alternatives (no code `1`). The `3` makes it non-clean
(inaccuracy → gold row border).

## Highlight codes

A code classifies each **user** move. Opponent moves are not coded — they
always render neutral. The colors below apply to the user's moves.

| Code | Meaning | Applies to | Render |
|---|---|---|---|
| `0` | in-repertoire | user move | green |
| `1` | deviation — first user move leaving the repertoire | user move | purple border |
| `2` | post-theory response, ok (no notable eval drop) | user move | plain |
| `3` | post-theory response, inaccuracy (≥ 30 cp) | user move | gold |
| `4` | post-theory response, mistake (≥ 50 cp) | user move | red |
| `5` | post-theory response, blunder (≥ 70 cp) | user move | purple |
| `7` | out-of-theory — theory has ended | user move | plain |
| — | any opponent move | opponent move | neutral (always) |

Notes:

- Codes match the existing move-highlight categories; `post-theory response` is
  split by the existing eval-drop thresholds (30 / 50 / 70 cp).
- Code `6` (out-of-repertoire) only ever applies to **opponent** moves, so it is
  not a user-move code.
- Codes `2` and `7` look identical on a user move (both plain); they differ only
  in meaning (still analyzing vs theory over).

## Schema

The change is contained to the `an` field on a game record; every other field
is unchanged. Field names below are illustrative — the exact encoding is left to
the implementation.

**Current** — a full game record. `an` caches only the sparse masters-theory
verdicts; the highlights are recomputed at render time from the current
repertoire + evals:

```jsonc
{
  "id": "Zw3l4cYE",            // provider game id
  "p": "l",                    // platform: "l" lichess | "c" chess.com
  "t": 1781421284529,          // played-at (ms)
  "m": "e4 e6 b3 d5 Bb2 dxe4 Nc3 Nf6 Qe2 Be7 Nxe4 Nxe4 Qxe4 Bf6 d4 O-O …",  // SAN moves
  "wa": "Tjehoba", "wr": 2285, // white account + rating
  "ba": "ZakiMa",  "br": 2289, // black account + rating (the user)
  "res": "win", "rt": 1,       // result, rated
  "tc": "5+0", "sp": "blitz",  // time control, speed
  "o": "French Defense: Horwitz Attack, Papa-Ticulat Gambit",  // opening name
  "ev": [18, 22, -19, -21, -17, /* … per-ply evals (lichess only) */],
  "an": {                      // ← analysis verdict (changes below)
    "tv": [ { "ply": 2, "in": true } ]    // sparse masters verdicts only
  }
  // "op" (opponent analysis) is optional and absent here — unrelated to this change
}
```

**Proposed** — identical record, except `an` becomes the frozen annotation:
per-user-move codes (and deviation alternatives when present). Render is a pure
read of `an`:

```jsonc
{
  "id": "Zw3l4cYE",
  "p": "l",
  "t": 1781421284529,
  "m": "e4 e6 b3 d5 Bb2 dxe4 Nc3 Nf6 Qe2 Be7 Nxe4 Nxe4 Qxe4 Bf6 d4 O-O …",
  "wa": "Tjehoba", "wr": 2285,
  "ba": "ZakiMa",  "br": 2289,
  "res": "win", "rt": 1,
  "tc": "5+0", "sp": "blitz",
  "o": "French Defense: Horwitz Attack, Papa-Ticulat Gambit",
  // "ev" is dropped — see "Per-ply evals (`ev`)" below
  "an": {                      // ← frozen annotation
    "hl": [0, 2, 2, 2, 2, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7]   // one code per user move, in order
    // no "alt" here — this game has no deviation (no code 1)
  }
}
```

### Per-ply evals (`ev`)

`ev` (lichess per-ply centipawn evals) is **no longer persisted**. It is an
analysis-time input only: it feeds the eval-drop classification whose result is
already baked into the `hl` codes (`3`/`4`/`5`). The view never reads `ev` —
nothing displays a raw eval number; only the category drives rendering.

(Re-)analysis re-fetches the game from the provider, which re-supplies the
evals, so the stored record does not need to carry them. Dropping `ev` removes
the largest per-game field after the move list.

When a game *does* have a deviation (code `1`), `an` also carries the
alternatives for the green arrows / deviation summary:

```jsonc
"an": {
  "hl": [0, 0, 1, 7, 7, /* … */],
  "alt": ["Be7", "Nbd7"]       // repertoire moves available at the deviation
}
```

`tv` is dropped: the masters decision is baked into the frozen codes at analysis
time, and Re-analyze re-queries masters fresh, so there is nothing left to cache.

## Clean game

A game is **clean** (hidden by the Mistakes filter, no row border) when it
contains no code `1` and no code `3`–`5`. This is read directly from the stored
codes — no re-analysis.
