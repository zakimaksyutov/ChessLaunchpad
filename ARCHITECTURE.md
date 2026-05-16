# ChessLaunchpad — Project Description

Web app for memorizing chess openings via spaced repetition. Deployed at https://zakimaksyutov.github.io/ChessLaunchpad/.

## How It Works

Users import PGN-based opening repertoires (white and/or black). During training, the system picks a variant, autoplays opponent moves, and waits for the user to recall each correct move. Errors are flagged immediately with the correct move shown.

## Variant Selection

Variants are selected by weighted probability. Each variant's weight is the product of four factors:

| Factor    | Raises weight when…                        |
| --------- | ------------------------------------------ |
| Recency   | Variant hasn't been practiced recently     |
| Frequency | Variant is rarely played successfully      |
| Error     | Variant has a high error rate              |
| Newness   | Variant has been played fewer than 7 times |

Exponents for recency, frequency, and error are user-configurable.

## FSRS Autoplay

Per-position cards track mastery using the FSRS algorithm (ts-fsrs). Well-known positions at the start of a variant are autoplayed so training jumps straight to the moves the user actually needs to practice. Autoplay forms a strict prefix — once the user plays manually, it doesn't resume.

## Pages

| Route               | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `/`                 | Landing page                                    |
| `/login`            | Authentication                                  |
| `/training`         | Interactive board training                      |
| `/repertoire`       | Browse / manage imported variants               |
| `/repertoire/variant` | View a single variant's PGN and annotations   |
| `/games`            | Annotated game history from linked Lichess accounts |
| `/settings`         | Weight tuning and account settings              |

## Tech Stack

React 19 · TypeScript · Vite · Vitest · chess.js · chess-control (vendored) · Azure Functions backend · Application Insights telemetry.

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

The entire repertoire (variants + stats + FSRS cards) is stored as a single JSON blob with ETag-based optimistic concurrency. See `docs/BACKEND_API_CONTRACT.md`.

### Games Page Data Flow

The Games page downloads games from the Lichess public API and stores them locally:

- **`LinkedAccountsService`** — Manages linked Lichess usernames in `localStorage`.
- **`LichessGamesService`** — Streams games via NDJSON from `lichess.org/api/games/user/{username}`, with incremental sync via per-user timestamp watermarks.
- **`GamesDB`** — IndexedDB storage (via `idb` library) for downloaded games, keyed by Lichess game ID.
- **`RepertoireFenSet`** — Builds `Set<string>` of normalized FENs from the user's repertoire for cross-referencing.
- **`GameAnnotationService`** — Replays each game, compares positions against the repertoire FEN set, and computes eval-drop highlights for deviations.
