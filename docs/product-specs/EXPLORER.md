# Explorer — Product Specification

The page at `/explorer` is the user's home for browsing and editing
their opening repertoire. It is the only in-app surface for managing
the repertoire tree; bulk seed and backup live in Settings as
Import / Export.

## The Idea

The Explorer thinks in **positions, not variants**. The user is
always looking at a position on a board, sees the PGN paths that
reach it, the moves they have prepared from it, and — in Edit mode —
edits the tree by playing on the board itself. Transpositions are
first-class: one position has one set of next moves regardless of
how many sequences arrive at it.

## Read Mode

- **Orientation toggle** picks the side being studied; persisted per
  user. Toggling preserves the current position when possible,
  otherwise snaps to the start.
- **Board** (non-interactive) shows the position with any saved
  arrows and square highlights.
- **"How you got here"** lists the canonical PGN paths from the start
  position to the current FEN, shortest first, capped for readability.
  A **Home · Back · Forward** toolbar leads the section: Home jumps to
  the start, while Back/Forward step through the positions visited
  inside Explorer during the session.
- **Opening name** classified from the current PGN appears above the
  move list.
- **Move list** — "Your moves from here" or "Opponent's replies" by
  side to move — shows each move with an unambiguous PGN continuation
  (branches as parenthesized alternatives) and an opening-label chip
  when the move changes the classification. Your-turn rows also
  carry an FSRS cluster (state, due, retrievability, reps/lapses,
  last reviewed).
- **Find position** input accepts a FEN or PGN and jumps to that
  position; in Read mode it falls through to the other orientation
  (and flips the toggle) if the position only lives there.
- **Click any ply** anywhere on the page to jump there. Position is
  in the URL, so Back, Refresh, and link-sharing all work.
- **Export PGN** (from a `⋯` menu next to **Edit repertoire**)
  downloads the current orientation as a standard `.pgn` with a
  `[Repertoire "White"|"Black"]` header. Disabled while editing.

Unknown shared URLs snap to the start position with a brief toast.
The page refetches on visibility change so cross-tab edits show up.

## Edit Mode

A green **Edit repertoire** button promotes the page into Edit mode;
the orientation toggle is hidden because editing is scoped to one
repertoire per session.

- **Add** by playing a move on the board — the page auto-navigates
  to the new position. New user-turn moves get a fresh **New** FSRS
  card; deleted-then-re-added moves keep their original card.
- **Delete** via the × on a move row. Descendants no longer reachable
  from the start are pruned with their cards; transposition-protected
  positions survive.
- **Annotations** (arrows, square highlights) are drawn directly on
  the board with the chessboard's native right-click gestures.
- **Import PGN** (paste a snippet or pick a `.pgn` file, scoped to
  the orientation being edited) stages into the pending delta: SAN
  moves union with the existing tree; per-position annotations
  replace only when the PGN carries a `[%cal …]`/`[%csl …]` comment
  tag. FSRS state is not carried — new user-turn edges become fresh
  `New` cards on Save.

Edits accumulate into an **in-memory, tab-local pending delta**.
While Edit mode is active every header menu item (title, nav links,
username dropdown) is disabled — the user must Save or Discard to
exit Edit mode before navigating anywhere. Browser back/forward and
tab close still prompt before abandoning unsaved changes.

### Review & Save

The Edit toolbar shows live counts (`N added · K removed · M
changed`) plus **Review & Save** and **Discard**. Counts reflect what
will appear in or disappear from the saved blob, so a delete that
cascades through a seven-move branch shows as eight removed.

**Review & Save** opens a full-page view with three sections —
Added, Removed, Edited — where co-linear edits collapse into
expandable chains. Chain tails call out transposition consequences:
a deletion stopped by a still-reachable descendant, or an addition
that joined an existing subtree, are both annotated inline. Added
and Edited tiles carry an **Open in Explorer** link that jumps to
that position in the main Edit view (the pending delta is preserved);
Removed tiles omit it since the position no longer exists.

**Save** writes the new blob (refusing on a concurrent-edit
conflict, prompting the user to refresh and lose local edits).
**Discard** drops the delta after confirmation. **Cancel** / Back
from Review returns to Edit mode with the delta intact.
