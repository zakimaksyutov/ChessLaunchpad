# Game Ingest — Product Specification

## Overview

Games played on linked Lichess and Chess.com accounts are pulled into the synced repertoire blob to (a) provide additional FSRS rating signal and (b) populate the [`Games page`](./GAMES.md). Ingestion runs automatically when the Dashboard mounts, and again from the Games page on demand — both entry points share the same pipeline behind a single-flight lock.

Per-account state and per-game records both live on the synced blob, so a fresh device picks up where any other device left off.

---

## 1. Data Shape

Two pieces of state are written to the blob:

### 1.1 Per-account ingest state

`games` — top-level map keyed by `${platform}:${usernameLower}`. Backend stores it as a free-form object; the inner shape is enforced client-side.

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
    "recentIds": [ { "id": "uuid-1", "ts": 1748000000000 } ],
    "providerCursor": { "month": "2026-05", "etag": "W/\"…\"" }
  }
}
```

- `watermarkMs` — only games with `createdAt > watermarkMs` are eligible.
- `recentIds` — ring of up to **50** most-recent processed games, each `{ id, ts }`. **Boundary dedup only** — catches games sharing the watermark `createdAt` ms and concurrent-client overlap. Strictly-older games are excluded by watermark monotonicity. IDs are raw provider IDs (no prefix) so independent clients agree on dedup keys. Eviction is deterministic (`ts` desc, `id` asc) so concurrent clients converge on the same retained set.
- `providerCursor` — opaque per-provider hint. Chess.com uses `{ month, etag }` for an `If-None-Match` on the current month's archive; when the 5-day window crosses a month boundary the prior month is fetched unconditionally. Not used by Lichess.

### 1.2 Per-game display records

Per eligible game, a compact `GameRecord` is appended to the day-it-was-played entry under `activity.practiceLog[].games.records[]`. These records are the read source for the Games page (verdicts `an` / `op` are added there) and are not used by ingest itself.

```jsonc
"games": {
  "ingested": 6, "reviewed": 18, "mistakes": 2,
  "records": [
    {
      "id": "abc123",            // provider id (lichess id | chess.com uuid)
      "p": "l",                  // platform: "l" | "c"
      "t": 1716633000000,        // createdAt (ms)
      "m": "e4 e5 Nf3 Nc6 …",    // SAN moves, space-separated
      "wa": "Alice", "wr": 1850, // white account (provider casing), rating
      "ba": "Bob",   "br": 1875,
      "res": "win",              // result, user POV
      "tc": "5+3", "sp": "blitz",
      "rt": 1, "o": "Italian Game",
      "u": "https://www.chess.com/…", // present on chess.com (URL not derivable from id)
      "ev": [20, 15, -150, null]      // present on lichess when server analysis exists
      // an, op are added later by the /games page analysis pass
    }
  ]
}
```

Storage / build rules:

- `wa` / `ba` are stored in **provider casing** so the UI keeps `DrNykterstein`, not `drnykterstein`; matched case-insensitively at read time.
- For Chess.com, opening name lives only in the PGN `[ECOUrl …]` header — it is extracted *before* the PGN is reduced to bare SAN.
- `m` is capped at **60 plies** to bound the per-record wire payload; the annotation engine only looks at the opening into early middlegame.
- `ev` carries per-ply centipawn evals (Lichess only). `null` at a ply means "no eval data", distinct from a real `0 cp`.
- Record build failures (unparseable payload, unresolvable user color) are silent: the game still counts for ingest (advancing watermark / `recentIds`), there is just no record to render.

**Invariant:** for any day, `records.length` equals the day's `ingested` counter, or `0` (the records were evicted as a whole — see §6).

**`records` and `recentIds` are distinct stores.** `recentIds` is the 50-ID per-account dedup ring (compact, lossless within its window); `records` is display data that evicts by whole days. They cannot be consolidated.

---

## 2. Trigger

- Runs automatically each time the Dashboard mounts and each time the Games page mounts.
- Both entry points and a manual **Sync** button (on the Dashboard and the Games page) share a single in-process lock; concurrent runs never overlap.
- Cross-tab runs are serialized by the blob's ETag / If-Match optimistic-concurrency flow (see §5).
- Successful ingestion surfaces in the Dashboard Activity Feed (see §6).
- In-progress runs surface via a sync-status indicator on whichever page triggered them.
- Errors are silent in the UI (telemetry only).

---

## 3. Eligibility

A game is ingested only if **all** hold:

- Rated standard chess (no variants).
- Time class is blitz or rapid.
- `createdAt > watermarkMs` **and** `id ∉ recentIds`.
- `now − createdAt ≤ 5 days` (inclusive). Older games are never ingested.
- `createdAt ≤ now` (defends against clock skew — a future-dated game would otherwise be impossible to age out).

A game that produces no rating matches is still considered processed: it advances `watermarkMs`, joins `recentIds`, and (if a record can be built) gets a `GameRecord`.

First-time sync ingests only games from the last 5 days; there is no full-history backfill.

**On account unlink:**
- The `games[${platform}:${user}]` entry is removed from the blob — next ingest starts fresh.
- Stored `GameRecord` entries whose `wa` / `ba` matches the unlinked account are purged from every day's `practiceLog[].games.records`. Per-day counters (`ingested` / `reviewed` / `mistakes`) are left intact — historical activity remains visible on the Dashboard.

---

## 4. Annotation → Rating

The existing repertoire annotation drives ratings:

| Annotation at user move | FSRS rating | Card(s) rated |
|---|---|---|
| In repertoire | Good | `(fenBefore, playedSan)` |
| Deviation (first user move out of repertoire) | Again | **Every** repertoire card at that FEN |
| Opponent moves, out-of-repertoire-response, out-of-theory | ignored | — |

Ratings are timestamped with `game.createdAt` (not wall-clock). FENs are normalized using the same scheme as FSRS cards (halfmove clock reset).

**Per-card idempotence guard.** A rating is **skipped** for a card whose `last_review` is strictly **after** `game.createdAt`. This guard is what lets repeated runs and concurrent clients converge safely: a more-recent training-pass review of the same card is never overwritten by a re-processed older game, and a game that has already been ingested produces a no-op when processed again.

Each ingested game also updates per-day activity counters on the `practiceLog` entry for the date of `game.createdAt`, attributed in the user's **local timezone** (matches `ActivityService.getTodayDateString()`):

- `games.ingested` — increments for each eligible game whose **user color can be resolved**.
- `games.reviewed` — increments **once per Good rating actually applied** (per in-repertoire user move whose card passes the idempotence guard).
- `games.mistakes` — increments **once per game with a detected first deviation**, regardless of how many sibling cards exist at the deviation FEN. The intuition is "I made a mistake in this game"; per-card FSRS state still updates individually.

For each processed game, the pipeline also calls `buildGameRecord` and appends the result to the same day's `games.records[]` so the Games page can render it.

---

## 5. Multi-Client Concurrency

Ingest must be idempotent across devices.

- The blob's ETag / If-Match flow is the only coordination mechanism. A run is a single GET-compose-PUT pass; on `412` the run aborts and the app-level conflict modal handles user-facing recovery (page reload). The next Dashboard or Games mount re-runs ingest from the fresh blob.
- `watermarkMs` and `recentIds` advance **only on successful PUT**.
- Games present in `recentIds` are skipped even if `createdAt > watermarkMs`.
- **Cursor-only writes.** A run that produces zero eligible games but observes a changed Chess.com `providerCursor.etag` (or a missing → present transition) still issues a PUT so the cursor is persisted.

---

## 6. Retention

Across all days, total `GameRecord` count is capped at **100**. When ingest exceeds the cap it evicts the **oldest day's records as a whole**, repeating oldest-first until total ≤ 100.

- Eviction empties only the day's `records` array — per-day counters stay so the Activity Feed still shows the day had ingested games.
- A day is never partialled. If a single day alone exceeds the cap, its records are retained intact (the next day's ingest sheds it naturally).
- Eviction is part of the shared ingest write path, so the Games page's analysis pass never spends masters budget on records about to be dropped.

---

## 7. Dashboard Surface

The user-visible surface of ingest lives on the Dashboard. See [`DASHBOARD.md`](./DASHBOARD.md) §1.4 (Activity Feed — the "Played" line) and §2.1 (`games` sub-object schema, `getOrCreateEntryByDate` lifecycle, streak rule).

Ingest emits typed progress events (`fetching` per account, single `done` at the end) which the Dashboard renders as a sync-status indicator beside the Activity heading (syncing spinner / last-sync timestamp) plus a manual Sync button. Both render only after the first event fires, so a user with no linked accounts sees no sync chrome at all.

---

## 8. Out of Scope

- Storing raw (full-game) PGNs on the backend.
- Rendering per-game annotations on the Dashboard (that lives on the Games page).
- Unrated games, variants, bullet, daily/correspondence.
- Back-filling ratings for historical games when a repertoire variant is added later — `watermarkMs` advances one-way.
