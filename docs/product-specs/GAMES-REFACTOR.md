# Games Backend Storage — Product Specification

## Overview

Persist a user's recent games in the synced repertoire blob so they follow the user across devices. Games are nested inside the Dashboard activity feed — each game filed under the day it was played (see [`DASHBOARD.md`](./DASHBOARD.md)).

**Scope:** capture games during the existing Dashboard ingest pass ([`GAME-INGEST.md`](./GAME-INGEST.md)). The **/games page is unchanged** — it keeps its own IndexedDB cache.

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
      "ev": [20, 15, -150]      // optional: per-ply evals (cp), absent on chess.com
    }
  ]
}
```

**Derived, not stored:** user color / orientation and which account is the user — matched at read time from `wa`/`ba` against the linked accounts.

**Not stored:** annotations, clock-per-move, raw analysis (best lines / comments). All recomputable from `m` + repertoire.

## Retention

- Max **100 games total** across all days.
- On overflow: evict the **oldest day's games as a whole**, repeating oldest-first until ≤ 100. Never partial.
- Eviction removes only `records`; the day's other counters stay.
- If one day alone exceeds 100, keep it intact.

**Invariant:** a day's `records.length` is either equal to its `ingested` count, or `0`. Empty `records` with non-zero `ingested` means that day's games were evicted.

Record every game the ingest pass processes (any game with a determinable user color), regardless of whether its moves matched the repertoire.

Unlinking an account purges its stored game records (the games where the user played under that account), mirroring the /games page behavior.
