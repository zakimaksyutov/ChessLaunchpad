# Game Ingest — Product Specification

## Overview

Games played by the user on linked Lichess and Chess.com accounts are used as an additional source of Again/Good signal for FSRS cards. Ingestion runs automatically when the user opens the Dashboard — no visit to the Games page is required.

The Games page is unaffected: it continues to maintain its own per-device cache and watermark.

---

## 1. Data Shape

A new top-level property `games` on the synced repertoire blob holds per-account ingest state, keyed by `"${platform}:${usernameLower}"`. The backend whitelists `games` as a free-form object (`docs/BACKEND_API_CONTRACT.md` root schema); inner shape is enforced client-side.

```jsonc
"games": {
  "lichess:nykterstein": {
    "watermarkMs": 1748000000000,
    "recentIds": [
      { "id": "abc123", "ts": 1748000000000 },
      { "id": "def456", "ts": 1747999990000 }
    ]
  },
  "chess.com:erik": {
    "watermarkMs": 1748000000000,
    "recentIds": [
      { "id": "uuid-1", "ts": 1748000000000 },
      { "id": "uuid-2", "ts": 1747999950000 }
    ],
    "providerCursor": { "month": "2026-05", "etag": "W/\"…\"" }
  }
}
```

- `watermarkMs` — only games with `createdAt > watermarkMs` are eligible.
- `recentIds` — ring of up to **50** most-recent processed games. Each entry is `{ id, ts }` where `ts` is the game's `createdAt`. **Boundary dedup only** — catches games sharing the watermark `createdAt` ms and concurrent-client overlap. Games strictly older than `watermarkMs` are excluded by watermark monotonicity and need not be remembered here.
  - **ID format:** raw provider id with no prefix — Lichess `id`, Chess.com `uuid` — so independent clients agree on dedup keys.
  - **Eviction order:** sorted by `ts` descending, ties broken by `id` ascending; entries past index 49 are dropped. Deterministic ordering is required so concurrent clients converge on the same retained set.
- `providerCursor` *(optional, provider-defined)* — opaque hint that lets the client short-circuit unchanged fetches. Chess.com uses `{ month, etag }` for a conditional `If-None-Match` against that month's archive; `month` tracks only the most recently fetched archive. When the 5-day window straddles a month boundary, the prior month is fetched unconditionally (cost is bounded — at most a few days per boundary). Not used by Lichess.

---

## 2. Trigger

- Runs automatically each time the Dashboard mounts. There is no throttle between successive runs; concurrent runs in the same tab are guarded by an in-process lock, and cross-tab runs are serialized by the ETag/If-Match flow (see §5).
- A manual **Sync** button on the Dashboard runs the same pipeline on demand; both the auto-trigger and the button share the same lock so they can never overlap.
- Successful ingestion is surfaced via the Activity Feed: counts land on the day each game was played (see §6).
- An in-progress run is surfaced via a sync-status indicator next to the Activity header (see §6).
- Errors are silent in the UI (telemetry only).

---

## 3. Eligibility

A game is ingested only if **all** hold:

- Rated standard chess (no variants).
- Time class is blitz or rapid.
- `createdAt > watermarkMs` **and** `id ∉ recentIds`.
- **Game age:** `now − createdAt ≤ 5 days` (inclusive). Older games are never ingested.
- **Not future-dated:** `createdAt ≤ now`. Defends against clock skew between the client and the provider (a future-dated game would otherwise be impossible to age out).

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

**Per-card idempotence guard.** A rating (Good or Again) is **skipped** for a card whose `last_review` (`lr`) is strictly **after** `game.createdAt`. Applying it would move FSRS state backward in time. This guard is what lets repeated runs and concurrent clients converge safely: a more-recent training-pass review of the same card is never overwritten by a re-processed older game, and a game that has already been ingested produces a no-op when processed again.

Each ingested game also updates per-day activity counters, attributed to the date of `game.createdAt`. The counters live in a single `games` sub-object on the per-day `practiceLog` entry (see §6), kept separate from the manual-training `reviewed` / `mistakes` / `learned` counters:

- `games.ingested` — increments for each eligible game whose **user color can be resolved** from the game metadata, regardless of whether the game produced any ratings. Games where the user cannot be identified as a player (malformed metadata, etc.) still advance the watermark / `recentIds` so dedup keeps working, but they do not contribute to this counter.
- `games.reviewed` — increments **once per Good rating actually applied** during the game (one per in-repertoire user move whose card passes the idempotence guard).
- `games.mistakes` — increments **once per game with a detected first deviation**, regardless of how many sibling cards exist at the deviation FEN and regardless of whether the per-card guard ends up skipping every sibling. The intuition is "I made a mistake in this game"; the per-card FSRS state of each sibling updates individually (subject to the guard above).

Date attribution uses the user's **local timezone**, matching the existing `ActivityService.getTodayDateString()` semantics.

---

## 5. Multi-Client Concurrency

Ingest must be idempotent across devices.

- The blob's existing ETag / If-Match optimistic concurrency is the only coordination mechanism.
- On `412`: re-fetch the blob, recompute the set of still-unprocessed games against the freshest `watermarkMs` + `recentIds`, re-apply ratings to the fresh FSRS state, and re-derive activity counter deltas from the recomputed set. Never `+=` previously-captured deltas onto a freshly-read entry. Retry the PUT.
- **Retry cap:** up to **3 attempts** total per run. If all attempts conflict the run aborts silently (telemetry only) and the next Dashboard mount will pick up where it left off.
- The watermark and `recentIds` advance **only on successful PUT**.
- Games present in `recentIds` are skipped even if `createdAt > watermarkMs`.
- **Cursor-only writes.** A run that produces zero eligible games but observes a changed chess.com `providerCursor.etag` (or a missing → present transition) still issues a PUT so the cursor is persisted. Without this, every subsequent run would re-validate the same archive against a stale or absent ETag.

---

## 6. Dashboard Surface

The user-visible surface of ingest lives on the Dashboard. The per-day schema and feed wording are documented in [`DASHBOARD.md`](./DASHBOARD.md):

- **§1.4 Activity Feed** — the "Played" line rendering (one per day with `games.ingested > 0`).
- **§2.1 Practice log** — the `games` sub-object schema, the `getOrCreateEntryByDate` lifecycle (game-ingest may write to past-date entries within the 5-day window), and the streak rule (game-only days do **not** extend `currentStreak` / `bestStreak`).

### 6.1 UI feedback during a run

The ingest service exposes a typed progress callback (`IngestProgress` events):

- A `fetching` event is emitted before each per-account fetch (`accountIndex` is 1-based; on a 412 retry the pipeline restarts and these events are re-emitted from 1).
- A single `done` event is emitted at the end with the count of games processed in the final attempt — even when ingest swallows an error internally (the caller cannot distinguish "nothing new" from "silent failure," matching the silent-error contract).
- **No events are emitted at all when the user has no linked accounts.** Consumers must treat "callback never fires" as a valid, normal state.

The Dashboard uses these events to drive:

- A status indicator beside the Activity heading: "Syncing games…" while a run is in flight, "Synced @ HH:MM" once `done` fires. Per-account `fetching` events are intentionally coalesced into a single "Syncing…" state.
- A manual **Sync** button that re-runs the pipeline on demand. The indicator and the button render only after the first progress event fires for the session, so a user with no linked accounts sees no sync chrome at all.

---

## 7. Out of Scope

- Storing raw (full-game) PGNs on the backend. Truncated mistake-game persistence is in §8 Backlog.
- Rendering per-game annotations on the Dashboard (lives on the Games page).
- Unrated games, variants, bullet, daily/correspondence.
- Back-filling ratings for historical games when a repertoire variant is added later — `watermarkMs` advances one-way.
- Reusing or mutating the Games page's IndexedDB cache or its localStorage watermark.

---

## 8. Backlog

### 8.1 Mistake-game replay

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
