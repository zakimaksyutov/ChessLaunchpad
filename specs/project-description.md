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

## Data Flow

```
Browser ←→ Azure Functions REST API (/api/user/{id}/variants)
```

The entire repertoire (variants + stats + FSRS cards) is stored as a single JSON blob with ETag-based optimistic concurrency. See `backend-api-contract.md`.
