# Backlog

Items here are tracked but not currently scheduled. Move to the appropriate spec or open an issue when picked up.

## FSRS

### Exact due dates when retention hasn't changed

`FSRSService.computeDueDate` currently recomputes the due date from `(lastReview, stability, currentRetention, currentMaxInterval)`. Our standalone formula can't perfectly mirror ts-fsrs's short-term scheduler (which bumps `good_interval ≥ hard_interval + 1` using a hypothetical `hard_stability` we don't store), so the recomputed due date drifts ±1 day from what ts-fsrs originally scheduled — even when the user hasn't touched retention.

**Fix:** stamp each card with the `request_retention` (and optionally `max_interval`) used at scheduling time. When `computeDueDate` sees that stamp matches the current settings, return the stored `card.d` verbatim (exact). Only fall back to the approximate formula when the stamp differs (retention/preset changed). Worst-case approximation window per card is one interval; the next review re-anchors the card to ts-fsrs's authoritative `d`.

**Wire-format option:** only emit the stamp when it differs from the blob's `settings.retention`, so the happy path stays at 10-element packed cards.

### Fuzz is enabled in the scheduler but currently has no effect

`FSRSService` constructs ts-fsrs with `enable_fuzz: true` (overriding the library default of `false`), so ts-fsrs writes a fuzzed value into `card.due` for any Review-state interval ≥ 2.5 days. However, every production reader of due dates goes through `FSRSService.computeDueDate`, which for Review cards recomputes `lastReview + intervalFromStability(...)` — a deterministic, fuzz-free formula — and the stored `card.due` is only consulted as a fallback for New/Learning cards.

Net effect: users see the same deterministic due dates as if fuzz were off, so we pay the (small) cost of seeded randomness with none of the load-smoothing benefit.

Two ways out:
- **(a)** Make fuzz real by adopting the "stamp `request_retention`, return stored `card.due` verbatim when it matches" fix from the **Exact due dates** item above — this restores ts-fsrs's intended load-spreading and also closes the ±1-day drift.
- **(b)** Drop fuzz entirely by passing `enable_fuzz: false`, which also lets the end-to-end snapshot test stop poking the scheduler's private `parameters.enable_fuzz` to disable it.

## Games

### False deviation from a user-to-move repertoire leaf

When a repertoire line ends on an *opponent* move, the resulting user-to-move position is a leaf: it's a node in the repertoire (so it's in the FEN set) but has no authored continuation. `addEdge` creates `positions[to] = { moves: {} }` for every edge endpoint (`PendingEditModel.ts:374`), the codec persists it as a reachable node, and `buildRepertoireFenSets` adds every position key.

In a real game that reaches such a leaf and then plays a non-transposing move, `annotateGame` flags that move as a **deviation** (purple border) with **empty** `repertoireMoves` (no green arrows) — even though there was nothing to deviate from. The deviation branch only tests `isUserMove && repertoireFens.has(fenBefore)` (`GameAnnotationService.ts:400`); it never checks that a repertoire continuation exists. Confirmed with a repro: repertoire authored to `2...Nc6`, game `e4 e5 Nf3 Nc6 Bb5 …` → `Bb5` returns `deviation`, `alts = 0`.

**Fix:** in the deviation branch, require at least one repertoire continuation from `fenBefore` (non-empty alternatives); when there is none, classify the move as **out-of-theory** instead. Independent of the frozen-annotation (`fan`) work, though `fan` would otherwise freeze this misclassification into stored data.
