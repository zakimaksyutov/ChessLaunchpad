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

A reverse-chronological timeline grouped by date (inspired by Lichess profile activity). Each day that has practice data shows a dated header and one summary line with key stats at a glance:

```
25 MAY 2026
  🎯  Trained 42 positions  ·  38 correct  ·  4 mistakes  ·  90% accuracy
       5 traversals  ·  12 min

24 MAY 2026
  🎯  Trained 30 positions  ·  25 correct  ·  5 mistakes  ·  83% accuracy
       3 traversals  ·  8 min
  📘  Learned 6 new positions

23 MAY 2026
  📘  Learned 12 new positions
```

- Days with no activity are omitted (gaps are visible from date headers).
- "Trained" line appears when `reviewed + mistakes > 0`; shows correct/mistake counts and accuracy badge (color-coded: green ≥ 90%, yellow ≥ 70%, red < 70%).
- "Learned" line appears when `learned > 0`.
- Time is shown as human-friendly duration (e.g., "12 min", "1 hr 5 min").

### 1.5 Call to Action

- Prominent "Start Training" button, especially when cards are due.

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

#### Derived metrics (not stored)

- **Total positions** — `reviewed + mistakes + learned`.
- **Accuracy** — `reviewed / (reviewed + mistakes)` (exclude `learned`; recall-pass Again is not an error).
- **Current streak** — consecutive days (including today) with total > 0.
- **Best streak** — longest such run in the log.

#### Lifecycle

- The latest entry in `practiceLog` represents today's session. On each save, update it in place.
- On day-boundary reset (when `lastPlayedDate` rolls to a new day), append a new entry for the new date. If the log already has 30 entries, drop the oldest.

`dailyPlayCount` is kept for backward compatibility (= latest entry's `reviewed`).

### 2.2 Lifetime totals

`activity.lifetime` — incremented alongside daily counters, never reset.

| Field                  | Type   | Description                                       |
| ---------------------- | ------ | ------------------------------------------------- |
| `reviewed`             | number | All-time positions rated Good.                    |
| `mistakes`             | number | All-time positions rated Again (review).          |
| `learned`              | number | All-time new positions taught + recalled.         |
| `traversals`           | number | All-time traversals completed.                    |
| `timeSeconds`          | number | All-time active training seconds.                 |

### 2.3 Time tracking

Time is measured per traversal from user-move timestamps recorded inside the training engine. Only completed traversals contribute to `timeSeconds`; navigating away without finishing a traversal records no time.

**Normal traversal** — elapsed = *(last user move − first user move) + 2 s*. The +2 s accounts for seeing the result after the final move.

**Idle detection** — if any gap between consecutive user moves exceeds **60 seconds**, the user is assumed to have stepped away. The entire traversal uses approximate time instead: *number of user moves × 2 s*.

Teaching-pass moves (guided, not from memory) are excluded; only recall-pass and regular-review moves contribute timestamps.

---

## 3. Unauthenticated Users

Show the existing static landing page (marketing copy). The dashboard is only for logged-in users.
