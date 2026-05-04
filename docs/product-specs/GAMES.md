# Games Page — Product Specification

## Overview

A new **Games** page that downloads recent games from linked chess accounts, visualizes them as an annotated list, and cross-references each game against the user's repertoire to surface theory coverage, time-pressure signals, and deviation points.

---

## V1 Scope

### 1. Account Linking

Users can **list** one or more Lichess usernames (no OAuth token required — games are fetched from the public API).

- Stored in `localStorage` as a JSON array under key `chesslaunchpad:linkedAccounts`.
- Managed on the **Settings** page: a "Linked Accounts" section with a text input + "Add" button to add a Lichess username, and a list of existing accounts each with a "Remove" button.
- V2: add `chess.com` as a second platform (platform selector dropdown next to the username input).

```ts
interface LinkedAccount {
  platform: 'lichess';       // V2: | 'chess.com'
  username: string;
}
// localStorage key: 'chesslaunchpad:linkedAccounts'
// value: JSON.stringify(LinkedAccount[])
```

### 2. Game Download

| Parameter | Value |
|-----------|-------|
| API | `GET https://lichess.org/api/games/user/{username}` |
| Format | NDJSON (`Accept: application/x-ndjson`) |
| Filters | `rated=true`, `perfType=blitz,rapid`, `clocks=true`, `evals=true`, `opening=true` |
| Batch size | Last **20** games per download |
| Incremental | Track `lastSyncTimestamp` per username in `localStorage`. On subsequent downloads, pass `since={lastSyncTimestamp+1}` to fetch only new games. |

Downloaded games are stored in **IndexedDB** using the `idb` library:

| Property | Value |
|----------|-------|
| DB name | `chesslaunchpad-games-db` |
| Store | `games` |
| Key path | `id` (Lichess game ID) |
| Indexes | `createdAt`, `username` |

Each stored record:

```ts
interface StoredGame {
  id: string;
  createdAt: number;
  username: string;        // lowercase Lichess username
  data: Record<string, unknown>;  // raw Lichess NDJSON object
}
```

Download is triggered manually via a **"Sync Games"** button on the Games page. A progress indicator shows "Downloading… N games" while the stream is active.

### 3. Games Page

New route: `/#/games` (protected, requires login).

Displays a list of recently downloaded games, most recent first.

#### 3.1 Game Row

Each game is rendered as a single row containing:

| Element | Description |
|---------|-------------|
| **Mini board** | Small chessboard (≈120px) showing the position at the first theory gap or end of theory. Board oriented to the user's color. |
| **Annotated PGN** | Opening portion of the game (see §3.2 for highlighting rules). Not the full game — only moves within the first ~20 plies or until theory ends, whichever is longer. |
| **Opponent** | Opponent username and rating |
| **Result** | Win / Draw / Loss (from the user's perspective) |
| **Time control** | e.g., "5+3", "10+0" |
| **Rated** | Badge or icon indicating rated vs casual |

#### 3.2 PGN Annotation & Highlighting

For each user move in the displayed PGN, apply the following highlights (in priority order):

1. **In-repertoire (positive)** — The position after this move matches a FEN that exists in the user's repertoire data. Highlight with a **green** background. Determined by replaying the game with `chess.js` and checking whether each resulting FEN appears in any variant's move sequence.

2. **Theory deviation with eval drop** — The user deviated from the repertoire (the position before the move is in the repertoire but the move played is not the repertoire move) **and** the deviation caused an eval drop. Use the existing `EvalDropService` + `ExplorerEvals` to compute the eval drop. Apply the same thresholds already used on the Repertoire page (inaccuracy ≥ 30cp, mistake ≥ 50cp, blunder ≥ 70cp). Highlight with the corresponding color from the existing `EVAL_DROP_COLORS` palette.

   Moves that are in the repertoire are always **green**, even if they have an eval drop — those drops are intentional choices and are already surfaced on the Repertoire page. Only moves that deviate from the repertoire are candidates for eval-drop highlighting.

3. **Out of theory (neutral)** — Moves after theory ends are shown in default styling (no highlight).

#### 3.3 Mini Board Position

The mini board shows the position at the **first notable event**, chosen in this priority:
1. The position where the user first deviated from repertoire.
2. The position where the user had the first eval-drop (≥ inaccuracy).
3. The last position that was still in-repertoire (end of theory).
4. The starting position (if no repertoire overlap at all).

### 4. Repertoire Cross-Reference

To determine whether a position is "in repertoire," the system:

1. Loads the user's `RepertoireData` (same data source as the Training and Repertoire pages).
2. For each variant, replays the PGN with `chess.js` to build a set of FENs (compact: pieces + side + castling).
3. Builds a combined `Set<string>` of all repertoire FENs for the user's color.
4. While replaying each game, checks each position against this set.

This FEN set is computed once (memoized) and shared across all game rows.

---

## V2 Scope (Future)

### Opponent Theory Detection

For each game where the user had a theory gap (deviation or eval drop), determine whether the opponent was **more prepared**:

1. Download the opponent's last **1,000** games from the Lichess API (same NDJSON endpoint, cached in IndexedDB).
2. Replay each opponent game to check how many times the opponent reached the gap position.
3. If the opponent has played this position **≥ 5 times**, tag the game row with an **"Opponent knew this"** badge.

This helps the user understand whether their theory gap was exploited by a prepared opponent.

### Chess.com Support

Add `chess.com` as a second platform in account linking. Requires a different API (`https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}`), different game format (PGN-based), and separate download/parsing logic.

---

## Technical Notes

### Dependencies

- **`idb`** — Promise wrapper for IndexedDB (already used in sibling Repertoire project; add as a new dependency).
- **`chess.js`** — Already in the project for PGN replay and FEN generation.
- **`ExplorerEvals`** / **`EvalDropService`** — Reuse existing services for eval-drop detection.

### Data Flow

```
Settings Page                  Games Page
─────────────                  ──────────
 [Add Lichess username] ──→ localStorage: linkedAccounts[]
                                    │
                              [Sync Games] button
                                    │
                              Lichess NDJSON API
                                    │
                              IndexedDB: games store
                                    │
                          ┌─────────┴─────────┐
                          │                   │
                    RepertoireData      ExplorerEvals
                          │                   │
                     FEN matching        Eval drops
                          │                   │
                          └─────────┬─────────┘
                                    │
                              Annotated game rows
                              (PGN + mini board)
```

### Storage Budget

| Store | Estimated size |
|-------|---------------|
| 20 games × ~5KB each | ~100KB per sync |
| Repertoire FEN set | ~50KB (computed in memory, not stored) |

IndexedDB storage is effectively unlimited for this volume.

### IndexedDB Performance Guidelines

These patterns are proven in the sibling Repertoire project and should be followed here:

1. **Batched writes in a single transaction** — When storing multiple games, open one `readwrite` transaction and `put()` all records inside it, then `await tx.done`. Do not open a separate transaction per game.
2. **Use indexes for sorted reads** — The `createdAt` index allows `getAllFromIndex(store, 'createdAt')` to return games in chronological order without client-side sorting.
3. **Use `count()` for counts** — When only the number of games is needed (e.g., showing "N games stored"), use `db.count(store)` instead of loading all records.
4. **Singleton DB connection** — Cache the `openDB()` promise at module level so all callers share one connection (same pattern as `db.ts` in Repertoire).
5. **Avoid repeated API calls during development** — Download games once and rely on IndexedDB cache for subsequent loads and test runs. Playwright tests should use pre-populated IndexedDB or mock the Lichess API.
