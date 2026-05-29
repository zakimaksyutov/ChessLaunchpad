# Games Page — Product Specification

## Overview

A new **Games** page that downloads recent games from linked Lichess and Chess.com accounts, visualizes them as an annotated list, and cross-references each game against the user's repertoire to surface theory coverage and deviation points.

---

## 1. Account Linking

Users can **list** one or more usernames across supported platforms (no OAuth token required — games are fetched from public APIs).

Supported platforms:
- **Lichess** — public NDJSON API
- **Chess.com** — public archives API

- Stored on the user's repertoire blob under `settings.linkedAccounts` (persisted via the backend; not localStorage).
- Managed on the **Settings** page: a "Linked Accounts" section with a platform dropdown, text input + "Add" button, and a list of existing accounts each with a "Remove" button.
- Removing an account also clears its sync watermark from `localStorage` and **deletes** the account's cached games from IndexedDB.
- **Clear Cache** button (in Settings, visible when accounts are linked) deletes all downloaded games from IndexedDB and the Masters Explorer cache. Per-account sync timestamps are **not** reset, so the next sync remains incremental — to force a full re-fetch, unlink and re-link the account.
- **Logout** clears all Games data: IndexedDB game store, the in-memory linked-accounts cache, and the per-account sync timestamps in `localStorage`.

```ts
type Platform = 'lichess' | 'chess.com';

interface LinkedAccount {
  platform: Platform;
  username: string;
}
// Persisted as part of the repertoire blob: RepertoireData.settings.linkedAccounts
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

2. **Theory deviation with eval drop** — The user deviated from the repertoire (the position before the move is in the repertoire but the move played is not the repertoire move) **and** the deviation caused an eval drop. Eval drops are computed using multiple sources in priority order:

   1. **ExplorerEvals** — Pre-computed static evals for repertoire positions (instant, no network).
   2. **Embedded Lichess analysis** — Per-ply centipawn evals from the Lichess game's `analysis[]` array, already stored in IndexedDB. Only available for Lichess games with server analysis.

   Apply the same thresholds already used on the Repertoire page (inaccuracy ≥ 30cp, mistake ≥ 50cp, blunder ≥ 70cp). Highlight with the corresponding eval-drop color.

   This also applies when the **opponent** deviates from the repertoire — the user's first response move after the opponent's deviation is evaluated for an eval drop using the same logic. This surfaces whether the user handled the surprise well.

   Moves that are in the repertoire are always **green**, even if they have an eval drop — those drops are intentional choices and are already surfaced on the Repertoire page. Only moves that deviate from the repertoire are candidates for eval-drop highlighting.

   Deviations without eval data are shown with a subtle orange highlight to remain visible.

3. **Out of repertoire (neutral)** — Opponent moves that leave the user's repertoire but are still within overall theory (reasonable moves with eval drop below the out-of-theory threshold). These are shown in dimmed opponent styling.

4. **Out of theory (neutral)** — Moves after theory truly ends (opponent blundered out of theory, or all theory connection is lost). Shown in default styling (no highlight).

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
- **Out-of-repertoire eval drop summary** — When the opponent deviated and the user's response had an eval drop, a summary shows the user's move and its eval-drop category (inaccuracy/mistake/blunder).

### 3.5 Post-Theory Extended Analysis

When the opponent deviates from the repertoire, the system evaluates not just the user's first response but continues analyzing subsequent user moves for eval drops. Analysis stops when the opponent plays a move with an eval drop ≥ 50cp (indicating the opponent left "overall theory"). This surfaces whether the user handled the surprise well across multiple moves.

### 3.6 Game Row Visual Indicators

Game row tiles have a colored left border indicating status:
- **Purple border** — User deviated from repertoire.
- **Category-colored border** — Out-of-repertoire eval drop (gold for inaccuracy, red for mistake, purple for blunder).
- **No border** — Game stayed in repertoire or had no notable events.

### 3.7 Display Limits

The Games page displays at most **100** games. Games are filtered to only those from currently linked accounts and where the user can be identified as a player.

### 3.8 Opponent Theory Detection

When a game has an out-of-repertoire eval-drop summary (the opponent deviated from repertoire and the user's response was an inaccuracy, mistake, or blunder), the row's **⋯** overflow menu shows an **"Analyze opponent games"** action.

| State | Behavior |
|-------|----------|
| Eligible game | Overflow menu shows **"Analyze opponent games"** |
| Saved analysis present | Overflow menu shows **"Opponent analysis ✓"** and the item is disabled |
| Another row is already analyzing | Other rows' analyze actions are disabled until the active analysis completes or is aborted |

Selecting **"Analyze opponent games"** downloads up to **1,000** of the opponent's most recent public games from the same platform as the source game:

- **Lichess** — NDJSON streaming API
- **Chess.com** — archives API
- **Excluded** — bullet games
- **Auth** — no authentication required; only public APIs are used

The analysis replays each downloaded game with `chess.js` only up to the target ply (the ply of the user's bad move). It normalizes FENs and checks whether the game reached either of these critical positions:

- **`fenBefore`** — the position after the opponent's out-of-repertoire move
- **`fenAfter`** — the position after the user's inaccurate / mistaken / blunder response

While the download and scan are running, the game row shows a progress indicator below the out-of-repertoire eval-drop summary:

- Text: **"Analyzing opponent's games… N"**
- A percentage progress bar reflecting download / analysis completion

When analysis completes, the row shows:

- A color-coded status icon
- Summary text in the form **"Opponent has N games after {oppSan} and K after {userSan} (of M analyzed)"**
- A threat-level label based on how often the opponent previously reached **`fenBefore`**
- Links to the opponent's **5 most recent** games that reached those critical positions, labeled by date

Threat levels use the following thresholds:

| `fenBefore` count | Visual treatment | Label |
|-------------------|------------------|-------|
| 0-2 | Green info icon | **Opponent likely unfamiliar with this position** |
| 3-9 | Gold warning icon | **Opponent has some experience here** |
| 10-24 | Red warning icon | **Opponent knows this position well** |
| 25+ | Purple exclamation icon | **Opponent is very experienced here** |

Opponent-analysis results are persisted separately from downloaded Games data:

| Property | Value |
|----------|-------|
| IndexedDB DB name | `chesslaunchpad-opponent-analysis` |
| Lifetime | Loaded when the Games page mounts and survives page reloads |
| Scope | Stores saved opponent-analysis results per analyzed game |

Cache invalidation rules:

- **Re-annotate** clears the game's saved opponent-analysis result and aborts any in-flight analysis for that game.
- Saved analysis remains visible until re-annotation occurs.

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
- **`LichessCloudEvalService`** — Cloud eval API with IndexedDB persistence (currently disabled for batch annotation; used on-demand by `AnalysisPopover`).

### Eval Sources

The annotation logic tries eval sources in priority order to compute eval drops for post-theory and deviation moves:

| Priority | Source | Scope | Network |
|----------|--------|-------|---------|
| 1 | `ExplorerEvals` | Repertoire positions only (static JSON) | No |
| 2 | Embedded Lichess analysis | Lichess games with server analysis (`analysis[]` in stored game data) | No (already in IndexedDB) |

Embedded evals are single-value (not multi-PV), so `computeConservativeDrop` receives 1-element arrays. Chess.com games do not include embedded evals — only ExplorerEvals applies.

### Data Flow

```
Settings Page                  Games Page
─────────────                  ──────────
 [Add Lichess username] ──→ localStorage: linkedAccounts[]
                                    │
                              [Sync Games] button
                                    │
                         ┌──────────┴──────────┐
                    Lichess NDJSON API    Chess.com API
                    (with evals=true)
                         └──────────┬──────────┘
                                    │
                              IndexedDB: games store
                              (includes raw game data
                               with embedded analysis)
                                    │
                          ┌─────────┴─────────┐
                          │                   │
                    RepertoireData      Eval sources
                          │            ┌──────┴──────┐
                     FEN matching   ExplorerEvals  Embedded
                          │          (static JSON)  analysis
                          │            └──────┬──────┘
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
