# Explorer — Product Specification

The page at `/explorer` is the user's home for browsing and editing
their opening repertoire one position at a time. It is the only
in-app surface for managing the repertoire tree; bulk seed and backup
live in Settings as Import / Export.

## The Idea

**The Explorer thinks in positions, not variants.** The user is
always looking at a position on a board. From that position they can
see how they got there (the PGN paths through the repertoire that
reach this position), which moves they have covered next, and — in
Edit mode — add a move by playing it on the board, delete a move from
the list, or draw arrows and square highlights as study notes.

Transpositions are first-class: one position has one set of "next
moves" regardless of how many PGN sequences arrive at it, so coverage
gaps and surviving prep are both visible at a glance.

## Read Mode

- **Orientation toggle** picks the side (White or Black) the user is
  studying. Persisted per user. Toggling keeps the current position
  if it is reachable in the other orientation, otherwise snaps to the
  start position.
- **Chessboard** (left column, square, non-interactive) shows the
  current position with any saved arrows and square highlights.
- **"How you got here"** lists the PGN paths from the start position
  to the current FEN through the active orientation's repertoire,
  shortest first. Capped for readability; transposition-heavy
  positions show an overflow count instead of hanging.
- **Opening name** classified from the current PGN (e.g.
  *Sicilian Defense (B27)*) renders above the move list.
- **Move list** ("Your moves from here" / "Opponent's replies" by
  side to move). Each row shows the SAN, an unambiguous PGN
  continuation that extends until it branches or ends — branches are
  shown as parenthesized alternatives — plus a small opening-label
  chip when the move changes the classification. Your-turn rows also
  carry an FSRS cluster (state, due, retrievability, reps/lapses,
  last reviewed) so the user can tell at a glance how well the move
  is known and when it is next due.
- **Find position** input under the board accepts a FEN or a PGN and
  jumps to that position if it lives in the repertoire; in Read mode
  it falls through to the other orientation (and flips the toggle) if
  the position is only there.
- **Clicking any ply** anywhere on the page jumps the board to the
  position after that ply. The current position lives in the URL, so
  browser Back walks the history, Refresh lands on the same position,
  and the URL can be shared.

The Explorer never renders an off-repertoire position: an unknown
shared URL snaps to the start position with a brief explanatory
toast. The page refetches the blob on visibility change so edits made
in another tab (or by background game ingestion) show up when the
user returns.

## Edit Mode

A green **Edit repertoire** button on the toolbar promotes the page
into Edit mode. The orientation toggle is hidden — editing is scoped
to a single repertoire per session. Edit mode is available from any
state, including an empty repertoire. In Edit mode:

- **Play a move on the board to add an edge.** The board
  auto-navigates to the resulting position so the user can keep
  building a line. New user-turn moves get a fresh **New** FSRS card;
  if the same edge is deleted and re-added within a session, the
  original card is resurrected rather than reset.
- **Delete a move** via the × on its row. Descendant positions that
  are no longer reachable from the start are pruned along with their
  cards; positions still reachable via another path survive untouched.
- **Annotations** (arrows and square highlights) are edited directly
  on the board using the chessboard's native right-click gestures.
  Annotations are compared as a set — order and duplicates do not
  count as changes.

The **Find position** input is still available but only searches the
active orientation (no toggle to flip while editing).

Edits accumulate into an **in-memory pending delta**. Training is
blocked while a delta is open (a tooltip prompts to Save or Discard
first); navigating away from `/explorer` mid-edit prompts before
abandoning. The delta is tab-local — a hard refresh, tab close, or
discarded navigation loses it.

### Review & Save

The Edit-mode toolbar shows an inline bar with the change counts
(`N added · K removed · M changed`, omitting zero categories) plus
**Review & Save** and **Discard** buttons. Counts reflect what will
appear in or disappear from the saved blob — a delete that cascades
through a seven-move branch shows as eight removed, not one.

**Review & Save** opens a full-page view with three sections — Added,
Removed, Edited. Sequential edits along the same line collapse into
chains the user can expand; positions reachable by multiple paths
are labeled with their canonical (shortest, lex-tiebreak) PGN.
Chain tails call out transposition consequences: a deletion that
stopped because a descendant is still reachable elsewhere, or an
addition that joined an existing subtree, are both annotated inline
so the user understands what their edit actually did.

**Save** writes the new blob (refusing on a concurrent-edit conflict,
where the user is prompted to refresh and lose local edits).
**Discard** drops the delta after confirmation. **Cancel** / browser
Back from Review returns to Edit mode with the delta intact.
