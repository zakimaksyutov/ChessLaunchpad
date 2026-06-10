# Games Backend Storage — Product Specification

## Overview

Persist a user's recent games in the synced repertoire blob so they follow the user across devices. Games are nested inside the Dashboard activity feed — each game filed under the day it was played (see [`DASHBOARD.md`](./DASHBOARD.md)).

**Scope:** two parts. (1) Capture games during the existing Dashboard ingest pass ([`GAME-INGEST.md`](./GAME-INGEST.md)). (2) Tighten the **/games page** analysis flow (see "/games analysis" below). Changes to /games behavior are specified here, not in [`GAMES.md`](./GAMES.md); a later pass reconciles the two.

## Storage location

Game records live in each day's `activity.practiceLog[].games` sub-object, next to that day's ingest counters. A game belongs to the day it was played.

```jsonc
"games": {
  "ingested": 6, "reviewed": 18, "mistakes": 2,   // existing counters
  "records": [                                      // NEW
    {
      "id": "abc123",           // provider id (lichess id | chess.com uuid)
      "p": "l",                 // platform: "l" | "c"
      "t": 1716633000000,       // createdAt (ms) — intra-day sort
      "m": "e4 e5 Nf3 Nc6 …",   // SAN moves, space-separated
      "wa": "Alice", "wr": 1850, // white account, rating
      "ba": "Bob",   "br": 1875, // black account, rating
      "res": "win",             // result, user POV: "win"|"draw"|"loss"
      "tc": "5+3",              // time control
      "sp": "blitz",            // speed / time class
      "rt": 1,                  // rated: 0 | 1
      "o": "Italian Game",      // opening name
      "ev": [20, 15, -150],     // optional: per-ply evals (cp), absent on chess.com
      "an": { … },              // optional: masters-theory verdict; present = analysis done (see below)
      "op": { … }               // optional: saved opponent-analysis result (see below)
    }
  ]
}
```

**Ingest normalization:**
- `wa`/`ba` are stored **lowercased** (canonical account handle) and matched **case-insensitively**. One rule for orientation derivation and unlink-purge, no casing surprises. (Trade-off: display shows the lowercased handle. If provider display-casing matters, the alternative is store exact-case + lowercase only at compare — same storage cost.)
- For Chess.com, `o` lives only in the PGN `[ECOUrl …]` header, which is discarded when the PGN is reduced to bare SAN `m`. **Extract `o` before stripping** — it is not recoverable from `m`. (Lichess is unaffected: `o` is a separate field.)

**Derived, not stored:** user color / orientation and which account is the user — matched at read time from `wa`/`ba` against the linked accounts.

**Not stored:** full annotations (highlights, mini-board), clock-per-move, raw analysis prose. All recomputable in-memory from `m` + repertoire + `ev`. Only the **masters-derived theory verdict** (`an`) is stored, because it depends on a rate-limited network source and cannot be recomputed offline.

**No automatic invalidation:** `an`/`op` are not invalidated when the repertoire changes. A stale verdict simply persists; the user re-runs it via the existing "Re-analyze" context-menu action, which clears `an` (and `op`) for that game so it re-queues.

## Retention

- Max **100 games total** across all days.
- On overflow: evict the **oldest day's games as a whole**, repeating oldest-first until ≤ 100. Never partial.
- Eviction removes only `records`; the day's other counters stay.
- If one day alone exceeds 100, keep it intact.

**Invariant:** a day's `records.length` is either equal to its `ingested` count, or `0`. Empty `records` with non-zero `ingested` means that day's games were evicted.

Record every game the ingest pass processes (any game with a determinable user color), regardless of whether its moves matched the repertoire.

Unlinking an account purges its stored game records (the games where the user played under that account), mirroring the /games page behavior.

## /games analysis

The current /games analysis is jarring — unsolicited popups and long progress bars. Gate it on a connected Lichess account.

- **Theory source:** the masters opening explorer (`explorer.lichess.org/masters`) is the essential "is this move still in theory" source. It requires a Lichess OAuth token (existing `LichessAuthService`).
- **Requirement:** analysis runs only when a Lichess account is **connected** (OAuth, not just a linked username).
- **When not connected:** do not run analysis. Show a single inline "Connect Lichess" prompt instead of popups, with a "Don't have one? Create a free account" link to Lichess signup (`https://lichess.org/signup`).
- **Platform asymmetry:** this is Lichess-only — Chess.com has no explorer or equivalent token. A Chess.com-only user must still connect a *Lichess* account to get masters theory.

### No IndexedDB — backend is the source of truth

The /games page drops all device-local storage. The three current IndexedDB stores (downloaded games, masters cache, opponent-analysis results) are removed; everything reads from the backend records.

- **Two-phase write:** Dashboard ingest writes the game facts (no `an`). The /games page, when Lichess is connected, analyzes records that lack `an`, then writes the compact verdict back to the record. Once written, it syncs across devices — a game is analyzed once, then instant everywhere.
- **Show only analyzed games:** the list renders only records that have `an`. Annotation highlights and mini-board are recomputed in-memory from the record on render.
- **Opponent analysis:** its result also persists in the backend record (compact — counts + a few game links), not IndexedDB.

### Landing flow

On opening /games:

0. **Render immediately** from existing records that already have `an` (sorted, newest first).
1. **Background download** — trigger the same game sync the Dashboard runs ([`GAME-INGEST.md`](./GAME-INGEST.md)), the same silent way (render first, sync after). New games are persisted; this step alone causes no list movement.
2. **Evict, then persist** — apply the 100-game eviction (Retention) as part of that persist, *before* analysis, so masters budget is never spent on games about to be dropped.
3. **Analyze newest-first** — process records lacking `an` one at a time, **newest first**, through a sequential queue (bounded by the masters rate limit). Analysis order is an internal scheduling concern; newest-first means the game the user most likely came for resolves first.
4. **Reveal as-ready — no gate** — the moment a game's `an` is written, insert it at its sorted position (top of the list in the common case). Games appear one by one as they complete; there is no withholding of newer games behind an unfinished older one. A spinner pinned to the top of the list shows progress ("Analyzing N of M").
5. **Sync-only games** — a game needing no masters lookup is marked analyzed (`an` written) and revealed like any other, as soon as it's processed.

**Batched writes:** `an` results are flushed to the backend in batches (e.g., every N games or on queue-drain), not one PUT per game, to limit full-blob churn. Writes use the standard optimistic-concurrency PUT; on a 412 conflict, re-fetch and re-apply (verdicts are deterministic, so redo is safe — this also covers concurrent devices/tabs).

### `an` — masters-theory verdict

Present once a game is analyzed (the page's "done" marker). Holds only the masters-dependent decisions; everything else is recomputed.

```jsonc
"an": {
  "tv": [                 // RESOLVED masters verdicts for ambiguous opponent moves (15–44cp)
    { "ply": 12, "in": true },   // confirmed in theory
    { "ply": 16, "in": false }   // confirmed out of theory
    // no-data plies are OMITTED (sparse map) — see below
  ]
}
```

- Verdicts are keyed by `ply` (replay is deterministic, so plies are stable). `in` = "still in theory."
- `tv` is a **sparse map of resolved verdicts only**. An ambiguous ply that masters had **no data** for is omitted, not stored as `false`. This avoids conflating "confirmed out of theory" with "no data" — a one-way door — and lets a future pass retry only the no-data plies without a full re-analyze.
- At render, a ply the recompute deems ambiguous but absent from `tv` = no-data = the engine's existing **optimistic in-theory default** (matches `GameAnnotationService` today). Note this is *in*-theory, not out.
- Empty `tv` is valid — a game with no ambiguous positions (or all ambiguous plies were no-data) is still analyzed once `an` is present.

### `op` — saved opponent-analysis result

Optional, on-demand (only for eligible games the user chose to analyze). Independent of `an`.

```jsonc
"op": {
  "ply": 14,              // anchor: ply of the analyzed deviation (the user's bad move)
  "m": 842,               // opponent games analyzed
  "nb": 7,                // count reaching fenBefore (after opponent's out-of-rep move)
  "na": 2,                // count reaching fenAfter (after user's bad response)
  "os": "Nxe4",           // opponent move SAN (critical)
  "us": "exd6",           // user move SAN (critical)
  "rb": [ { "d": 1715000000000, "u": "https://lichess.org/abc" } ],  // ≤5 recent before-games
  "ra": [ { "d": 1714000000000, "u": "https://lichess.org/xyz" } ],  // ≤5 recent after-games
  "at": 1716700000000     // analyzedAt (ms) — when computed
}
```

- **`ply` anchors the analysis to a specific deviation.** `os`/`us` SAN strings are not unique within a game, and `m` is immutable so the ply is a stable key (same basis as `tv`'s ply keys). Render attaches `op` to the recomputed deviation at that ply; if no current deviation sits there (e.g. after a repertoire change), treat the saved `op` as stale.
- One analysis per game today. Supporting **multiple** opponent analyses per game later is a clean extension: `op` becomes an array of these objects, each keyed by its `ply`.
- **Derived, not stored:** threat level (from `nb`), platform (= record `p`), opponent username (the non-user side of `wa`/`ba`).
