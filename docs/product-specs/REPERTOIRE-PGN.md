# Repertoire ↔ PGN Export / Import

Export a single repertoire (White or Black) as a standard `.pgn` file and
import one back. Peer feature to the existing `.chess` export/import on the
Settings page — not a replacement. `.chess` remains the only full-fidelity
backup (both repertoires, FSRS state, settings, activity).

## Goal

Round-trip the **position DAG and per-position annotations** of one
repertoire. Exporting then importing into the same (empty) color must
reproduce the same positions, the same SAN edges at each position, and the
same annotations.

FSRS card state is **not** carried on the wire. Newly added user-turn edges
get a fresh `New` card via the normal `normalize()` pass.

## On-disk shape

A single `.pgn` file with one PGN game. A `[Repertoire "White"|"Black"]`
header identifies the target color. Everything else is standard PGN that
opens unchanged in lichess Studio, ChessBase, SCID.

- Movetext = main line + `(…)` variations covering every SAN edge in the
  repertoire (user and opponent moves alike).
- The DAG is rendered as a **spanning tree**: each FEN's outgoing moves are
  emitted once, at first visit; repeat visits stop silently. FEN
  normalization on import re-merges transpositions.
- **Annotations** use the standard lichess/ChessBase comment format —
  `{[%cal Ge2e4][%csl Yf7]}` — placed after the SAN that reaches the FEN
  whose annotations they belong to (or as a starting comment for the root).
  Brushes G/Y/R/B map 1:1 with the in-app `Annotation['brush']`.

## Import behavior

- **Merge into the color named by the file's `[Repertoire]` header.** The
  other repertoire is untouched.
- Existing positions and FSRS cards are preserved; new edges and positions
  are added.
- **Annotations replace** the existing ones at a FEN **only when** the
  imported PGN attaches a comment containing at least one `[%cal …]` or
  `[%csl …]` token at that position. Empty comments, plain-text comments,
  and the absence of a comment all leave existing annotations untouched.
  Consequence (intentional asymmetry): a PGN import can add or replace
  annotations but cannot clear them; a round-trip cannot remove an
  annotation set that was added between export and import. To clear
  annotations, edit them on the board.
- **Atomic**: invalid PGN, illegal SAN, multiple games in the file, a
  missing/invalid `[Repertoire]` header, or a non-standard starting
  position (`[FEN]` / `[SetUp]` present) rejects the whole import without
  modifying any state. Repertoires always root at the standard starting
  position.

## UI

On the Explorer page (`/explorer`), an overflow menu (`⋯`) sits to the
right of the **Edit repertoire** button with one item:

- **Export PGN** — downloads the current orientation's repertoire as
  `.pgn`.

PGN **import** lives **in Edit mode only**, in a section below the
board:

- A labeled textarea + **Import PGN** button (lichess-style paste box)
  imports a PGN snippet from text.
- A **From a PGN file** button next to it opens a file picker that imports a
  saved `.pgn`.

Both routes funnel through the same import logic and stage changes into
the pending delta so the user reviews them via the existing
**Review & Save** workflow before committing (or discards them).

The whole import section is intentionally Edit-only: importing in Read
mode would commit straight to the persisted blob with no review step.
Users who want to import a `.pgn` enter Edit mode first.

The section is scoped to the orientation being edited: a pasted
movetext snippet without a `[Repertoire]` header is treated as
belonging to that orientation (typical use: paste a fresh variation
from lichess or ChessBase while editing). If a pasted or loaded PGN
carries a `[Repertoire]` header that names the **other** color the
import is rejected with a clear message (Save or Discard first, then
re-import).

The `⋯` menu is available in both **Read** and **Edit** modes, but
**Export PGN is disabled in Edit mode** (the user must Save or Discard
first, parallel to how the header nav is disabled). The menu item
names the active orientation explicitly — "Export **White** PGN" — so
the user always knows which repertoire they're acting on.

In Edit mode the pending delta is scoped to a single orientation: if the
imported PGN's `[Repertoire]` header names the **other** color, the
import is rejected with a clear message (the user can Save or Discard
first, then re-import).

## Out of scope

- FSRS card state.
- The other repertoire (each export/import is one color).
- Settings, activity, games-ingest state, audit.
- Custom non-standard PGN markers — the file must remain portable to other
  tools.
