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
┌── White ⇄ Black ──────────────────────────────────────────── Train ──┐
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
│ │                      │    2…Nc6 3.d4 cxd4 4.Nxd4 (Nf6, e6, a6)       │
│ │                      │                                               │
│ │                      │  ● d6    Due now   R 71%                      │
│ │                      │          8 reps · 1 lapse · last 22d ago      │
│ │                      │          → Najdorf                             │
│ │                      │    2…d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 (a6, g6)   │
│ └──────────────────────┘                                               │
│ [ Paste FEN or PGN to jump… ]                                          │
└───────────────────────────────────────────────────────────────────────┘
```

The chessboard occupies the entire left column of the page (as tall and
wide as the available space allows). The right column holds, top to
bottom: "How you got here", the opening name, then the move list
("Your moves from here" / "Opponent's replies"). On narrow viewports
the right column reflows underneath the board.

### Top: "How you got here"

- Shows the PGN path(s) from the starting position to the current FEN
  through this orientation's repertoire.
- If there are multiple paths (transpositions), show up to **3** of
  them, one per row.
- If there are more than 3, append a single line **"… N more ways"**.

### Middle: chessboard (left column)

- Occupies the **entire left column** of the page, as large as the
  available space allows.
- Shows the current position.
- Arrow annotations attached to this position are rendered. Arrows are
  drawn with the existing right-click-drag gesture. **No text notes in
  v1** — arrows only.
- Directly **under the board**, a small **"Find position"** input
  accepts either a FEN or a PGN line. The input is aligned to the
  board's width (does **not** stretch across the full page). Submitting
  it navigates the Explorer to that position. If the input cannot be
  parsed, the field shows an inline error and the board does not move.
  Placeholder: *"Paste FEN or PGN to jump…"*.

### Bottom: "Your moves from here" / "Opponent's replies"

Just above the move list, show the **opening name** classified from
the current PGN path (e.g. *Sicilian Defense (B27)*). If no opening
matches, the line is omitted.

One row per move present in the repertoire from the current position.

For each row:

- The move's SAN. For **opponent** moves, no FSRS info is shown
  (opponent moves don't have cards).
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

- An **opening label** next to the move, shown only when playing this
  move changes the classification compared to the current position —
  either switching to a different opening or specializing into a named
  sub-variation (e.g. *Najdorf*, *Old Sicilian*). If the classification
  is unchanged, no label.
- Underneath the move: a **PGN continuation** that extends as far as
  it is unambiguous — keep appending the next ply as long as there is
  exactly one move in the repertoire at that ply. When more than one
  choice exists, stop and list the available next moves in parentheses
  (e.g. `2…Nc6 3.d4 cxd4 4.Nxd4 (Nf6, e6, a6)`).

### Clicking any ply

Any ply shown anywhere on the page — in "How you got here", in a
continuation line, or in a parenthesized branch list — is clickable.
Clicking it navigates the Explorer to the position after that ply.

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

## Deferred (not in v1)

- Tree-shaped visualization of the repertoire.
- Text notes per position (arrows only for now).
- Theory panel (Masters + cloud eval) inside the Explorer.
- Adding/deleting moves directly inside the Explorer — v1 is
  read-and-navigate only. Editing still happens on the existing
  `/repertoire/variant` page.
- Filter / opening-name jump.
- Import / Export buttons on the Explorer toolbar (use `/repertoire`
  for those).
- Drag-and-drop reordering.
- Multi-select branch delete.
- Side-by-side comparison of two repertoires.
- "Train only positions with no theory match" mode.
- Bulk-add a top engine line in one click.
