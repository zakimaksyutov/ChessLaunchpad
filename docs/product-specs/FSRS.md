# FSRS Training System

Training is driven by [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), a spaced-repetition scheduling algorithm. Every position in the user's repertoire is an FSRS card; the system schedules reviews, plans traversals through the repertoire tree, and introduces new material automatically.

## Cards

A card represents a **user-turn position and the expected move**: `(normalized FEN, move SAN)`.

- Only user-turn positions are tracked — opponent moves are always played by the system.
- Transpositions share one card (same FEN + move across different PGN lines).
- At branch points each valid response is a separate card.
- Cards are reconciled with the repertoire on every load: new positions get New cards, removed positions have their cards deleted.

## Repertoire Graph

PGN lines are the import/storage format. At runtime they are flattened into a directed acyclic graph (DAG) of positions and edges. User-turn edges carry FSRS cards. The graph supports forward traversal (root → leaf) and backward path lookup (card → root).

## Review Queue

The review queue is rebuilt before each traversal. Priority order:

1. **Relearning** — failed recently, short-term schedule
2. **Due Review** — overdue, sorted by overdueness
3. **Learning** — still in initial learning steps
4. **New** — unseen cards

Training continues until the queue is empty or the user navigates away.

## Path Planning

Each traversal is pre-computed before the first move:

1. Pull the highest-priority card from the queue.
2. Compute a path from the root to that card through the repertoire graph. Prefer shorter paths and those containing more due cards along the way.
3. Mark each user-turn position in the path:
   - **Autoplay** — mastered positions at the start (Review state, not due, retrievability ≥ target retention). Autoplay is a strict prefix — once the user plays, it does not resume.
   - **Warm-up** — N user-turn moves before the target, where N = context depth setting.
   - **Target** — the due card being reviewed.
   - **Cool-down** — N user-turn moves after the target.
4. If more due cards exist deeper on the same path, extend with another autoplay/warm-up/target/cool-down zone.
5. Execute the plan move-by-move.

All user-played moves (warm-up, target, cool-down) are rated normally. The plan is fully determined before the first move — no mid-traversal queue consultation.

**Early-move exception:** For the first 2 user-turn moves, the lookahead is skipped (depth reduced to 1) to avoid excessive tree evaluation at the root where branching is highest.

## Rating

| Situation | Rating |
|---|---|
| Correct on first attempt | Good |
| Any error, then corrected | Again |
| Teaching pass (guided) | Not rated |
| Recall pass (immediate recall) | Again |

Only `Good` and `Again` are used. `Hard` and `Easy` are reserved for possible future UI gestures. Multiple wrong attempts at the same position count as a single `Again`.

## New Card Introduction

New cards use a two-phase teach-then-recall flow:

1. **Teaching pass** — Autoplay the path to the new card(s). At each new position, show the correct move on the board. The user must physically play it. Cards are **not rated** — they stay in New state.
2. **Recall pass** — Immediately replay the same path. The user must recall each newly taught card. Each receives an `Again` rating (immediate recall after teaching is not real learning).

After the recall pass, cards enter Learning state with tight intervals. Subsequent reviews are unguided and rated normally.

## Branch Points

When the user plays a valid move that's not on the planned path:

- The system acknowledges it as correct but asks the user to try another move.
- The unplanned valid move's card is rated `Good` (the user demonstrated recall).
- Repeat until the planned move is played.

## Error Handling

Wrong moves are rejected with an error sound. The user keeps trying until they play the correct move. A **"give me hint"** option is always available — it shows the correct move on the board; the card is rated `Again`.

## Ahead-of-Schedule Mode

When the queue is empty, the system practices cards with the lowest retrievability (weakest memories that aren't yet due) using the same path-planning flow. The UI signals the transition.

## Progress Display

Four badges: **review** (due Review-state cards in queue), **learning** (due Learning/Relearning cards in queue), **new** (unseen cards in queue), **today** (cards reviewed this session day).

## Settings

| Setting | Range | Default | Description |
|---|---|---|---|
| Context Depth | 0–10 | 2 | User-turn moves shown as warm-up/cool-down around each target |
| Target Retention | 0.80–0.99 | 0.97 | Desired recall probability at review time |
| Max Interval | 7–365 days | 90 | Maximum days before a card is reviewed again |

All settings are synced to the backend and roam across devices.

## Persistence

- Cards are saved to the backend after each traversal completion as part of `RepertoireData.fsrsCards`.
- A 300 ms inter-traversal delay allows the success sound to finish before the next traversal begins.
- Legacy variant-level fields (`errorEMA`, `successEMA`, `lastSucceededEpoch`, `currentEpoch`) remain in the backend payload for backward compatibility but are zeroed on load and not used for scheduling.
