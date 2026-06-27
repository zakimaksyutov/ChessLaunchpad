# Repertoire Bootstrap — Product Specification

Give a brand-new user a small, **trusted** starter repertoire built from the
openings they already play, so they can begin training immediately instead of
facing an empty board. This is a *seeding* tool, not a repertoire *auditor* — it
only adds lines we are confident about and stays silent on everything else.

---

## 1. Trigger

A new Actions-tile row on `/dashboard`:

- **Label:** "Build your starter repertoire from your games".
- **Availability:** only while a color's repertoire is empty; it targets the
  empty color(s). Hidden once both colors have positions.
- **Priority:** top of the tile when available (a user with no repertoire has
  nothing else to do) — outranks Start Training, Review games, etc.
- **Explainer:** an always-shown "Why this?" section, like other top-priority
  rows, whose job is to earn trust. Emphasize:
  - Built only from *your own recent games* — your real openings, not a generic book.
  - Keeps only moves you play **consistently** (the same move in every one of your
    last several games at that position).
  - Every move is checked against a strong engine — unsound moves are dropped.
  - **Conservative by design:** when in doubt, a line is left out, so you start
    from a clean base you can rely on.
  - Nothing is saved until you review and approve it.

---

## 2. Game collection & eval enrichment

- One-time **bulk** fetch of the user's recent rated blitz/rapid games (target
  up to ~2,000, bounded by availability and a hard cap), per linked account.
  This is a dedicated historical pull, separate from steady-state ingest, reusing
  the existing Lichess/Chess.com export pipeline.
- Enrich each position with an engine eval from our precomputed eval artifact,
  plus the per-game eval Lichess provides when a game was analyzed. No cloud-eval
  calls and no masters lookups.
- All work is client-side and progress-reported; results feed Section 3 in memory.

---

## 3. Selection algorithm — what we keep

Walk games into a position-keyed tree (normalized FEN, transpositions merged),
then keep a move **only when every gate passes**. The defining rule vs. the
exploratory prototype: we never include a flagged/uncertain move — a move is
either trusted-in or absent, and **the first failing gate ends that branch** (we
do not guess past a point of doubt).

**At a user-move position**, include the move only if all hold:
- **Recency** — judged on the user's recent games only (current repertoire, not
  abandoned old lines).
- **Consistency** — the user's **last up-to-5 games** through this position must
  **all** play the same move, with a floor of **3 games**: if ≥5 games, the last 5
  must agree; if 3–4 games, all of them must agree; if ≤2 games, the branch stops.
  This is the sample floor and the consistency rule in one — anything short of
  unanimous over that window is not seeded.
- **Soundness** — engine eval drop under **0.3 pawns (30 cp)** — the existing
  `ok` band, below an inaccuracy — using our precomputed artifact and the per-game
  Lichess eval when present. A position with no eval data is treated as unknown,
  not assumed sound. Anything worse is dropped, not flagged.

**At an opponent-move position**, branch only into replies that are both common
enough to actually face (by the user's own game frequencies) and not engine-dubious;
prune rare/bad lines and cap branching so the tree stays small.

**Stop conditions:** fewer than 3 games at a position, the consistency window is
not unanimous, soundness fails, or a depth cap (early-opening only). Bias toward
*fewer, rock-solid* lines over coverage.

Output: a proposed set of positions/moves per color, ready as new FSRS cards.

---

## 4. Review & save

- Present the proposal as a **read-only preview of the resulting repertoire**
  (reuse the existing board + line/tree view), grouped by color, so the user sees
  exactly the lines that will be added.
- Terminate in the existing **Discard / Save** flow (the same pending-edit /
  approval mechanism used elsewhere) — Save commits the additions to the blob and
  syncs; Discard keeps the repertoire empty. Nothing persists until Save.

---

## Building blocks to reuse

Bulk export pipeline (`GameIngestService` / Lichess export); `ExplorerEvals` (our
precomputed artifact) + `EvalDropService` for soundness; per-game Lichess evals
from the export; position-centric v3 repertoire (`Repertoires`, `BlobCodec`);
Dashboard Actions (`DashboardActions`, `getEmptyRepertoireColors`); the existing
pending-edit Save/Discard flow.
