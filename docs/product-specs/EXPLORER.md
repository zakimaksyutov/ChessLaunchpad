# Explorer — Product Specification

The page at `/explorer` is the user's home for browsing and editing
their opening repertoire one position at a time. It is the only
in-app surface for managing the repertoire tree; bulk seed and backup
live in Settings as Import / Export.

## The Idea

**The Explorer thinks in positions, not variants.** The user is
always looking at *a position on a board*. From that position they can
see how they got there (the PGN paths through the repertoire that
reach this position), which moves they have covered next, and — in
Edit mode — add a move by playing it on the board, delete a move from
the list, or draw arrows and square highlights as study notes.

Transpositions are first-class: one position has one set of "next
moves" regardless of how many PGN sequences arrive at it, so coverage
gaps and surviving prep are both visible at a glance. This matches
what the rest of the app already does — FSRS cards, eval-drop
highlighting, and game annotation all key off positions, not variants.

## What the Page Looks Like

```
┌── White ⇄ Black ─────────────────────────────── [ Edit repertoire ] ─┐
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

The top toolbar in Read mode shows the **White ⇄ Black** orientation
toggle on the left and a green **Edit repertoire** CTA on the right.
In Edit mode the toolbar is replaced by an inline edit bar that spans
the column with counts on the left and **Review & Save** / **Discard**
actions on the right (see *Editing the Repertoire* below).

### Orientation toggle

The toggle defaults to White on first load (persisted per user across
sessions); toggling keeps the current position if it is also reachable
in the other orientation's repertoire, otherwise snaps to the start
position; for an empty repertoire the start position renders normally
with an empty move list and a "no lines in your {orientation}
repertoire yet" hint.

The toggle is **hidden while in Edit mode** — editing is scoped to a
single repertoire per session so the user cannot accidentally split a
delta across two repertoires.

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

Edit mode is **not** encoded in the URL: a shared `/explorer?…` link
always opens in Read mode for the recipient.

When the tab regains visibility the Explorer re-fetches the blob in
the background so edits made in another tab (or by background game
ingestion) show up when the user returns. The re-fetch is suppressed
while an Edit session is open so the snapshot the user is editing
against doesn't change under their feet — concurrent edits are handled
by the ETag conflict path described in *Editing the Repertoire*.

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
- **Read mode:** arrow / square-highlight annotations attached to this
  position are displayed but **read-only** (right-click drawing is
  suppressed). The board is non-interactive.
- **Edit mode:** the board is interactive — playing a legal move on it
  adds an edge to the repertoire (see *Adding moves*), and the
  chessboard's native annotation gestures (right-click drag for an
  arrow, right-click a square for a highlight, modifier keys to pick
  a brush color, click an existing arrow to clear it) edit the
  position's annotation set. No separate brush or color picker UI.
- Directly **under the board**, a small **"Find position"** input
  accepts either a FEN or a PGN line. The input is aligned to the
  board's width (does **not** stretch across the full page).
  - In Read mode, submitting it navigates the Explorer to that position
    if it is reachable in *either* orientation's repertoire — the
    active orientation is tried first, and on miss the other
    orientation is tried with the toggle switched automatically (so a
    Black-rep position pasted while viewing the White rep just works).
  - In Edit mode the cross-orientation fallthrough is suppressed: the
    input only searches the active orientation, since the toggle is
    hidden while editing. On a miss the input shows *"Not in your
    {orientation} repertoire (exit Edit to search the other side)."*
  - If the position is in neither (or the input failed to parse), the
    field shows an inline error (e.g. *"Not in your White
    repertoire."*) and the board does not move.
  - Placeholder: *"Paste FEN or PGN to jump…"*.

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
reply from here yet."* for opponent-turn positions. In Edit mode the
empty state is followed by a hint: *"Drag a piece on the board to add
a move."*

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
  for **(current PGN)** and for **(current PGN + this move)**. Show
  the after-label if the **opening name OR ECO code** differs (this
  covers both switching to a different opening and specializing within
  the same one, e.g. *Najdorf*, *Old Sicilian*). If the after side has
  no classification, show no label.
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
- In Edit mode each row also carries a small **delete** affordance
  (×) that prunes the edge (see *Deleting moves* below). The delete
  affordance is present on both your-move and opponent-reply rows —
  pruning semantics are identical on either side.

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
position. Edit mode is tab-local and not part of the URL, so any Back
within `/explorer` stays in Edit mode (the delta is preserved); see
*Constraints* below for navigation away from the page.

## Editing the Repertoire

A green **Edit repertoire** button on the toolbar (right side of the
same row as the White ⇄ Black toggle) promotes the page into **Edit
mode**. Read mode is byte-for-byte the page described above. Edit
mode lets the user:

- **Add a move** by playing it on the board. The Explorer
  auto-navigates onto the resulting position so the user can keep
  building a line.
- **Delete a move** from any move row — both *Your moves from here*
  and *Opponent's replies*. Pruning semantics are identical on
  either side.
- **Draw or clear annotations** (arrows and square highlights) on the
  current position, directly on the board.

Edits do not save immediately — they **accumulate into a pending
delta** which the user reviews and commits in a single **Save**.

Edit mode is available from any Explorer state, including an **empty
repertoire**: the user clicks **Edit repertoire** on the start
position and drops moves directly from there.

### Adding moves

Playing a legal move on the board adds an edge `(currentFen --san-->
nextFen)` to the active orientation's working copy. If the edge
already exists the operation is a no-op. After every drop the
Explorer **auto-navigates** to `nextFen` so the user can keep
building.

Adding a new user-turn move creates a fresh **New** FSRS card for that
edge as part of the delta — kept in memory until Save, dropped on
Discard. This keeps the in-memory invariant "every user-turn edge has
a card" intact, which the rest of the app relies on. If the same edge
is deleted-then-re-added inside one session, the original card is
**resurrected** rather than reset to New — the user's review history
survives accidental edits.

### Deleting moves

The × on a move row drops the edge. Any descendant position that is
no longer reachable from the start position goes with it
(transposition-protected positions survive untouched). Cards travel
with their position: cards inside a pruned subtree disappear with it;
cards on transposition-protected positions survive untouched.

### Annotations

Annotations are per-position. Editing them does not affect the move
graph and does not interact with transposition pruning. Annotations
are compared as a **set** — order doesn't matter and duplicates are
collapsed, so clearing the annotations and redrawing the same ones in
a different order is **not** a change. Drawing three arrows and
clearing one on the same position is one change to that position, not
four.

### Constraints

- **Training is disabled while edits are pending.** The header's
  Training link dims and shows a tooltip prompting the user to Save
  or Discard first. This keeps repertoire edits and FSRS card updates
  from racing on the same blob. **Background game ingestion is *not*
  gated** — it runs as usual on Dashboard mount or via the manual
  Sync button. If an ingestion lands while Edit mode is open, it
  bumps the ETag and the user's Save surfaces the same
  refresh-or-stay conflict prompt as another-tab edits (below).
- **The delta is in-memory and tab-local.** A hard refresh, a tab
  close, or navigating to a different route loses it; the browser
  warns before unload and the header / in-page link interceptor
  prompts before any imperative navigation away from `/explorer`.
  Navigating between positions inside `/explorer` does **not** clear
  the delta and does **not** fire the unload warning — it's a
  page-local state change.
- **Concurrent edits from another tab.** Conflict detection uses the
  blob's existing **ETag / `If-Match`** flow. The Explorer captures
  the ETag on load and sends `If-Match` on Save; a 412 response means
  another writer (other tab, ingestion, training session) updated the
  blob, and the user is prompted to refresh — which discards local
  edits.

### Review & Save

The Edit-mode toolbar replaces the **Edit repertoire** CTA with an
**inline edit bar** in the same slot. The bar is **always visible
while in Edit mode**, even at zero pending changes — so the
Save/Discard controls do not pop in and out as the user makes their
first edit.

The bar shows *"N added · K removed · M changed"* (categories that
are zero are omitted) plus a **Review & Save** button and a
**Discard** button. When the delta is empty the counts read
*"No pending changes"* and **Review & Save** is disabled (with a
tooltip *"Make a change to enable"*); **Discard** stays enabled and
acts as the exit affordance back to Read mode (it short-circuits the
confirmation prompt because there is nothing to discard).

Counts are of **moves that will appear in / disappear from the saved
blob**, not of user clicks:

- `removed` includes descendants pruned by the transposition-aware
  reachability check. Deleting one edge that drops a 7-move branch
  shows as `8 removed`, not `1 removed`, so the magnitude of a
  cascade is visible without opening the Review dialog.
- `added` counts each new move; building a 10-ply line one drop at a
  time shows as `10 added`.
- `changed` counts positions whose annotation set differs from the
  saved state (set-equality semantics — see *Annotations* above).

**Review** swaps the Explorer's board and move-list for a full-page
Review view with three lists — **Added**, **Removed**, **Edited** —
each scrollable, each empty-list omitted entirely. The page is sized
to the viewport; this is not a modal dialog (boards with arrows and
side-by-side annotation comparisons need real estate, and the user
should be free to take their time).

- **Added** and **Removed** rows have the same shape: a small board
  showing the position *before* the move, with the move drawn as an
  arrow (green for Added, red for Removed), plus the PGN path from
  the start position and the position's FEN.
- **Chain collapsing** applies symmetrically to **Added** and
  **Removed**. A *chain* is a maximal sequence of newly-added (or
  cascade-pruned) edges along a single path; branching splits into
  separate chains. A length-1 chain renders as a plain row. A
  length-≥2 chain renders one row showing the **head**'s parent
  board + the head's arrow + the PGN of the whole chain, with a
  **"+N more"** badge that expands to reveal every move in the chain
  on its own row in the same shape as a length-1 row. For Removed
  chains the user-clicked deletion is always the head;
  cascade-pruned descendants are the tail.
- **Edited** rows render two boards side by side for the same
  position: the saved annotations on the left, the staged annotations
  on the right, with the PGN path and FEN above. Annotations are the
  only thing being compared — the position itself is identical on
  both sides.

For positions reachable by multiple PGN paths (transpositions), every
row uses the **canonical path** — shortest, ties broken
lexicographically by SAN — same convention as Explorer's "How you got
here." One position has one path label, everywhere.

Totals on the inline edit bar match the totals across all rows
expanded — i.e., `removed` counts every edge in every chain, and
`added` does the same.

#### Transpositions

Transpositions are where the user's mental model ("I'm working on a
line") and the data model (positions, reachability) diverge most, so
the Review view calls them out at chain tails:

- **Deleted chain ends at a surviving position.** The cascade
  stopped because some position downstream is still reachable from
  another path. The tail row reads e.g. *"stopped at a surviving
  position — still reachable via 1.e4 c5 2.Nc3 e5 3.Nf3."* Tells the
  user their deeper prep is safe.
- **Added chain ends at an existing position.** The new edges merged
  into an already-known subtree rather than building a fresh leaf.
  The tail row reads e.g. *"joins existing subtree — 24 moves
  below."* Tells the user they didn't have to re-enter that prep.

Both annotations are computed from the same reachability check that
drives chain construction; neither requires extra user input.

#### Save / Discard / Cancel

The Review view answers the two questions the user has at Save time:
"is this what I meant to do?" and "did a delete take more of the tree
with it than I realized?".

- **Save** writes the new state, clears the delta, and returns to
  Read mode. On a 412 ETag conflict it prompts the user to refresh
  (discarding local edits) or keep editing.
- **Discard** drops the delta and returns to Read mode. It prompts
  for confirmation when the delta is non-empty — it's destructive
  and silent loss is not acceptable. At zero pending changes there
  is nothing to discard, so the same button exits Edit mode silently
  and serves as the Edit-mode escape hatch.
- **Cancel** and **browser Back** are equivalent: both return from
  Review to Edit mode with the delta intact, and both stay within
  `/explorer`.
- **Save**, **Cancel**, and **browser Back** never prompt — they are
  either committing or non-destructive. Tab close, hard refresh, or
  navigation to a different route rely on the browser's
  `beforeunload` warning plus the in-page interceptor described in
  *Constraints* above.

The unit of work is a session of edits, not an individual edge. The
user can build a 10-move line, prune a dead branch, and commit it in
one transaction. Save is enabled whenever the delta is non-empty,
regardless of which categories are populated — an annotation-only
session (only `M changed`) saves through the same path as any other.

## What Doesn't Change

- The FSRS algorithm, the training engine, the Games page, Settings,
  Dashboard.
- Existing per-user data: repertoires, FSRS card history, exports.
- Import / Export — these live in Settings for bulk seed and backup.
- The backend.

## Deferred (not in v1)

- Tree-shaped visualization of the repertoire.
- Text notes per position (arrows and square highlights only for now).
- Theory panel (Masters + cloud eval) inside the Explorer.
- Train button / "train from this position" inside the Explorer — use
  the existing `/training` page.
- Filter / opening-name jump.
- Import / Export buttons on the Explorer toolbar (use Settings for
  those).
- Drag-and-drop reordering.
- Multi-select branch delete.
- Side-by-side comparison of two repertoires.
- "Train only positions with no theory match" mode.
- Bulk-add a top engine line in one click.
- Bulk PGN paste / "extend from here."
- Adding moves suggested by Masters, an engine, or the Games page.
- Multiple repertoires per orientation.
- Persisting the pending delta across reloads.
- Merging concurrent edits instead of refusing them.
