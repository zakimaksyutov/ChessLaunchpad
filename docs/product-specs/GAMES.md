# Games Page — Product Specification

## Overview

A new **Games** page that downloads recent games from linked Lichess and Chess.com accounts, visualizes them as an annotated list, and cross-references each game against the user's repertoire to surface theory coverage and deviation points.

---

## 1. Account Linking

Users can **list** one or more usernames across supported platforms (no OAuth token required — games are fetched from public APIs).

Supported platforms:
- **Lichess** — public NDJSON API
- **Chess.com** — public archives API

- Stored in `localStorage` as a JSON array under key `chesslaunchpad:linkedAccounts`.
- Managed on the **Settings** page: a "Linked Accounts" section with a platform dropdown, text input + "Add" button, and a list of existing accounts each with a "Remove" button.
- Removing an account also clears its sync watermark from `localStorage` and **deletes** the account's cached games from IndexedDB.
- **Clear Cache** button (in Settings, visible when accounts are linked) deletes all downloaded games from IndexedDB and resets all sync timestamps so the next sync performs a fresh initial fetch.
- **Logout** clears all Games data: IndexedDB game store, linked accounts list, and all per-account sync timestamps (both legacy and current key formats).

```ts
type Platform = 'lichess' | 'chess.com';

interface LinkedAccount {
  platform: Platform;
  username: string;
}
// localStorage key: 'chesslaunchpad:linkedAccounts'
// value: JSON.stringify(LinkedAccount[])
```

## 2. Game Download

### 2.1 Lichess

| Parameter | Value |
|-----------|-------|
| API | `GET https://lichess.org/api/games/user/{username}` |
| Format | NDJSON (`Accept: application/x-ndjson`) |
| Filters | `rated=true`, `perfType=blitz,rapid`, `clocks=true`, `evals=true`, `opening=true` |
| Batch size | Last **100** games on initial download |
| Incremental | Track `lastSyncTimestamp` per account in `localStorage`. On subsequent downloads, pass `since={lastSyncTimestamp+1}` with `sort=dateAsc` to fetch all new games. |

### 2.2 Chess.com

| Parameter | Value |
|-----------|-------|
| Archives API | `GET https://api.chess.com/pub/player/{username}/games/archives` |
| Monthly API | `GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}` |
| Format | JSON with `games[]` array; each game includes a `pgn` field |
| Filters | `rated=true`, `time_class` in `[blitz, rapid]`, `rules=chess` |
| Batch size | Last **100** eligible games on initial download |
| Incremental | Track `lastSyncTimestamp` per account. Fetch all archive months from the watermark month onward, skip games older than watermark. |
| ID format | `chesscom_{uuid}` (prefixed to avoid collision with Lichess IDs) |

### 2.3 Storage

Downloaded games are stored in **IndexedDB** using the `idb` library:

| Property | Value |
|----------|-------|
| DB name | `chesslaunchpad-games-db` |
| Store | `games` |
| Key path | `id` (platform-specific: Lichess game ID or `chesscom_` + UUID) |
| Indexes | `createdAt`, `username` |

Each stored record:

```ts
interface StoredGame {
  id: string;
  createdAt: number;
  username: string;           // lowercase username
  platform?: Platform;        // 'lichess' | 'chess.com' (missing = 'lichess' for legacy records)
  data: Record<string, unknown>;  // raw game object (Lichess NDJSON or Chess.com JSON)
}
```

### 2.4 Sync Watermarks

Watermarks are stored per account as:
```
localStorage key: chesslaunchpad:lastSyncTimestamp:{platform}:{username}
```

Legacy Lichess keys (`chesslaunchpad:lastSyncTimestamp:{username}`) are read as fallback and migrated on next sync.

Download is triggered manually via a **"Sync Games"** button on the Games page. A progress indicator shows "Downloading… N games" while the stream is active. Sync runs for all linked accounts across both platforms.

Only games from currently linked accounts are displayed. Unlinking an account removes its cached games and sync watermark.

## 3. Games Page

New route: `/#/games` (protected, requires login). Nav link in the header.

Displays a list of recently downloaded games, most recent first.

### 3.1 Game Row

Each game is rendered as a single row containing:

| Element | Description |
|---------|-------------|
| **Mini board** | Small chessboard (≈120px) showing the position at the first theory gap or end of theory. Board oriented to the user's color. |
| **Annotated PGN** | Opening portion of the game (see §3.2 for highlighting rules). Approximately the first ~30 plies or until theory ends + a short buffer, whichever is longer. |
| **Players** | Both White and Black player names with ratings; the user's name is visually emphasized. |
| **Result** | Win / Draw / Loss (from the user's perspective) |
| **Time control** | e.g., "5+3", "10+0" |
| **Rated** | Badge indicating rated vs casual |
| **Opening** | Opening name (from Lichess `opening.name` or Chess.com `ECOUrl` header) |
| **Date** | Game date |
| **View on platform** | Link to the game on the originating platform, oriented to the user's color. Lichess: `https://lichess.org/{id}/{color}`. Chess.com: `https://www.chess.com/game/live/{uuid}`. |

### 3.2 PGN Annotation & Highlighting

For each user move in the displayed PGN, apply the following highlights (in priority order):

1. **In-repertoire (positive)** — The position after this move matches a FEN that exists in the user's repertoire data. Highlight with a **green** background. Determined by replaying the game with `chess.js` and checking whether each resulting FEN appears in any variant's move sequence.

2. **Theory deviation with eval drop** — The user deviated from the repertoire (the position before the move is in the repertoire but the move played is not the repertoire move) **and** the deviation caused an eval drop. Use the existing `EvalDropService` + `ExplorerEvals` to compute the eval drop. Apply the same thresholds already used on the Repertoire page (inaccuracy ≥ 30cp, mistake ≥ 50cp, blunder ≥ 70cp). Highlight with the corresponding eval-drop color.

   This also applies when the **opponent** deviates from the repertoire — the user's first response move after the opponent's deviation is evaluated for an eval drop using the same logic. This surfaces whether the user handled the surprise well.

   Moves that are in the repertoire are always **green**, even if they have an eval drop — those drops are intentional choices and are already surfaced on the Repertoire page. Only moves that deviate from the repertoire are candidates for eval-drop highlighting.

   Deviations without eval data are shown with a subtle orange highlight to remain visible.

3. **Out of theory (neutral)** — Moves after theory ends are shown in default styling (no highlight).

Opponent moves are displayed in a dimmed style to visually distinguish them from user moves.

### 3.3 Mini Board Position

The mini board shows the position at the **first notable event**, chosen in this priority:
1. The position where the user first deviated from repertoire.
2. The position where the user had the first eval-drop (≥ inaccuracy).
3. The last position that was still in-repertoire (end of theory).
4. The starting position (if no repertoire overlap at all).

When the user deviated from repertoire, the mini board also shows **arrows**: green arrows for the repertoire moves from that position and a red arrow for the user's actual move.

### 3.4 Deviation & Eval Drop Summaries

Below the PGN, game rows display contextual summaries:

- **Deviation summary** — When the user deviated from repertoire, a text callout shows "Repertoire has **X** but you played **Y**" with a warning icon.
- **End-of-theory eval drop summary** — When the opponent deviated and the user's response had an eval drop, a summary shows the user's move and its eval-drop category (inaccuracy/mistake/blunder).

### 3.5 Post-Theory Extended Analysis

When the opponent deviates from the repertoire, the system evaluates not just the user's first response but continues analyzing subsequent user moves for eval drops. Analysis stops when the opponent plays a move with an eval drop ≥ 50cp (indicating the opponent left "overall theory"). This surfaces whether the user handled the surprise well across multiple moves.

### 3.6 Game Row Visual Indicators

Game row tiles have a colored left border indicating status:
- **Purple border** — User deviated from repertoire.
- **Category-colored border** — End-of-theory eval drop (gold for inaccuracy, red for mistake, purple for blunder).
- **No border** — Game stayed in repertoire or had no notable events.

### 3.7 Display Limits

The Games page displays at most **100** games. Games are filtered to only those from currently linked accounts and where the user can be identified as a player.

## 4. Repertoire Cross-Reference

To determine whether a position is "in repertoire," the system:

1. Loads the user's `RepertoireData` (same data source as the Training and Repertoire pages).
2. For each variant, replays the PGN with `chess.js` to build a set of FENs (normalized: halfmove and fullmove clocks reset for transposition matching).
3. Builds two `Set<string>` — one for white variants, one for black — so each game uses only the FEN set matching the user's color in that game.
4. While replaying each game, checks each position against the appropriate set.

The FEN sets are computed once (memoized) and shared across all game rows.

---

## Technical Notes

### Dependencies

- **`idb`** — Promise wrapper for IndexedDB.
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
| 100 games × ~5KB each | ~500KB per sync |
| Repertoire FEN set | ~50KB (computed in memory, not stored) |

IndexedDB storage is effectively unlimited for this volume.
