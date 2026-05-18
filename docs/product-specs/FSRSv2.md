# FSRS v2 — Full Migration to FSRS-Based Training

## Overview

Replace the custom weight-based variant selection system with FSRS-driven, position-level scheduling. Training sessions become review queues of due cards rather than weighted-random variant picks. The repertoire is treated as a move tree (DAG), not a list of PGN lines.

## Core Concepts

### Card = `(FEN, move)`

Same as FSRS v1. Each user-turn position + expected move is an FSRS card. Opponent moves are never cards. Transpositions share one card.

### Repertoire Graph

PGN lines remain the import/storage format. At runtime, they are flattened into a DAG of positions and edges. User-turn edges carry FSRS cards. The graph supports both forward traversal (root → leaf) and backward path lookup (card → root).

### Review Queue

The review queue is **rebuilt before each traversal** — there is no session concept. Each traversal is independent. The queue collects all currently due and new cards (both white and black):

1. **Relearning** — failed recently, short-term schedule
2. **Due Review** — overdue, sorted by overdueness
3. **Learning** — still in initial learning steps
4. **New** — unseen cards

Cards rated `Again` during a traversal re-enter the queue with short intervals. They become due again naturally (e.g., 1 minute later) and will be picked up by a subsequent traversal.

Training continues until the queue is empty or the user navigates away. The `?filter=` parameter is not supported — all repertoire cards are included.

Line drills are detected during queue building: if 2+ New cards form a contiguous branch with no non-New cards between them, they are grouped into a line drill.

### Path Planning

The full traversal is pre-computed before the first move:

1. Pull the highest-priority due card from the review queue
2. Compute path from root to that card, choosing opponent branches that lead toward more due cards
3. Mark each user-turn position in the path: **autoplay**, **warm-up** (N moves before target), **target** (due card), or **cool-down** (N moves after target). N = context depth setting (default: 2).
4. If more due cards exist deeper on the chosen path, extend the plan with another autoplay/warm-up/target/cool-down zone
5. Execute the pre-computed plan move-by-move

All user-played moves (warm-up, target, cool-down) are rated normally. The plan is fully determined before the first move — no mid-traversal queue consultation.

Group due cards sharing a path prefix into a single traversal to avoid redundant replaying of opening moves.

### Branch Points

At positions where multiple repertoire moves exist, the user may play a valid move that's not on the planned path. In this case:

- Show "Correct, but there are more options" and ask the user to try another move
- Rate the unplanned valid move's card as `Good` (the user demonstrated recall)
- Repeat until the user plays the planned move
- Then rate the planned move normally

### New Card Teaching

New cards (never seen) use a two-phase introduction:

1. **Teaching encounter:** Show the correct move on the board (arrow/highlight). User must physically play it. Card is **not rated** — it stays in New state. This is pure introduction, not a test. If the user plays a wrong move, reject it with an error sound (no rating).
2. **First real review:** The card appears again (within the same session) with no hint. User must recall the move. Rated normally (`Good`/`Again`). Card transitions to Learning.

New cards are introduced in **tree order** — shallow positions before deep ones. A card at depth N is not introduced until cards at depth N−1 on the same branch have left New state.

New cards are interleaved with reviews, not front-loaded.

### Line Drill

When a user adds a new variant, the new moves form a contiguous path. These are grouped into a **line drill** rather than introduced individually:

1. **Teaching pass:** Walk the line root → leaf. Mastered prefix is autoplayed. At each new position, show the correct move (arrow/highlight), user plays it (guided). No rating.
2. **Recall pass:** Immediately replay the same line. No hints. User must recall each move. Rate each card `Again` — immediate recall after teaching is not real learning.

After the drill, individual cards enter Learning with tight intervals. Subsequent reviews are unguided and rated normally (`Good`/`Again`).

**Trigger:** Detected during queue building — 2+ New cards on the same branch with no non-New cards between them. Single isolated new cards use the individual teaching flow.

### Rating

- Correct on first attempt → `Good`
- Any error → `Again` (rated once when the correct move is finally played, regardless of how many wrong attempts)
- Teaching encounter (guided) → **not rated**
- Line drill recall pass → `Again` (immediate recall after teaching is not real learning)

Card is rated immediately after the user responds correctly.

### Error Handling

Wrong moves play an error sound and are rejected (move reverts). The user keeps trying until they play the correct move. Multiple wrong attempts at the same position count as a single `Again` — no repeated ratings.

A **"give me hint"** option is available: shows the correct move on the board. The user must still play it. The card is rated `Again`.

### Context Depth Edge Cases

- **Due card near root** (not enough room for full warm-up): start from root, user plays all available moves leading to the target.
- **Adjacent due cards** (warm-up/cool-down zones overlap): merge into continuous user-play — no autoplay gap between them.

### Progress Display

Replace the current BadgeRow with minimal relevant badges: **cards due**, **cards reviewed today**, and **total cards**. Show queue status — when the queue empties and ahead-of-schedule mode activates, the display signals the transition (e.g., "All due cards reviewed — practicing ahead of schedule").

Remove badges that no longer apply (oldest, 80th percentile, variant-level errors).

### Annotations

PGN annotations carry over into v2 traversals. They are displayed on the board and affect autoplay timing, same as current behavior.

### Between Traversals

No auto-load countdown. The next traversal starts immediately after the previous one completes. The user stops training by navigating away.

### Traversal End

A traversal ends after the cool-down of the last due card on the path. It does not necessarily reach a leaf node.

## What Changes

| Area | Before (v1) | After (v2) |
|---|---|---|
| Session unit | Variant (full line) | Card (single position) |
| Selection | Weighted random by variant stats | Priority queue of due/new cards |
| Navigation | Root → leaf, one variant per round | Autoplay path to target card |
| Round definition | 1 variant traversal | N card reviews |
| Orientation | Per variant (random) | Per traversal (determined by target card) |
| New material | Implicit (newness weight) | All new cards introduced as they appear |
| "Done" signal | Never | Queue empty → ahead-of-schedule mode |
| Variant-level stats | `errorEMA`, `successEMA`, `lastSucceededEpoch`, `WeightSettings` | Removed |
| Filter | `?filter=` by classification/FEN | Not supported |
| Between rounds | Auto-load countdown | Immediate |
| Debug table | Variant weights/probability | Removed |
| `dailyPlayCount` | Per variant round | Per traversal |

## What Stays

- `/repertoire` and `/games` pages — unchanged
- PGN as import/storage format
- `fsrsCards` storage (`Record<string, FSRSCardData>`)
- FSRS config (request_retention 0.9, max_interval 365, fuzz, short_term)
- `Good`/`Again` rating mapping
- `ts-fsrs` library
- Backend API contract (additive — variant-level stats become vestigial)

## Scope

Only `/training` and `/settings` are affected. `/settings` loses the weight-tuning sliders (recency/frequency/error power) and gains a **context depth** setting (number of user-turn moves to play before and after a due card; default: 2). No changes to `/repertoire` or `/games`.

## New Components

- **RepertoireGraph** — DAG built from PGN variants. Positions + edges. Forward and backward traversal.
- **ReviewQueue** — priority queue over FSRS card states.
- **PathPlanner** — root-to-card path computation. Batches nearby due cards into single traversals.

## Card Initialization

On every repertoire load, reconcile `fsrsCards` with the RepertoireGraph:

- **New positions** (in graph, no card) → create card with state=New
- **Removed positions** (card exists, not in graph) → delete card
- **Existing positions** → untouched

This runs on every load and after any PGN add/edit/delete. It keeps `fsrsCards` as the complete source of truth — the ReviewQueue iterates over cards directly without cross-referencing the graph.

## Migration

- No backend API changes required. The `fsrsCards` format is unchanged — only the number of entries grows.
- Existing `fsrsCards` data carries over as-is.
- Variant-level stats (`errorEMA`, `successEMA`, `lastSucceededEpoch`, `numberOfTimesPlayed`) become ignored. Keep in storage for rollback safety; remove in a later cleanup.
- `WeightSettings` UI (recency/frequency/error power sliders) replaced with context depth setting.

## Persistence

Save to backend after each **traversal**. Cards are rated during the traversal; the save happens when the traversal completes. This matches the current save-per-variant-completion frequency.

Line drills save after the recall pass completes.

## Ahead-of-Schedule Mode

When the review queue is empty, offer an "ahead of schedule" practice mode. Select cards with the lowest retrievability (weakest memories that aren't yet due) and drill them. Standard `Good`/`Again` rating still applies.

## Autoplay Path Speed

Autoplay to the target position uses the current animation speed — no instant jumps.

## Backlog (Not v1)

- Expose `Hard`/`Easy` ratings via UI gestures for finer FSRS granularity.
- `?filter=` support for training by classification or FEN.
- Debug table showing FSRS card state (retrievability, state, due date).
