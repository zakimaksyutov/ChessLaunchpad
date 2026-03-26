# AGENTS.md

## Project Description

ChessLaunchpad is a web application for memorizing chess openings using spaced repetition. It helps players master their opening repertoires through interactive board training with an adaptive algorithm that prioritizes variants based on recency, error rate, frequency, and newness. Deployed at https://zakimaksyutov.github.io/ChessLaunchpad/.

## Tech Stack

- React 19 with TypeScript
- chess.js for game logic and PGN parsing
- Chessground for interactive board rendering
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
- `openings/` — Opening database files and merge scripts
