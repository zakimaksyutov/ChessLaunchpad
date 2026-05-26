# ChessLaunchpad — Project Description

Web app for memorizing chess openings via spaced repetition. Deployed at https://zakimaksyutov.github.io/ChessLaunchpad/.

## How It Works

Users import PGN-based opening repertoires (white and/or black). The FSRS spaced-repetition algorithm schedules reviews at the position level. During training, the system builds a review queue of due and new cards, plans a path through the repertoire tree to each target position, autoplays mastered positions at the start, and asks the user to recall moves around the target. Errors are flagged immediately with the correct move shown.

## Training System

Training is driven by [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs). Each user-turn position and its expected move form an FSRS card (`normalized FEN :: move SAN`). Transpositions share one card. PGN lines are flattened into a directed acyclic graph (DAG) at runtime.

### Review Queue

Before each traversal, a priority queue is rebuilt from all cards:

1. **Relearning** — failed recently, short-term schedule
2. **Due Review** — overdue, sorted by overdueness
3. **Learning** — still in initial learning steps
4. **New** — unseen cards

Training continues until the queue empties or the user navigates away.

### Path Planning

Each traversal is pre-computed before the first move. The system pulls the highest-priority card, computes a root-to-card path, and marks each user-turn position as **autoplay** (mastered prefix), **warm-up** (context before target), **target** (due card), or **cool-down** (context after target). If more due cards exist deeper on the same path, additional zones are appended.

### Autoplay

Mastered positions (Review state, not due, retrievability ≥ target retention) are auto-played as a strict prefix. Once the user plays a move, autoplay does not resume for the rest of the traversal.

### New Card Introduction

New cards use a teach-then-recall flow: the teaching pass shows the correct move (not rated), followed by an immediate recall pass (rated `Again`). Cards then enter Learning state with tight intervals.

### Rating

- Correct on first attempt → `Good`
- Any error → `Again`

### Ahead-of-Schedule Mode

When the queue is empty, the system drills cards with the lowest retrievability using the same path-planning flow.

### Progress Badges

Four badges on the training page: **review** (due Review-state cards in queue), **learning** (due Learning/Relearning cards in queue), **new** (unseen cards in queue), **today** (reviewed this day).

See `docs/product-specs/FSRS.md` for the full behavioral specification.

## Pages

| Route               | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `/`                 | Dashboard (logged-in) / Landing page (anonymous) |
| `/login`            | Authentication                                  |
| `/training`         | Interactive board training (FSRS-driven)        |
| `/repertoire`       | Browse / manage imported variants               |
| `/repertoire/variant` | View a single variant's PGN and annotations   |
| `/games`            | Annotated game history from linked Lichess and Chess.com accounts |
| `/settings`         | FSRS tuning, linked accounts, and account settings |

## Tech Stack

React 19 · TypeScript · Vite · Vitest · chess.js · ts-fsrs · chess-control (vendored) · Azure Functions backend · Application Insights telemetry.

## Lichess Integration

Users can connect their Lichess account via OAuth2 PKCE on the Settings page. No extra OAuth scopes are requested — only public APIs are used. The token is passed as a `Bearer` header to identify the caller and improve rate limits.

#### CLI / Agentic Access

A personal Lichess API token is stored in `.env` at the repo root (git-ignored) as `LICHESS_TOKEN`. Example query:

```sh
source .env && curl -s \
  -H "Authorization: Bearer $LICHESS_TOKEN" \
  "https://lichess.org/api/cloud-eval?fen=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"))')&multiPv=3" \
  | python3 -m json.tool
```

### Cloud Eval

The analysis popover fetches position evaluations from the public Lichess Cloud Eval API (`GET https://lichess.org/api/cloud-eval?fen=…&multiPv=N`). Responses are cached in-memory for the session. No authentication is required.

### Eval-Drop Highlighting

The Repertoire page highlights moves whose Lichess cloud evaluation drops significantly compared to the previous position. Thresholds (centipawn loss):

| Category   | Drop ≥ | Color  |
| ---------- | ------ | ------ |
| Inaccuracy | 30 cp  | Yellow |
| Mistake    | 50 cp  | Pink   |
| Blunder    | 70 cp  | Purple |

Evaluations are precomputed per-position (see `models/ExplorerEvals.ts`) with up to 2 centipawn values from different Stockfish depths. The eval-drop calculation uses all stored values conservatively: it evaluates every before×after pairing and uses the minimum drop to avoid false-positive highlights from eval instability (`services/EvalDropService.ts`).

## Data Flow

```
Browser ←→ Azure Functions REST API (/api/user/{id}/variants)
```

The entire repertoire (variants + FSRS cards + settings + activity) is stored as a single JSON blob with ETag-based optimistic concurrency. Legacy variant-level stats (`errorEMA`, `successEMA`, `lastSucceededEpoch`, `currentEpoch`) remain in the payload for backward compatibility but are zeroed on load and not used for scheduling. See `docs/BACKEND_API_CONTRACT.md`.

### Games Page Data Flow

The Games page downloads games from Lichess and Chess.com public APIs and stores them locally:

- **`LinkedAccountsService`** — Manages linked Lichess and Chess.com usernames in `localStorage`.
- **`LichessGamesService`** — Streams games via NDJSON from `lichess.org/api/games/user/{username}`, with incremental sync via per-user timestamp watermarks.
- **`ChesscomGamesService`** — Fetches games from the Chess.com monthly archives API, with incremental sync via per-user timestamp watermarks.
- **`GamesDB`** — IndexedDB storage (via `idb` library) for downloaded games, keyed by platform-specific game ID.
- **`RepertoireFenSet`** — Builds `Set<string>` of normalized FENs from the user's repertoire for cross-referencing.
- **`GameAnnotationService`** — Replays each game, compares positions against the repertoire FEN set, and computes eval-drop highlights for deviations. Uses `ExplorerEvals` (static pre-computed evals) and embedded Lichess analysis as eval sources. Consults `MastersExplorerService` for out-of-theory detection when eval data is ambiguous.
- **`MastersExplorerService`** — Wraps the Lichess Masters database API (`explorer.lichess.org/masters`) with in-memory and IndexedDB caching. Used to determine whether opponent deviations are still within known theory.
- **`OpponentAnalysisService`** — Downloads and scans an opponent's recent games to assess their familiarity with specific positions. Results are persisted in a separate IndexedDB store (`OpponentAnalysisDB`).
