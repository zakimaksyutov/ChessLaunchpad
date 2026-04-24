# AGENTS.md

## Project Description

ChessLaunchpad is a web application for memorizing chess openings using spaced repetition. It helps players master their opening repertoires through interactive board training with an adaptive algorithm that prioritizes variants based on recency, error rate, frequency, and newness. Deployed at https://zakimaksyutov.github.io/ChessLaunchpad/.

## Tech Stack

- React 19 with TypeScript
- Vite for bundling and dev server
- Vitest for testing
- chess.js for game logic and PGN parsing
- chess-control (in-house) for interactive board rendering, vendored in `app/vendor/chess-control/`
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

### Start dev server

```sh
yarn dev
```

## Project Structure

- `app/` — React application source and configuration
  - `src/` — TypeScript source files (components, logic, tests)
  - `public/` — Static assets
  - `vendor/chess-control/` — Vendored chess-control library (built dist files)
- `openings/` — Opening database files and merge scripts
- `specs/` — Technical specifications
  - `backend-api-contract.md` — Backend REST API contract (copy from backend repo; do not edit here)

## Backend API

The backend is a REST API (`https://chess-prod-function.azurewebsites.net/api/user`) that stores user repertoire data as a validated JSON blob. See `specs/backend-api-contract.md` for the full contract. Do not edit that file directly — it is a copy from the backend repository.

If a feature requires backend contract changes, produce a separate spec in `specs/` describing the required changes. This spec will be copied to the backend repository for implementation.

## Updating chess-control

The chess-control library lives in `../ChessControl` and is vendored via `file:` dependency.

```sh
cd ../ChessControl && yarn build:lib
cp dist/chess-control.js dist/index.d.ts dist/ChessBoard.d.ts ../ChessLaunchpad/app/vendor/chess-control/
# Bump version in app/vendor/chess-control/package.json
cd ../ChessLaunchpad/app && yarn install
```

**Yarn version note:** The app is pinned to Yarn 4 via `app/package.json`, and CI uses Corepack plus `yarn install --immutable`. `app/.yarnrc.yml` is tracked so Yarn keeps using the `node-modules` linker instead of switching this project to Plug'n'Play. If `yarn` does not resolve to the pinned version on a machine, run `corepack enable` once and retry.

## Playwright / E2E

Test account credentials are in `.env` at the repo root (git-ignored). Use these to log in during Playwright-based automation.

## Vite Development Notes

The dev server is pinned to **port 5274** (`strictPort: true`) to avoid conflicts with sibling projects.

## Process — Lessons Learned

- **Never amend commits.** Always create new commits instead of using `git commit --amend`.
- Do not auto-commit. Leave changes uncommitted for review unless explicitly told to commit.