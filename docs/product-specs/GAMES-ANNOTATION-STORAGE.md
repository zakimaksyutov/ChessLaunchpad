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
- **Analysis runs only on the analysis paths** — the automatic analysis pass
  (which analyzes any record lacking `fan`) and the manual per-game **Re-annotate**
  action. Re-annotate re-fetches the game, re-queries masters, reads the *current*
  repertoire and evals, recomputes the annotation, and overwrites the stored
  value. It is the user's deliberate "apply my current repertoire to this game"
  action.
- No recomputation happens at render time or anywhere outside those paths.

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

These live in a new **`fan`** field (frozen annotation) on the game record,
which replaces today's `an` field (see Schema below).

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

The change replaces the `an` field on a game record with a new **`fan`**
(frozen annotation) field; every other field is unchanged. Field names below are
illustrative — the exact encoding is left to the implementation.

**Current** — a full game record. The `an` field caches only the sparse
masters-theory verdicts; the highlights are recomputed at render time from the
current repertoire + evals:

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

**Proposed** — identical record, except the `an` field is replaced by `fan`,
the frozen annotation: per-user-move codes (and deviation alternatives when
present). Render is a pure read of `fan`:

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
  "ev": [18, 22, -19, -21, -17, /* … per-ply evals (lichess only) */],  // retained — see below
  "fan": {                     // ← frozen annotation (replaces "an")
    "hl": [0, 2, 2, 2, 2, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7]   // one code per user move, in order
    // no "alt" here — this game has no deviation (no code 1)
  }
}
```

### Per-ply evals (`ev`)

`ev` (lichess per-ply centipawn evals) is **retained**, not dropped. The *view*
never reads it — render is a pure read of `fan`, and nothing displays a raw eval
number — but `ev` is the input the analysis step needs to compute the `hl` codes,
and analysis does not happen when the game is persisted.

Ingest runs from both the Dashboard and the Games page and writes the record with
`ev` but **no `fan`**; the annotation is produced later, only when the user opens
`/games`. The two can be far apart — a Dashboard-only user may ingest games and
not open `/games` for days. The deferred analysis reads the **stored `ev`**, so
it must persist across that gap; otherwise the initial analysis would have to
re-fetch every game.

(Per-game **Re-annotate** is a separate path: for Lichess it re-fetches the game
anyway, so it does not depend on the stored `ev`; for Chess.com there is no `ev`.
The reason to keep `ev` is the deferred *initial* analysis above.)

When a game *does* have a deviation (code `1`), `fan` also carries the
alternatives for the green arrows / deviation summary:

```jsonc
"fan": {
  "hl": [0, 0, 1, 7, 7, /* … */],
  "alt": ["Be7", "Nbd7"]       // repertoire moves available at the deviation
}
```

`tv` is dropped: the masters decision is baked into the frozen codes at analysis
time, and Re-annotate re-queries masters fresh, so there is nothing left to cache.

## Clean game

A game is **clean** (hidden by the Mistakes filter, no row border) when it
contains no code `1` and no code `3`–`5`. This is read directly from the stored
codes — no recomputation.

## Migration

No dedicated migration pass, version bump, or user action is needed — the
existing automatic analysis pass converts old records natively.

The pass uses the annotation field as its "done" gate: a record with the field
present is treated as analyzed and skipped; a record without it is queued for
analysis. Renaming that gate (and the field the pass writes) from `an` to `fan`
is the whole migration:

- **Old records** carry legacy `an` but no `fan`, so they fail the `fan` gate and
  are automatically queued the next time the user opens `/games`. The pass
  recomputes and writes `fan`.
- **New games** are ingested without `fan` and analyzed the same way.

Because `ev` is retained, the backfill of old Lichess records does not re-fetch
the game for evals. Chess.com records backfill via `ExplorerEvals` as today.

The migration **drops the legacy `an` field entirely** — the pass does not read
its `tv`. Ambiguous opponent plies are re-queried against the masters API as a
normal part of analysis (the cached `tv` is not reused). This keeps the code
path identical to analyzing a fresh game, at the cost of those masters lookups
during backfill. As with any analysis, re-querying masters needs the Lichess
connection; old Lichess records with ambiguous plies backfill once connected
(the same gate that already applies to un-analyzed games).

Over a visit or two, the whole blob self-converts. A user who only opens the
Dashboard keeps un-analyzed records (no `fan`) until they visit `/games`; per the
render rule, those games simply show without highlights until then.

## Implementation notes

### Remove the dropped fields from the data contract

The fields being removed — `an` and its types (`MastersTheoryVerdict`,
`MastersTheoryPlyVerdict`, the `tv` shape) — must be deleted from the model and
never read again. The guiding rule: **even if an old blob still contains `an`,
no code path reads it.** The only signal that a record needs analysis is the
*absence* of `fan`; `an` carries no meaning anymore.

Concretely:

- **Model (`models/RepertoireData.ts`).** Remove `GameRecord.an` and the
  `MastersTheoryVerdict` / `MastersTheoryPlyVerdict` types. Add `GameRecord.fan`
  (the frozen annotation: `hl` codes + optional `alt`). `ev` and `op` are
  unchanged.
- **Analysis gate (`GameRecordAnalysisPass.ts`).** The "done" check switches from
  `record.an` to `record.fan`; the pass writes `fan` (not `an`). When it writes
  `fan`, it also deletes any legacy `an` so the field doesn't linger.
- **Masters seeding (`GameRecordAnalysisPlanner.ts`).** Remove the
  `record.an?.tv` hydration entirely — masters are always re-queried during
  analysis. Drop the `MastersLookupLike`-from-`tv` path.
- **Row selection / re-annotate state (`GameRowSelection.ts`, `GamesPage.tsx`).**
  Every `record.an` reference (the analyzed gate, the annotation memo key, the
  reveal-as-ready patch, the Re-annotate `priorAn` overlay) moves to `fan`.

### Render path

Render reads **only** `fan`. Remove the render-time recomputation: the view no
longer calls `annotateGame`, and no longer needs the repertoire FEN sets or
`ExplorerEvals` to display a game. The per-move highlighting, mini-board anchor,
deviation arrows/summary, EOT summary, row border, and the Mistakes filter are
all derived from `fan` (`hl` + `alt`) plus replaying `m`. A record without `fan`
renders plain (no highlights) and offers Re-annotate.

### No backend change

The backend stores `games` as a free-form object and full schema validation is
disabled, so it accepts both old blobs (with `an`) and new ones (with `fan`) with
no contract change. `docs/BACKEND_API_CONTRACT.md` is a copy from the backend
repo and is not edited here.

### Tests and storage docs

Update tests and any wire-format references that mention `an` / `tv` (e.g.
`docs/REPERTOIRE-STORAGE.md`) to the `fan` shape.
