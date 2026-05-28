# Game Ingest — Product Specification

## Overview

Games played by the user on linked Lichess and Chess.com accounts are used as an additional source of Again/Good signal for FSRS cards. Ingestion runs automatically when the user opens the Dashboard — no visit to the Games page is required.

The Games page is unaffected: it continues to maintain its own per-device cache and watermark.

---

## 1. Data Shape

A new top-level property `games` on the synced repertoire blob holds per-account ingest state, keyed by `"${platform}:${usernameLower}"`.

```jsonc
"games": {
  "lichess:nykterstein": {
    "watermarkMs": 1748000000000,
    "recentIds": ["abc123", "def456", "…"]
  },
  "chess.com:erik": {
    "watermarkMs": 1748000000000,
    "recentIds": ["uuid-1", "uuid-2", "…"],
    "providerCursor": { "month": "2026-05", "etag": "W/\"…\"" }
  }
}
```

- `watermarkMs` — only games with `createdAt > watermarkMs` are eligible.
- `recentIds` — ring of up to **50** most recent processed game IDs. **Boundary dedup only** — catches games sharing the watermark `createdAt` ms and concurrent-client overlap. Games strictly older than `watermarkMs` are excluded by watermark monotonicity and need not be remembered here.
- `providerCursor` *(optional, provider-defined)* — opaque hint that lets the client short-circuit unchanged fetches. Chess.com uses `{ month, etag }` for a conditional `If-None-Match` against that month's archive; `month` tracks only the most recently fetched archive. When the 5-day window straddles a month boundary, the prior month is fetched unconditionally (cost is bounded — at most a few days per boundary). Not used by Lichess.

---

## 2. Trigger

- Runs automatically each time the Dashboard mounts. There is no throttle between successive runs; concurrent runs across tabs are serialized by the ETag/If-Match flow (see §5).
- Successful ingestion is surfaced via the Activity Feed: counts land on the day each game was played (see §6 below).
- Errors are silent in the UI (telemetry only).

---

## 3. Eligibility

A game is ingested only if **all** hold:

- Rated standard chess (no variants).
- Time class is blitz or rapid.
- `createdAt > watermarkMs` **and** `id ∉ recentIds`.
- **Game age:** `now − createdAt ≤ 5 days` (inclusive). Older games are never ingested.

A game that produces no rating matches (e.g. no repertoire FENs hit) is still considered processed: it advances `watermarkMs` and joins `recentIds` like any other.

First-time sync ingests only games from the last 5 days; there is no full-history backfill.

**On account unlink:** the corresponding `games["${platform}:${user}"]` entry is removed from the synced blob. Re-linking later starts fresh and ingests the most recent 5 days.

---

## 4. Annotation → Rating

The existing repertoire annotation drives ratings:

| Annotation at user move | FSRS rating | Card(s) rated |
|---|---|---|
| In repertoire | Good | `(fenBefore, playedSan)` |
| Deviation (first user move out of repertoire) | Again | **Every** repertoire card at that FEN |
| `out-of-repertoire-response`, `out-of-theory`, opponent moves | ignored | — |

Ratings are timestamped with `game.createdAt`, not wall-clock time. FENs are normalized using the same scheme as FSRS cards (halfmove clock reset).

Each ingested game also updates Dashboard activity counters, attributed to the date of `game.createdAt` (see §6 below):

- Every processed game increments `gamesIngested` for that date, regardless of whether it produced any ratings.
- `gameReviewed` increments **once per Good rating** issued during the game (one per in-repertoire user move).
- `gameMistakes` increments **once per deviating game** — even if multiple sibling cards at the deviation FEN receive Again, the day-level mistake count increments by one. The per-card FSRS state of each sibling still updates individually.

These counters are tracked separately from the manual-training `reviewed` / `mistakes` counters.

---

## 5. Multi-Client Concurrency

Ingest must be idempotent across devices.

- The blob's existing ETag / If-Match optimistic concurrency is the only coordination mechanism.
- On `412`: re-fetch the blob, recompute the set of still-unprocessed games against the freshest `watermarkMs` + `recentIds`, re-apply ratings to the fresh FSRS state, and re-derive activity counter deltas from the recomputed set. Never `+=` previously-captured deltas onto a freshly-read entry. Retry the PUT.
- The watermark and `recentIds` advance **only on successful PUT**.
- Games present in `recentIds` are skipped even if `createdAt > watermarkMs`.

---

## 6. Dashboard Surface (changes to DASHBOARD.md)

The implementing agent should move these into `docs/product-specs/DASHBOARD.md` (sections referenced below).

### 6.1 New per-day fields (DASHBOARD.md §2.1 Practice log)

Add to the practice-log entry schema:

| Field           | Type   | Description                                                                                      |
| --------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `gamesIngested` | number | Games ingested from linked accounts whose `createdAt` falls on this date.                        |
| `gameReviewed`  | number | Count of Good ratings issued from ingested games on this date (one per in-repertoire user move). |
| `gameMistakes`  | number | Count of deviating games on this date (one per game with at least one Again rating, regardless of sibling fan-out). |

Add lifecycle bullets:

> Game ingest may also create or update entries for past dates within the log window — each ingested game is attributed to its play date, not the sync date. The `practiceLog` is therefore no longer strictly append-only: ingest uses a `getOrCreateEntryByDate(date)` helper that maintains date-sorted order. The existing `getTodayEntry()` lookup becomes "find entry where `date == today`" rather than "last entry."

**Streak rule:** game-only days (where `gamesIngested > 0` but `reviewed + mistakes + learned == 0`) do **not** count toward `currentStreak` or `bestStreak`. Streaks remain a measure of deliberate practice. `bestStreak` stays monotonic — ingest cannot decrement it, and retroactive past-date writes never revise it downward.

### 6.2 New lifetime fields (DASHBOARD.md §2.2 Lifetime totals)

| Field           | Type   | Description                                       |
| --------------- | ------ | ------------------------------------------------- |
| `gamesIngested` | number | All-time games ingested from linked accounts.     |
| `gameReviewed`  | number | All-time Good ratings from ingested games.        |
| `gameMistakes`  | number | All-time Again ratings from ingested games.       |

### 6.3 New activity feed line (DASHBOARD.md §1.4 Activity Feed)

Add a "Played" line to the per-day rendering, appearing when `gamesIngested > 0`:

```
25 MAY 2026
  🎯  Trained 42 positions  ·  38 correct  ·  4 mistakes  ·  90% accuracy
       5 traversals  ·  12 min
  ⚔️  Played 3 games  ·  8 correct  ·  2 mistakes
```

- Shows games played (`gamesIngested`), in-repertoire moves (`gameReviewed`), and deviating games (`gameMistakes`).
- "Mistakes" here counts games-with-a-deviation, not cards-Again'd, so the number aligns with the user's intuition ("I made 2 mistakes in 3 games").
- Emoji choice is open (⚔️ / ♟️ / 🎮); pick whichever fits the existing visual style.

---

## 7. Out of Scope

- Storing raw (full-game) PGNs on the backend. Truncated mistake-game persistence is in §9 Backlog.
- Rendering per-game annotations on the Dashboard (lives on the Games page).
- Unrated games, variants, bullet, daily/correspondence.
- Back-filling ratings for historical games when a repertoire variant is added later — `watermarkMs` advances one-way.
- Reusing or mutating the Games page's IndexedDB cache or its localStorage watermark.

---

## 8. Backend Contract Change (separate session)

**Rollout order:** backend schema deployment MUST land before any frontend rollout. Until the backend accepts the new `games` root property, any client PUT including it is rejected.

Update the variants endpoint schema:

- Allow optional root-level `games` object.
- Map keys: non-empty string, max 256 chars.
- Value object: `{ watermarkMs: number, recentIds: string[], providerCursor?: object }`.
- Limits: ≤ **20** accounts; `recentIds` ≤ **50** entries, each non-empty string ≤ 64 chars; `providerCursor` ≤ 256 bytes serialized.

---

## 9. Backlog

### 9.1 Mistake-game replay

When ingest classifies a game as a deviation, persist a truncated PGN (moves 1 through the deviation move, inclusive) on the backend. The Training page can then occasionally select positions from these stored games as a training source — letting the user replay through their own historical mistakes up to the choice point.

**Per stored mistake-game (sketch):**

- Truncated PGN.
- Source reference (platform, account, original game ID, `createdAt`).
- Replay count — how many times this game has been used as a training source.
- Deviation FEN + expected repertoire move(s), for fast lookup and dedup.

**Open design questions for that session:**

- Storage location (likely sibling on the synced blob) and per-user cap.
- Eviction policy (FIFO? by replay count? once the deviation card is FSRS-mastered?).
- Training UX: dedicated mode, interleaved with regular review, or surfaced as a Dashboard suggestion?
- Dedup across multiple games sharing the same deviation FEN.
- Whether to also keep the game's full PGN reference (link out) without storing it.
