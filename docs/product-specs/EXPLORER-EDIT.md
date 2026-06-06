# Explorer Editing — Product Specification

Add an in-place editing surface to `/explorer`. Becomes the only
in-app way to mutate the move graph; `Import / Export` in Settings
stays for bulk seed and backup.

## The Idea

A pill toggle on the Explorer header flips **Read ⇄ Edit**. Read
mode is byte-for-byte today's Explorer. Edit mode lets the user:

- **Add a move** by playing it on the board.
- **Delete a move** from the "Your moves from here" row.
- **Draw or clear annotations** (arrows and square highlights) on the
  current position, directly on the board.

Edits do not save immediately — they **accumulate into a pending
delta** which the user reviews and commits in a single **Save**.

Deleting a move drops the edge. Any descendant position that is no
longer reachable from the start position goes with it; transpositions
keep what they reach.

Annotations are per-position. Editing them does not affect the move
graph and does not interact with transposition pruning.

## Review & Save

A sticky bar shows *"N added · K removed · M changed — Review & Save
· Discard"* whenever the delta is non-empty (categories that are zero
are omitted). Counts are of **moves that will appear in / disappear
from the saved blob**, not of user clicks:

- `removed` includes descendants pruned by the transposition-aware
  reachability check. Deleting one edge that drops a 7-move branch
  shows as `8 removed`, not `1 removed`, so the magnitude of a
  cascade is visible without opening the Review dialog.
- `added` counts each new move; building a 10-ply line one drop at a
  time shows as `10 added`.
- `changed` counts positions whose annotation set differs from the
  saved state. **Annotations are compared as a set** — order doesn't
  matter and duplicates are collapsed, so clearing the annotations
  and redrawing the same ones in a different order is not a change.
  Drawing three arrows and clearing one on the same position is one
  change to that position, not four.

**Review** swaps the Explorer's board and move-list for a full-page
Review view with three lists — **Added**, **Removed**, **Edited** —
each scrollable, each empty-list omitted entirely. The page is sized
to the viewport; this is not a modal dialog (boards with arrows and
side-by-side annotation comparisons need real estate, and the user
should be free to take their time).

- **Added** and **Removed** rows have the same shape: a small board
  showing the position *before* the move, with the move drawn as an
  arrow, plus the PGN path from the start position and the position's
  FEN.
- **Chain collapsing** applies symmetrically to **Added** and
  **Removed**. A *chain* is a maximal sequence of newly-added (or
  cascade-pruned) edges along a single path; branching splits into
  separate chains. A length-1 chain renders as a plain row. A
  length-≥2 chain renders one row showing the **head**'s parent
  board + the head's arrow + the PGN of the whole chain, with a
  **"+N more"** badge and a chevron to expand. Expanded view shows
  every move in the chain on its own row in the same shape as a
  length-1 row. For Removed chains the user-clicked deletion is
  always the head; cascade-pruned descendants are the tail.
- **Edited** rows render two boards side by side for the same
  position: the saved annotations on the left, the staged annotations
  on the right, with the PGN path and FEN above. Annotations are the
  only thing being compared — the position itself is identical on
  both sides.

Totals on the sticky bar match the totals across all rows expanded —
i.e., `removed` counts every edge in every chain, and `added` does
the same.

### Transpositions

Transpositions are where the user's mental model ("I'm working on a
line") and the data model (positions, reachability) diverge most, so
the Review view calls them out at chain tails:

- **Deleted chain ends at a surviving position.** The cascade
  stopped because some position downstream is still reachable from
  another path. The tail row reads e.g. *"stopped at Sicilian Nc3 —
  still reachable via 1.e4 c5 2.Nc3 e5 3.Nf3."* Tells the user their
  deeper prep is safe.
- **Added chain ends at an existing position.** The new edges merged
  into an already-known subtree rather than building a fresh leaf.
  The tail row reads e.g. *"joins existing subtree — 24 moves
  below."* Tells the user they didn't have to re-enter that prep.

Both annotations are computed from the same reachability check that
drives chain construction; neither requires extra user input.

The view answers the two questions the user has at Save time: "is
this what I meant to do?" and "did a delete take more of the tree
with it than I realized?". **Save** writes the new state and returns
to Read mode. **Discard** drops the delta and returns to Read mode.
**Cancel** (or browser Back) returns to Edit mode with the delta
intact.

The unit of work is a session of edits, not an individual edge. The
user can build a 10-move line, prune a dead branch, and commit it in
one transaction.

## Constraints

- **Training is disabled while edits are pending.** A tooltip prompts
  the user to Save or Discard first. This keeps repertoire edits and
  FSRS card updates from racing on the same blob.
- **The delta is in-memory.** A hard refresh or closing the tab loses
  it; the browser warns before unload.
- **Concurrent edits from another tab.** If the blob changed
  elsewhere since the page loaded, Save is refused and the user is
  prompted to refresh (which discards local edits).

## What Doesn't Change

- Read-mode Explorer (board, "How you got here", move list,
  classification, URL format, navigation).
- The trainer, Games page, Dashboard, Settings, login.
- Import / Export.

## Out of Scope

- Bulk PGN paste / "extend from here."
- Adding moves suggested by Masters, an engine, or the Games page.
- Multiple repertoires per orientation.
- Persisting the pending delta across reloads.
- Merging concurrent edits instead of refusing them.
