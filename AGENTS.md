# AGENTS.md

## Project Description

ChessLaunchpad is a web application for memorizing chess openings using spaced repetition. It helps players master their opening repertoires through interactive board training with an adaptive algorithm that prioritizes variants based on recency, error rate, frequency, and newness. Deployed at https://zakimaksyutov.github.io/ChessLaunchpad/.

## Tech Stack

- React 19 with TypeScript
- chess.js for game logic and PGN parsing
- chess-control (in-house) for interactive board rendering, vendored in `app/vendor/chess-control/`
- React Router for client-side routing
- Microsoft Application Insights for telemetry
- Create React App (react-scripts) tooling

## Build and Test

All commands run from the `app/` directory.

### Install dependencies

```sh
cd app
yarn install --ignore-engines
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
yarn start        # Windows
yarn startLinux   # Linux / macOS
```

## Project Structure

- `app/` — React application source and configuration
  - `src/` — TypeScript source files (components, logic, tests)
  - `public/` — Static assets
  - `vendor/chess-control/` — Vendored chess-control library (built dist files)
- `openings/` — Opening database files and merge scripts

## Updating chess-control

The chess-control library lives in `../ChessControl` and is vendored via `file:` dependency.

```sh
cd ../ChessControl && yarn build:lib
cp dist/chess-control.js dist/index.d.ts dist/ChessBoard.d.ts ../ChessLaunchpad/app/vendor/chess-control/
# Bump version in app/vendor/chess-control/package.json (busts CI cache)
cd ../ChessLaunchpad/app && YARN_IGNORE_PATH=1 corepack yarn@1.22.22 install --ignore-engines --force
```

**Yarn version note:** This machine uses Yarn 4 via `.yarnrc.yml`, but CI uses Yarn 1.x. When updating the lockfile, always use `YARN_IGNORE_PATH=1 corepack yarn@1.22.22` to produce a v1-format lockfile compatible with CI.

## Process — Lessons Learned

- **Never amend commits.** Always create new commits instead of using `git commit --amend`.
