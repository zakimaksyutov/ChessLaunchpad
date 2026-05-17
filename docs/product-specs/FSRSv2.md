# FSRS v2 — Full Migration to FSRS-Based Training

## Overview

Replace the custom weight-based variant selection system with FSRS-driven, position-level scheduling. Training sessions become review queues of due cards rather than weighted-random variant picks. The repertoire is treated as a move tree (DAG), not a list of PGN lines.

## Core Concepts

### Card = `(FEN, move)`

Same as FSRS v1. Each user-turn position + expected move is an FSRS card. Opponent moves are never cards. Transpositions share one card.

### Repertoire Graph

PGN lines remain the import/storage format. At runtime, they are flattened into a DAG of positions and edges. User-turn edges carry FSRS cards. The graph supports both forward traversal (root → leaf) and backward path lookup (card → root).

### Review Queue

At session start, collect all due and new cards into a priority queue:

1. **Relearning** — failed recently, short-term schedule
2. **Due Review** — overdue, sorted by overdueness
3. **Learning** — still in initial learning steps
4. **New** — unseen cards, capped at a configurable daily limit (default: 10)

Session ends when the queue is empty or the user stops.

### Path Planning

To test a due card at position P:
- Compute path from root to P
- Autoplay the entire path (both sides)
- Stop at P — user plays the card
- If more due cards exist deeper on the same branch, continue forward

Group due cards sharing a path prefix into a single traversal to avoid redundant replaying of opening moves.

### New Card Teaching

New cards (never seen) use a two-phase introduction:

1. **Teaching encounter:** Show the correct move on the board (arrow/highlight). User must physically play it. Card is **not rated** — it stays in New state. This is pure introduction, not a test.
2. **First real review:** The card appears again (within the same session) with no hint. User must recall the move. Rated normally (`Good`/`Again`). Card transitions to Learning.

New cards are introduced in **tree order** — shallow positions before deep ones. A card at depth N is not introduced until cards at depth N−1 on the same branch have left New state.

New cards are interleaved with reviews, not front-loaded.

### Line Drill

When a user adds a new variant, the new moves form a contiguous path. These are grouped into a **line drill** rather than introduced individually:

1. **Teaching pass:** Walk the line root → leaf. Mastered prefix is autoplayed. At each new position, show the correct move (arrow/highlight), user plays it (guided). No rating.
2. **Recall pass:** Immediately replay the same line. No hints. User must recall each move. Rate each card `Again` — immediate recall after teaching is not real learning.

After the drill, individual cards enter Learning with tight intervals. Subsequent reviews are unguided and rated normally (`Good`/`Again`).

**Trigger:** 2+ New cards on the same branch with no non-New cards between them. Single isolated new cards use the individual teaching flow.

**Daily limit:** Line drills consume from the daily new-card limit. A 5-move drill uses 5 of the user's allowance.

### Rating

- Correct on first attempt → `Good`
- Any error → `Again`
- Teaching encounter (guided) → **not rated**
- Line drill recall pass → `Again` (immediate recall after teaching is not real learning)

Card is rated immediately after the user responds.

## What Changes

| Area | Before (v1) | After (v2) |
|---|---|---|
| Session unit | Variant (full line) | Card (single position) |
| Selection | Weighted random by variant stats | Priority queue of due/new cards |
| Navigation | Root → leaf, one variant per round | Autoplay path to target card |
| Round definition | 1 variant traversal | N card reviews |
| New material | Implicit (newness weight) | Explicit daily new-card limit |
| "Done" signal | Never | Queue empty |
| Variant-level stats | `errorEMA`, `successEMA`, `lastSucceededEpoch`, `WeightSettings` | Removed |

## What Stays

- PGN as import/storage format
- `fsrsCards` storage (`Record<string, FSRSCardData>`)
- FSRS config (request_retention 0.9, max_interval 365, fuzz, short_term)
- `Good`/`Again` rating mapping
- `ts-fsrs` library
- Backend API contract (additive — variant-level stats become vestigial)

## New Components

- **RepertoireGraph** — DAG built from PGN variants. Positions + edges. Forward and backward traversal.
- **ReviewQueue** — priority queue over FSRS card states. Configurable new-card-per-day limit.
- **PathPlanner** — root-to-card path computation. Batches nearby due cards into single traversals.

## Migration

- Existing `fsrsCards` data carries over as-is — no migration needed.
- Variant-level stats (`errorEMA`, `successEMA`, `lastSucceededEpoch`, `numberOfTimesPlayed`) become ignored. Keep in storage for rollback safety; remove in a later cleanup.
- `WeightSettings` UI (recency/frequency/error power sliders) replaced with new-card-per-day setting.

## Ahead-of-Schedule Mode

When the review queue is empty, offer an "ahead of schedule" practice mode. Select cards with the lowest retrievability (weakest memories that aren't yet due) and drill them. Standard `Good`/`Again` rating still applies.

## Autoplay Path Speed

Autoplay to the target position uses the current animation speed — no instant jumps.

## Backlog (Not v1)

- Expose `Hard`/`Easy` ratings via UI gestures for finer FSRS granularity.
