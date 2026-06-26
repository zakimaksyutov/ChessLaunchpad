# Dashboard — Product Specification

## Overview

When a logged-in user lands on the home page, show a dashboard that surfaces practice progress and motivates continued training.

---

## 1. Dashboard Widgets

### 1.1 Today's Session

- Positions reviewed correctly.
- Mistakes made.
- New positions learned.
- Traversals completed.
- Time spent training.
- Cards still due right now.

### 1.2 Lifetime Stats

- Total positions reviewed / mistakes / learned (all-time).
- Total traversals completed.
- Total time spent training.
- Current streak (consecutive days with activity, including today).
- Best streak (longest consecutive run in the log).

### 1.3 Repertoire Summary

- Total cards in repertoire.
- Breakdown by FSRS state: new / learning / due review / mastered. Review-state cards are split into "due review" (due now) and "mastered" (not yet due).

### 1.4 Activity Feed

A reverse-chronological timeline grouped by date (inspired by Lichess profile activity). Each day that has any activity shows a dated header followed by one or more summary lines (Trained, Learned, Played) — any subset of these may render on a given day:

```
25 MAY 2026
  🎯  Trained 42 positions  ·  38 correct  ·  4 mistakes  ·  90% accuracy
       5 traversals  ·  12 min
  ⚔️  Played 6 games  ·  18 correct  ·  2 mistakes

24 MAY 2026
  🎯  Trained 30 positions  ·  25 correct  ·  5 mistakes  ·  83% accuracy
       3 traversals  ·  8 min
  📘  Learned 6 new positions

23 MAY 2026
  📘  Learned 12 new positions

22 MAY 2026
  ⚔️  Played 3 games  ·  9 correct  ·  1 mistake
```

- Days with no activity (no training counters and no `games.ingested`) are omitted; gaps are visible from date headers.
- "Trained" line appears when `reviewed + mistakes > 0`; shows correct count (`reviewed`), mistake count, and accuracy badge (color-coded: green ≥ 90%, yellow ≥ 70%, red < 70%).
- "Learned" line appears when `learned > 0`.
- "Played" line appears when `games.ingested > 0`. It renders **independently** of the training counters — a day whose only activity is game-ingest still shows a date header and the Played line. Shows how many games were ingested from linked accounts and the review/mistake counts those games contributed (see [`GAME-INGEST.md`](./GAME-INGEST.md) for the ingest pipeline).
- Time is shown as human-friendly duration (e.g., "12 min", "1 hr 5 min").

### 1.5 Actions Tile

A context-aware tile at the top of the dashboard (replacing the old standalone
"Start Training" button). It surfaces a short list of clickable **action rows**
derived from the user's current state; rows appear and disappear automatically
(not dismissible). Start Training stays the primary action when cards are due.

- **Start Training** — surfaces the due count. → `/training`.
- **Review games** — "Analyze N new games" and/or "Review K opening mistakes". → `/games`.
- **Onboarding** — e.g. link a chess account when none is linked.
- An action may carry an opt-in **"Why this action?"** explainer for users who
  may not yet understand its value.
- **Import repertoire (PGN)** — a low-priority affordance at the bottom of the
  tile to import a `.pgn` repertoire for a color whose repertoire is still empty.
- **Empty state** — "You're all caught up" when no actions apply and there is
  nothing to import.

---

## 2. Data: Activity

A new `activity` object on the root `RepertoireData` object (backend schema will be updated).

```
activity: {
  practiceLog: [ ... ],
  lifetime: { ... },
}
```

### 2.1 Practice log

`activity.practiceLog` — array capped at **30 entries** (one per distinct date, oldest dropped first).

| Field         | Type   | Description                                                                                      |
| ------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `date`        | string | ISO 8601 date (`YYYY-MM-DD`).                                                                   |
| `reviewed`    | number | Positions rated Good during regular review (user knew the answer).                               |
| `mistakes`    | number | Positions rated Again during regular review (wrong move or hint used).                           |
| `learned`     | number | New positions that completed the teaching → recall flow.                                         |
| `traversals`  | number | Number of completed traversals (full root-to-leaf runs).                                         |
| `timeSeconds` | number | Active training seconds for the day (see §2.3 Time tracking).                                    |
| `games`       | object | *(Optional)* Per-day game-ingest counters. See below.                                            |

The optional `games` sub-object aggregates ratings produced by the game-ingest pipeline (see [`GAME-INGEST.md`](./GAME-INGEST.md)):

| Field       | Type   | Description                                                                       |
| ----------- | ------ | --------------------------------------------------------------------------------- |
| `ingested`  | number | Total games processed by ingest on this date (one per eligible game).             |
| `reviewed`  | number | In-repertoire user moves rated Good via ingest. Distinct from top-level `reviewed`. |
| `mistakes`  | number | Game-ingest deviations rated Again. Counted **once per game**, not per sibling card. |
| `records`   | array  | *(Optional)* Compact `GameRecord` entries for each processed game — display data for the Games page (see [`GAMES.md`](./GAMES.md)). Invariant: `records.length` equals `ingested`, or `0` (the day's records were evicted by the 100-game total cap). |

Top-level `reviewed`/`mistakes` (training) and `games.reviewed`/`games.mistakes` (ingest) are **separate counters** — they never double-count. Accuracy and streak calculations use only the top-level training counters.

#### Derived metrics (computed from practiceLog + lifetime)

- **Total positions** — `reviewed + mistakes + learned`.
- **Accuracy** — `reviewed / (reviewed + mistakes)` (exclude `learned`; recall-pass Again is not an error). Game-ingest counters are excluded.
- **Current streak** — consecutive days with **training** activity (`reviewed + mistakes + learned > 0`), counted up to and **including yesterday** when today has no entry or no training activity yet. (If today has training activity, today is included.) Days whose only activity is game-ingest (`games.ingested > 0` but training counters are all zero) **do not** extend the streak. Persisted in `lifetime.currentStreak` so it survives the 30-entry log eviction; the log-based value is used unless the streak spans the full capped window, in which case the persisted value is preferred. Because the log can hold at most 30 entries, a streak that already fills the window can no longer be measured from the log alone — when a brand-new active day extends such a streak, the persisted value is **incremented by one** (rather than capped at the window size), so streaks grow indefinitely while still resetting correctly when a recent day is missed.
- **Best streak** — longest such run. Persisted in `lifetime.bestStreak` (monotonically increasing) so it survives log eviction.

#### Lifecycle

- `practiceLog` is **not** strictly append-only. The latest training-session save still updates today's entry in place. Game-ingest, however, may target any of the most recent ~5 days (the eligibility window) — including past dates if a game's `createdAt` falls there. A helper `getOrCreateEntryByDate(activity, date)` is used: it finds the existing entry for `date` (regardless of position), or inserts a new one in date-sorted order.
- The log is kept sorted ascending by `date` after every mutation so streak code can walk backward deterministically.
- When the log reaches 30 entries, the oldest is dropped.
- Empty entries (all counters zero, including `games`) are not retained.
- Game-ingest also appends each processed game's `GameRecord` to that day's `games.records`, subject to a 100-record total cap across all days (oldest day's records evicted as a whole on overflow). See [`GAME-INGEST.md`](./GAME-INGEST.md) §6.

### 2.2 Lifetime totals

`activity.lifetime` — incremented alongside daily counters, never reset.

| Field                  | Type   | Description                                       |
| ---------------------- | ------ | ------------------------------------------------- |
| `reviewed`             | number | All-time positions rated Good.                    |
| `mistakes`             | number | All-time positions rated Again (review).          |
| `learned`              | number | All-time new positions taught + recalled.         |
| `traversals`           | number | All-time traversals completed.                    |
| `timeSeconds`          | number | All-time active training seconds.                 |
| `bestStreak`           | number | Highest streak ever recorded (survives log eviction). |
| `currentStreak`        | number | Latest active streak (survives log eviction).     |

### 2.3 Time tracking

Time is measured per traversal from user-move timestamps recorded inside the training engine. Only completed traversals contribute to `timeSeconds`; navigating away without finishing a traversal records no time.

**Normal traversal** — elapsed = *(last user move − first user move) + 2 s*. The +2 s accounts for seeing the result after the final move.

**Idle detection** — if any gap between consecutive user moves exceeds **60 seconds**, the user is assumed to have stepped away. The entire traversal uses approximate time instead: *number of user moves × 2 s*.

Teaching-pass moves (guided, not from memory) are excluded; only recall-pass and regular-review moves contribute timestamps.

---

## 3. Unauthenticated Users

Show the existing static landing page (marketing copy). The dashboard is only for logged-in users.
