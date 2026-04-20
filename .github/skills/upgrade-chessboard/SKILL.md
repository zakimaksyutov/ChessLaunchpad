---
name: upgrade-chessboard
description: Upgrade the vendored chess-control library to a new version. Use when asked to bring/update/bump chess-control or the chessboard library.
---

## Steps

1. **Ensure you're on main with latest changes:**
   ```sh
   git checkout main && git pull
   ```

2. **Create a version branch:**
   Determine the current version from `app/vendor/chess-control/package.json` and increment it.
   ```sh
   git checkout -b chessboard/version-X.X.X
   ```

3. **Build chess-control:**
   ```sh
   cd ../ChessControl && yarn build:lib
   ```

4. **Copy dist files:**
   ```sh
   cp dist/chess-control.js dist/index.d.ts dist/ChessBoard.d.ts ../ChessLaunchpad/app/vendor/chess-control/
   ```

5. **Bump version** in `app/vendor/chess-control/package.json` to `X.X.X`.

6. **Update lockfile and synced dependency install:**
   ```sh
   cd ../ChessLaunchpad/app
   yarn install
   ```

7. **Verify** the vendored package resolves to the new version:
   ```sh
   yarn why chess-control
   ```

8. **Commit:**
   ```sh
   cd .. && git add -A
   git commit -m "Update chess-control to vX.X.X"
   ```

9. **Hand off to user for push and PR:**
   You do not have permission to push to origin. After committing, tell the user the branch is ready and ask them to run:
   ```sh
   git push -u origin chessboard/version-X.X.X
   ```
   Then create a pull request targeting `main`.

## Important notes

- **Yarn version**: The app is pinned to Yarn 4 in `app/package.json`, and CI uses Corepack with `yarn install --immutable`.
- **Run `yarn install` after copying the vendored files** so the `file:vendor/chess-control` dependency is refreshed in `node_modules` before you test or build.
- **Version bump is required** so the vendored package metadata and lockfile stay aligned with the copied release.
- **Always branch from latest main** — never reuse an old feature branch after it has been merged.
