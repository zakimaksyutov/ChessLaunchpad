# AGENTS.md

## Project Description

ChessLaunchpad is a web application for memorizing chess openings using spaced repetition. It helps players master their opening repertoires through interactive board training driven by the FSRS algorithm, which schedules position-level reviews via a priority queue and plans traversals through the repertoire tree. Deployed at https://zakimaksyutov.github.io/ChessLaunchpad/.

For a deeper understanding of the product (FSRS training system, pages, data flow), see `ARCHITECTURE.md`.

## Tech Stack

- React 19 with TypeScript
- Vite for bundling and dev server
- Vitest for testing
- chess.js for game logic and PGN parsing
- ts-fsrs for spaced-repetition scheduling
- chess-control (in-house) for interactive board rendering, vendored in `app/vendor/chess-control/`
- idb for IndexedDB access (Lichess cloud-eval cache)
- React Router for client-side routing
- Microsoft Application Insights for telemetry

## Build and Test

All commands run from the `app/` directory.

### Install dependencies

```sh
cd app
yarn install
```

### Build

```sh
yarn build
```

### Run tests

```sh
yarn test
```

### Run E2E tests (Playwright)

```sh
yarn test:e2e
```

### Start dev server

```sh
yarn dev
```

## Project Structure

- `app/` — React application source and configuration
  - `src/` — TypeScript source files
    - `pages/` — Route-level page components and their CSS
    - `components/` — Reusable UI components and their CSS
    - `services/` — Business logic and API clients
    - `models/` — TypeScript interfaces and data types
    - `utils/` — Helper and utility functions
    - `data/` — Database and storage layer
  - `public/` — Static assets
  - `vendor/chess-control/` — Vendored chess-control library (built dist files)
- `openings/` — Opening database files and merge scripts
- `docs/` — Technical specifications
  - `BACKEND_API_CONTRACT.md` — Backend REST API contract (copy from backend repo; do not edit here)
  - `REPERTOIRE-STORAGE.md` — Position-centric repertoire data model and v3 wire format reference
  - `INSTRUMENTATION.md` — Instrumentation and telemetry reference
  - `product-specs/FSRS.md` — FSRS training system specification
  - `product-specs/GAMES.md` — Games page product specification
  - `product-specs/GAME-INGEST.md` — Game ingestion pipeline specification
  - `product-specs/DASHBOARD.md` — Dashboard page product specification
  - `product-specs/EXPLORER.md` — Explorer page (`/explorer`) product specification

## Backend API

The backend is a REST API (`https://chess-prod-function.azurewebsites.net/api/user`) that stores user repertoire data as a validated JSON blob. See `docs/BACKEND_API_CONTRACT.md` for the full contract. Do not edit that file directly — it is a copy from the backend repository.


## Playwright / E2E

Test account credentials are in `.env` at the repo root (git-ignored). Use these to log in during Playwright-based automation.

## Vite Development Notes

The dev server is pinned to **port 5274** (`strictPort: true`) to avoid conflicts with sibling projects.

## Process — Lessons Learned

- **Never amend commits.** Always create new commits instead of using `git commit --amend`.
- Do not auto-commit. Leave changes uncommitted for review unless explicitly told to commit.
- **Baseline before big changes.** Run `yarn test` and `yarn test:e2e` before starting to confirm they pass, so failures after your changes aren't misattributed.