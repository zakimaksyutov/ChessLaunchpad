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
| `/settings`         | Weight tuning and account settings              |

## Tech Stack

React 19 · TypeScript · Vite · Vitest · chess.js · chess-control (vendored) · Azure Functions backend · Application Insights telemetry.

## Lichess Integration

Users can connect their Lichess account via OAuth2 PKCE on the Settings page. No extra OAuth scopes are requested — only public APIs are used. The token is passed as a `Bearer` header to identify the caller and improve rate limits.

### Cloud Eval

The analysis popover fetches position evaluations from the public Lichess Cloud Eval API (`GET https://lichess.org/api/cloud-eval?fen=…&multiPv=N`). Responses are cached in-memory for the session. No authentication is required.

### Masters Opening Explorer

The analysis popover also fetches master-game statistics from the Lichess Opening Explorer (`GET https://explorer.lichess.ovh/masters?fen=…`). The response includes top continuations with game counts, win/draw/loss percentages, and average ratings. Responses are cached in-memory for the session.

#### CLI / Agentic Access

A personal Lichess API token is stored in `.env` at the repo root (git-ignored) as `LICHESS_TOKEN`. Example query:

```sh
source .env && curl -s \
  -H "Authorization: Bearer $LICHESS_TOKEN" \
  "https://explorer.lichess.ovh/masters?fen=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"))')" \
  | python3 -m json.tool
```

### Eval-Drop Highlighting

The Repertoire page highlights moves whose Lichess cloud evaluation drops significantly compared to the previous position. Thresholds (centipawn loss):

| Category   | Drop ≥ | Color  |
| ---------- | ------ | ------ |
| Inaccuracy | 30 cp  | Yellow |
| Mistake    | 50 cp  | Pink   |
| Blunder    | 70 cp  | Purple |

Evaluations are precomputed per-position (see `ExplorerEvals.ts`) and compared pairwise along each variant's move sequence (`EvalDropService.ts`).

### Master Theory Override

Eval-drop highlights can produce false positives when precomputed evaluations at different depths disagree, even though the move is standard opening theory. To suppress these, the Repertoire page cross-references every flagged move against the Lichess Masters Opening Explorer.

A highlight is suppressed if **any** of the following conditions are met:

1. **High game count**: The move has been played in ≥ 150 master games.
2. **Dominant top move**: The move is the #1 master continuation by game count, has ≥ 90% share of all games in the position, **and** no alternative move with ≥ 5% of games has a win-rate advantage of ≥ 5 percentage points (from the player's perspective).

Implementation details:

- **Cache**: Results are stored in IndexedDB (`chess-launchpad` database, `masters-explorer` store) with a 90-day TTL. Transient API errors (429, 5xx, network) are **not** cached.
- **Rate limiting**: API requests are throttled to one per 1.5 seconds. Cache hits bypass the throttle.
- **Progress indicator**: The Repertoire page toolbar shows real-time progress ("Checking master theory… (N/M)") and a done state ("✓ Master theory checked"). If Lichess is not connected, a prompt links to Settings.
- **Key files**: `MastersCacheService.ts`, `MastersEvalOverrideService.ts`, `MastersEvalOverrideService.test.ts`

## Data Flow

```
Browser ←→ Azure Functions REST API (/api/user/{id}/variants)
```

The entire repertoire (variants + stats + FSRS cards) is stored as a single JSON blob with ETag-based optimistic concurrency. See `backend-api-contract.md`.
