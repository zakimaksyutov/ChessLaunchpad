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
- **Opens a dedicated full-page flow** (its own route) rather than running inline
  — see §4. It's a one-time, multi-second operation that ends in a focused review.
- **Explainer:** an always-shown "Why this?" section, like other top-priority
  rows, whose job is to earn trust. **Format it as a short, scannable list — each
  point its own line with a lead-in label/icon, not one block of prose.** The points
  below are an illustrative starting idea; the implementing agent decides the final
  list and wording:
  - **From your own games** — built from your real recent openings, not a generic book.
  - **Only what you actually play** — the same move in every one of your last several
    games at that position.
  - **Engine-checked** — every move is verified against a strong engine; unsound moves
    are dropped.
  - **Conservative by design** — when in doubt, a line is left out, so you start from
    a clean base you can rely on.
  - **You approve it** — nothing is saved until you review the result.

---

## 2. Game collection & eval enrichment

- One-time **bulk** fetch of the user's recent rated blitz/rapid games (up to
  ~2,000 per linked account, bounded by availability and a hard cap). Across
  multiple accounts the union is then sorted by recency and trimmed to the
  **most-recent ~2,000 games globally**, so the analyzed set (and the §5 download)
  stays bounded regardless of account count.
  This is a dedicated historical pull, separate from steady-state ingest. Reuse is
  at the **HTTP fetch/parse layer only** (transport + Chess.com archive fetch); the
  bulk pull and its pagination are **net-new** and do **not** go through `runIngest`
  or its first-run caps (`FIRST_RUN_LICHESS_MAX=100` / `FIRST_RUN_MAX_ARCHIVES=6`).
- **Normalize every source into one homogeneous NDJSON shape** before enrichment,
  so §3 sees a homogeneous list. Chess.com games arrive as PGN — convert them
  (reuse `parseChesscomMoves` / the existing builder machinery): derive `moves`,
  the identifiers (id/platform, color, timestamp), and an `analysis` array. Chess.com
  carries **no** per-game engine evals, so those positions are eval-filled entirely
  from the artifact at the next step.
  - *As built:* the normalized shape (`BootstrapGame`) keeps the Lichess-export
    fields §3 needs (`id`, `platform`, `color`, `createdAt`, `moves`) and a
    **position-indexed** `analysis` array where `analysis[k]` is the eval of the
    position after `k` plies, so `analysis[0]` is the start position (length =
    plies + 1). This intentionally prepends the start to Lichess's native
    per-move array so the **"before" eval of the very first move (ply 0, White)
    exists** — otherwise White's opening move could never be seeded.
- **Enrich each position** with an engine eval and write it into the game's
  `analysis[].eval` field: keep the per-game eval Lichess already provides when the
  game was analyzed, and fill the rest from our precomputed eval artifact. **The
  artifact is consulted only here, at enrichment time** — no cloud-eval calls, no
  masters lookups. Everything downstream reads evals only from `analysis[].eval`.
  Per-position precedence: **Lichess eval wins, artifact fills only gaps; exactly one
  value per position (no blending)** — so §3's soundness check is a single
  before−after pairing **within one game** (never one game's "before" paired with
  another game's "after").
- Output (and the **§3 input contract**): a **list of NDJSON games** with evals
  populated in place. This list is produced by a **single
  function** — the one and only seam between collection/enrichment and selection.
  Both the run and the §5 download go through that same function: the run feeds its
  output to §3; the download serializes the same output (ideally the very bytes the
  run used). The two therefore can never diverge. All work is client-side and
  progress-reported.

---

## 3. Selection algorithm — what we keep

Walk games into a position-keyed tree (normalized FEN, transpositions merged),
then keep a move **only when every gate passes**. Selection is a **pure function of
the §2 NDJSON list** — same input always yields the same repertoire. The defining
rule vs. the exploratory prototype: we never include a flagged/uncertain move — a
move is either trusted-in or absent, and **the first failing gate ends that branch**
(we do not guess past a point of doubt).

**At a user-move position**, include the move only if all hold:
- **Recency** — judged on the user's recent games only (current repertoire, not
  abandoned old lines).
- **Consistency** — the user's **last up-to-5 games** through this position must
  **all** play the same move, with a floor of **3 games**: if ≥5 games, the last 5
  must agree; if 3–4 games, all of them must agree; if ≤2 games, the branch stops.
  This is the sample floor and the consistency rule in one — anything short of
  unanimous over that window is not seeded.
- **Soundness** — engine eval drop under **0.3 pawns (30 cp)** — the existing
  `ok` band, below an inaccuracy. Eval values come **only from the game's
  `analysis[].eval`** (before = the prior ply's eval, after = this move's eval);
  reuse `EvalDropService`'s source-agnostic helpers `computeConservativeDrop` +
  `categorizeEvalDrop`, **not** `computeEvalDrops` (which reads the FEN-keyed
  artifact, bypassing the enriched evals). A position missing either eval is
  treated as unknown, not assumed sound. Anything worse is dropped, not flagged.

**At an opponent-move position**, branch only into replies that are both common
enough to actually face (by the user's own game frequencies) and not engine-dubious;
prune rare/bad lines and cap branching so the tree stays small.

**Stop conditions:** fewer than 3 games at a position, the consistency window is
not unanimous, soundness fails, or a depth cap (early-opening only). Bias toward
*fewer, rock-solid* lines over coverage.

Output: a proposed set of positions/moves per color, ready as new FSRS cards.

---

## 4. Flow: progress → summary → review → save

One dedicated full-page route with three consecutive states on the same page:

**State A — Progress** (cancelable, live counters). Phases:

1. **Downloading your last games** — `x / up to 2,000` per linked account (so the
   denominator scales with the number of linked accounts). The only network-bound,
   genuinely slow phase.
2. **Analyzing games** — `x / N`, where `N` is the most-recent ~2,000 games kept
   across all accounts. Parse + replay and eval lookup (the §3 gates run in the
   short finishing step below). Local-only (static eval artifact + evals already in
   the downloaded games — no per-position network), so chunk the work (or use a
   worker) to keep the counter animating and the page responsive instead of freezing.
3. **Discovering sound lines** — short finishing step (the §3 selection walk).

Optional flourish during the wait (not a separate surface): let discovered lines
visibly accumulate (e.g. "1.e4 c5 2.Nf3 … — played in 9 of your last 9 games"), so
the progress time doubles as proof of the §1 promise.

**State B — Summary.** On completion the page stops on a brief stats summary
(games analyzed, lines proposed, white/black split) rather than dropping straight
into the review. A single **Proceed to review** button advances to State C; this
gives the user a moment to absorb the outcome and makes opening the change list a
deliberate action. (Zero lines short-circuits to the empty state below instead.)

**State C — Review & save.** Reached from the summary's **Proceed to review** button:
emit the algorithm's output as a **`PendingDelta`** and reuse the **existing
`ReviewView`** — the same screen the Discard/Save flow already uses, listing the
proposed lines as PGN rows grouped/labeled by orientation (with board preview).
**Save** commits the additions to the blob and syncs; **Discard** keeps the
repertoire empty. Nothing persists until Save.

**Zero lines** is a valid conservative outcome: skip the summary and `ReviewView`
and show a brief empty state with a Back-to-dashboard exit; the §1 action stays
available to retry later.

There is no separate repertoire tree/graph view to reuse (the prototype's graph was
never ported); `ReviewView`'s added-lines list is the visualization. A richer
tree/board view would be net-new and is out of scope unless the agent finds the line
list inadequate for a large batch.

---

## 5. Debuggability

Offer a **"Download raw input"** option (behind a **"…"** overflow menu on the
bootstrap page) that saves the output of the **same producer function** the run
feeds to §3 (see §2) — the list of NDJSON games with evals in `analysis[].eval`.

Because §3 is a pure function of that list and both paths share one producer,
re-running the algorithm on the downloaded file reproduces the exact same
repertoire — every result is fully replayable and analyzable offline.

---

## Building blocks to reuse

Bulk export pipeline (`GameIngestService` fetch/parse layer only, not `runIngest`); Chess.com PGN→SAN
conversion (`parseChesscomMoves` / `GameRecordBuilder`) to normalize into the
NDJSON shape; `ExplorerEvals` (our precomputed artifact, consulted only at §2
enrichment to fill `analysis[].eval`); `EvalDropService` drop/threshold helpers
(`computeConservativeDrop`, `categorizeEvalDrop`) — **not** `computeEvalDrops`,
which reads the artifact by FEN; position-centric v3 repertoire (`Repertoires`,
`BlobCodec`); Dashboard Actions (`DashboardActions`, `getEmptyRepertoireColors`);
the existing pending-edit Save/Discard flow (`PendingEditModel` → `ReviewView`).
