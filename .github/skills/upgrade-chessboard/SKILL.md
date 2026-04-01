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

6. **Update lockfile** (must use Yarn 1.x to keep v1 format):
   ```sh
   cd ../ChessLaunchpad/app
   YARN_IGNORE_PATH=1 corepack yarn@1.22.22 install --ignore-engines --force
   ```

7. **Verify** lockfile shows new version:
   ```sh
   grep -A1 "chess-control" yarn.lock
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

- **Yarn version**: This machine uses Yarn 4 via `.yarnrc.yml`, but CI uses Yarn 1.x. Always use `YARN_IGNORE_PATH=1 corepack yarn@1.22.22` to produce a v1-format lockfile.
- **Version bump is required** — it changes the lockfile hash, busting the CI cache. Without it, CI may use stale `node_modules`.
- **Always branch from latest main** — never reuse an old feature branch after it has been merged.
