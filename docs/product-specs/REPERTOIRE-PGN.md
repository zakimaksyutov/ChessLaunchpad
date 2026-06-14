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
- **Atomic**: invalid PGN, illegal SAN, multiple games in the file, or a
  missing/invalid `[Repertoire]` header rejects the whole import without
  modifying any state.

## UI

On the Explorer page (`/explorer`), an overflow menu (`⋯`) sits to the
right of the **Edit repertoire** button with two items:

- **Export PGN** — downloads the current orientation's repertoire as
  `.pgn`.
- **Import PGN** — opens a file picker; on selection, merges into the
  repertoire identified by the file's `[Repertoire]` header (see Import
  behavior).

Additionally, the page hosts a **PGN paste box** — a labeled textarea
plus an **Import PGN** button, modeled on lichess's "Import PGN" widget
— that runs the same import flow on pasted text. A typical use is
pasting a new variation in Edit mode.

The `⋯` menu and the paste box are available in both **Read** and **Edit**
modes. In Read mode the import merges directly. In Edit mode the import
is staged into the pending delta, so the user reviews it via the existing
**Review & Save** workflow before committing (or discards it).

## Out of scope

- FSRS card state.
- The other repertoire (each export/import is one color).
- Settings, activity, games-ingest state, audit.
- Custom non-standard PGN markers — the file must remain portable to other
  tools.
