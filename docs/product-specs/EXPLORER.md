# Explorer — Product Specification

New page at `/explorer`. Lives **side by side** with the existing
`/repertoire` table and `/repertoire/variant` editor — neither is
removed or changed by this work. Both pages read and write the same
repertoire data.

## The Idea

The existing `/repertoire` page is a flat table of variants. The user
has to think in terms of PGN lines: each row is one line end-to-end,
and the per-variant editor only lets you edit one line at a time.
Transpositions appear as duplicated rows. Coverage gaps are invisible.
Adding a new move means opening the editor, scrolling to the end, and
saving.

**The Explorer thinks in positions instead of variants.** The user is
always looking at *a position on a board*. From that position they can
see how they got there (the PGN paths through the repertoire that
reach this position) and which moves they have covered next. There is
no separate editor screen inside the Explorer — v1 is read and
navigate only; edits still happen on the existing `/repertoire/variant`
page.

This matches what the rest of the app already does: FSRS cards,
eval-drop highlighting, and game annotation all key off positions, not
variants.

## What the Page Looks Like

```
┌── White ⇄ Black ──────────────────────────────────────────────────────┐
│ ┌──────────────────────┐  How you got here:                           │
│ │                      │    1.e4 c5 2.Nf3                             │
│ │                      │    1.Nf3 c5 2.e4                             │
│ │                      │    1.c4 c5 2.Nf3 e5 3.e4 (transposed)        │
│ │                      │    … 2 more ways                             │
│ │                      │                                               │
│ │     Chessboard       │  Sicilian Defense (B27)                       │
│ │      + arrows        │  Your moves from here:                        │
│ │   (entire left       │  ──────────────────────                       │
│ │     column)          │  ● Nc6   Mastered  due in 14d   R 92%         │
│ │                      │          12 reps · 2 lapses · last 5d ago     │
│ │                      │          → Old Sicilian                        │
│ │                      │    3.d4 cxd4 4.Nxd4 (4…Nf6, 4…e6, 4…a6)       │
│ │                      │                                               │
│ │                      │  ● d6    Due now   R 71%                      │
│ │                      │          8 reps · 1 lapse · last 22d ago      │
│ │                      │          → Najdorf                             │
│ │                      │    3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 (5…a6, 5…g6)    │
│ └──────────────────────┘                                               │
│ [ Paste FEN or PGN to jump… ]                                          │
└───────────────────────────────────────────────────────────────────────┘
```

The chessboard occupies the entire left column of the page (as tall and
wide as the available space allows). The right column holds, top to
bottom: "How you got here", the opening name, then the move list
("Your moves from here" / "Opponent's replies").

On narrow viewports the page reflows to a single vertical column in
this order: **board → opening name + move list → "How you got here" →
Find-position input**. The board stays square and scales to the
viewport width.

### Orientation toggle

The toggle defaults to White on first load (persisted per user across
sessions); toggling keeps the current position if it is also reachable
in the other orientation's repertoire, otherwise snaps to the start
position; for an empty repertoire the start position renders normally
with an empty move list and a "no lines in your {orientation}
repertoire yet" hint.

### URL format

`HashRouter` route `#/explorer?o={white|black}&fen={normalizedFen}`.
Both params are optional: `o` defaults to White, `fen` defaults to the
start position. `fen` is always the **normalized FEN** (halfmove clock
reset to 0, fullmove reset to 1 — same normalization as FSRS card keys
and the rest of the app); the Find-position input normalizes raw FENs
before navigating.

If the URL's `fen` is not in the active orientation's repertoire (e.g.
a shared link, or a position the user has since removed), the Explorer
**snaps to the start position** and shows a one-time toast: *"That
position isn't in your {orientation} repertoire — opened the starting
position instead."* The Explorer never renders an off-repertoire
position.

### Top: "How you got here"

- Shows the PGN path(s) from the starting position to the current FEN
  through this orientation's repertoire.
- **Ordering:** shortest path first, ties broken lexicographically by
  the SAN sequence.
- If there are multiple paths (transpositions), show up to **3** of
  them, one per row.
- If there are more than 3, append a single line **"… N more ways"**.
- **Enumeration cap:** stop searching after **20 paths**. If the cap is
  hit, the counter reads *"… 17+ more ways"* so the page never hangs on
  pathological transposition-heavy positions.
- Each row begins with a small **start** affordance that jumps the
  Explorer back to the starting position. When the Explorer is already
  at the starting position, the same pill is shown as a non-interactive
  badge in place of the path list (followed by "— no lines in your
  {orientation} repertoire yet" when the repertoire is empty).

### Middle: chessboard (left column)

- Occupies the **entire left column** of the page, as large as the
  available space allows.
- Shows the current position.
- Arrow annotations attached to this position are **displayed**.
  Arrows are **read-only** in v1; to add or edit arrows, use the
  existing `/repertoire/variant` editor. **No text notes in v1** —
  arrows only.
- Directly **under the board**, a small **"Find position"** input
  accepts either a FEN or a PGN line. The input is aligned to the
  board's width (does **not** stretch across the full page). Submitting
  it navigates the Explorer to that position **only if** the position
  exists in the active orientation's repertoire. Otherwise — whether
  the input fails to parse or the position simply isn't in the tree —
  the field shows an inline error (e.g. *"Not in your White
  repertoire."*) and the board does not move. Placeholder: *"Paste FEN
  or PGN to jump…"*.

### Bottom: "Your moves from here" / "Opponent's replies"

The heading is **"Your moves from here"** when the side to move in the
current FEN matches the active orientation, otherwise **"Opponent's
replies"**.

Just above the move list, show the **opening name** classified from
the current PGN path (e.g. *Sicilian Defense (B27)*). If no opening
matches, the line is omitted.

One row per move present in the repertoire from the current position.
If there are none, show a single-line empty state: *"No move in your
repertoire from here yet."* for your-turn positions, or *"No prepared
reply from here yet."* for opponent-turn positions.

For each row:

- The move's SAN.
- For **your** moves, an inline cluster of FSRS stats that together
  answer "how well do I know this and when do I need to see it again":

  | Stat | Example | Why it matters |
  |---|---|---|
  | **State pill** | `Mastered` / `Due` / `Learning` / `Relearning` / `New` | High-level status, color-coded. |
  | **Next due** | `due now` · `due in 14d` · `in 3 mo` | When the user will next be asked. |
  | **Retrievability** | `R 92%` | Estimated chance the user remembers the move right now — the most actionable single number. |
  | **Reps / lapses** | `12 reps · 2 lapses` | How much history this card has and how often it has slipped. |
  | **Last reviewed** | `last 5d ago` (omit for New) | When the user last touched it. |

  The implementer is free to lay these out as a single tight line (pill
  + small grey metadata strip) versus a two-line block, but all five
  pieces should be visible without hover.

  **Mastered** is a derived label (not an FSRS state): `state=Review` ∧
  not due ∧ retrievability ≥ target retention (same rule as autoplay in
  `ARCHITECTURE.md`). Otherwise Review = **Due**; Learning, Relearning,
  New map 1:1.

  **New rows** show only the state pill, opening label, and
  continuation — the other four stats (Next due, R%, reps/lapses, last
  reviewed) are omitted.

  **Opponent rows skip the FSRS cluster entirely** (opponent moves
  don't have cards) — they show only SAN, opening label, and the
  continuation underneath.

- An **opening label** next to the move, shown only when playing this
  move changes the classification. Compute the most-specific opening
  for **(current PGN)** and for **(current PGN + this move)** via
  `DatabaseOpeningsUtils.ClassifyOpening`. Show the after-label if the
  **opening name OR ECO code** differs (this covers both switching to
  a different opening and specializing within the same one, e.g.
  *Najdorf*, *Old Sicilian*). If the after side has no classification,
  show no label.
- Underneath the move: a **PGN continuation** that extends as far as
  it is unambiguous. The row's own move is **not repeated** in the
  continuation — it starts with the next ply. The rule applies the
  same way to every next ply — yours or the opponent's:
  - **Extend** as long as the repertoire holds exactly one move at the
    next ply.
  - **Stop on a branch** when the next ply has ≥2 moves in the
    repertoire, and list the alternatives in parentheses after the
    last unambiguous move. Each alternative carries its own move
    number prefix so the depth is unambiguous
    (e.g. `3.d4 cxd4 4.Nxd4 (4…Nf6, 4…e6, 4…a6)`).
  - **Stop at end of line** when the next ply has 0 moves in the
    repertoire. No explicit end-of-line marker is rendered — the
    absence of further plies and of a parenthesized branch is itself
    the signal.
  - **Immediate branch** is fine: if the row's own move lands straight
    on a branching node, the continuation is just the parenthesized
    alternatives (e.g. for a row showing `1.e4` from the start
    position: `(1…c5, 1…e5, 1…c6, 1…e6)`).

### Clicking any ply

Any ply shown anywhere on the page — in "How you got here", in a
continuation line, or in a parenthesized branch list — is clickable.
The clickable hit area is the **SAN only** (e.g. `e4`, `Nbd7`); the
move number prefix (e.g. `1.`, `3…`) renders adjacent to it as plain
text. Clicking navigates the Explorer to the position after that ply.

### Navigating back / refresh / sharing

The current position is reflected in the page URL, so browser **Back**
walks back through the positions the user visited, **Refresh** lands on
the same position, and the URL can be pasted into chat to share a
specific position. There is no separate breadcrumb strip — "How you got
here" already shows the path(s) through the repertoire that reach this
position.

## What Doesn't Change

- The existing `/repertoire` table and `/repertoire/variant` editor
  stay exactly as they are. Both pages read and write the same
  underlying data; edits made in one are visible in the other.
- The FSRS algorithm, the training engine, the Games page, Settings,
  Dashboard.
- Existing per-user data: repertoires, FSRS card history, exports.
- The backend.

## Implementation Decisions

These are locked in to avoid divergent inventions; everything else is
the implementer's call.

- **Single source of truth, read-only.** The Explorer reads the same
  `RepertoireData` blob via `IDataAccessLayer.retrieveRepertoireData`
  that `/repertoire` and `/training` use, and **never calls
  `storeRepertoireData`**.
- **Minimize changes to `/repertoire`.** It will be deprecated in
  later iterations; the Explorer should ship without modifying the
  existing page so the rollout carries no risk to it.
- **Reuse shared infrastructure where convenient** (these are
  app-wide modules, not `/repertoire`-specific):
  - `RepertoireGraph` — DAG, `getPathsToEdge`, `getDescendantCardKeys`.
  - `FSRSService` — card state, due, retrievability.
  - `DatabaseOpeningsUtils.ClassifyOpening` — opening name + ECO.
  - `normalizeFenResetHalfmoveClock` — FEN normalization.
  - `ChessboardControl` — board (non-interactive mode with arrows
    displayed).
  - `ProtectedRoute` — auth gating.
- **Cross-tab freshness.** Re-fetch the blob on page mount and when
  the tab regains visibility, so edits made in another tab on
  `/repertoire/variant` show up when the user returns. No live sync,
  no optimistic concurrency.
- **Find-position input parsing.** Accept either a FEN (detected via
  `isLikelyFen`) or a PGN (parse via `chess.js loadPgn`); in both
  cases compute the resulting FEN and normalize it. Look the FEN up in
  the **active orientation first**; if not found, fall back to the
  other orientation and **switch the toggle** if it's found there (so
  a Black-rep position pasted while viewing the White rep just works).
  If it's in neither, show the inline error.
- **Header nav.** Add an "Explorer" link in the global header
  alongside the other page links so the page is discoverable.
- The backend.

## Deferred (not in v1)

- Tree-shaped visualization of the repertoire.
- Text notes per position (arrows only for now).
- Theory panel (Masters + cloud eval) inside the Explorer.
- Adding/deleting moves directly inside the Explorer — v1 is
  read-and-navigate only. Editing still happens on the existing
  `/repertoire/variant` page.
- Train button / "train from this position" inside the Explorer — use
  the existing `/training` page.
- Filter / opening-name jump.
- Import / Export buttons on the Explorer toolbar (use `/repertoire`
  for those).
- Drag-and-drop reordering.
- Multi-select branch delete.
- Side-by-side comparison of two repertoires.
- "Train only positions with no theory match" mode.
- Bulk-add a top engine line in one click.
