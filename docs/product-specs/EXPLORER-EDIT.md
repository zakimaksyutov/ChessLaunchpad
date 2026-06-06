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
are omitted). Counts are of **user actions on distinct units**:

- `added` / `removed` count individual moves; a delete that cascades
  through transpositions still counts as one removal.
- `changed` counts positions whose annotation set differs from the
  saved state — drawing three arrows and clearing one on the same
  position is one change to that position, not four.

**Review** opens a list of the pending changes (added lines, removed
lines with a count of pruned descendants per removal, positions with
changed annotations) so the user can confirm the edits are
intentional — especially that a delete didn't drop more of the tree
than expected. **Save** writes the new state. **Discard** drops the
delta.

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
