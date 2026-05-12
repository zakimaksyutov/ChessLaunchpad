# Performance Instrumentation

All logs are emitted to `console.log` with prefix `[Perf]` followed by a JSON object.

## Repertoire Page Steps

| Step | File | Fields | Description |
|------|------|--------|-------------|
| `explorer-evals` | `RepertoirePage.tsx` | `totalMs` | Load explorer eval data from static JSON |
| `eval-drops` | `RepertoirePage.tsx` | `totalMs`, `variants`, `withDrops` | Compute eval drops per variant |

## Measuring Against a Production Build

Always measure performance against the **production build** (`yarn build` + `yarn preview`), not the dev server. The dev server includes React StrictMode double-rendering and unminified code, which inflates timings.

### Steps

```sh
cd app
yarn build            # produces minified bundle in build/
yarn preview          # serves on http://localhost:4274/ChessLaunchpad/
```

Then open the Repertoire page in the browser and check `[Perf]` logs in the console.

## Example Output

```
[Perf] {"step":"explorer-evals","totalMs":428}
[Perf] {"step":"eval-drops","totalMs":218,"variants":132,"withDrops":132}
```

# Games Page — Annotation Debug Logging

The Games page includes detailed debug logging for its annotation/highlighting logic. This logging is **disabled by default** and must be activated with a query parameter.

## Activation

Add `?debugGame=<opponentName>` to the URL **before the `#` fragment**, where `<opponentName>` is a case-insensitive substring of the opponent's name:

```
https://zakimaksyutov.github.io/ChessLaunchpad/?debugGame=magnus#/games
```

Or in local dev:

```
http://localhost:5274/ChessLaunchpad/?debugGame=magnus#/games
```

> **Note:** The parameter also works when placed after the hash (`#/games?debugGame=magnus`), but placing it before the `#` is more reliable because browsers natively parse the `?search` portion of the URL.

Only games where the opponent's name contains the filter string will produce debug output.

## Output

Logs are emitted to `console.debug` (set the browser console level to **Verbose** to see them). Each game produces a collapsed console group:

```
▶ [annotate Dm0P1ZTb] zakima as white vs cantorypoeta, repertoire size=1389, moves=85, hasEmbeddedEvals=true
    ply 0: e4 [USER] → in-repertoire | after-FEN in repertoire
    ply 1: e6 [OPP] → in-repertoire | after-FEN in repertoire
    ply 2: Nf3 [USER] → in-repertoire | after-FEN in repertoire
    ply 3: d6 [OPP] → out-of-repertoire | opponent deviated (before-FEN in repertoire, after-FEN not)
    ply 4: d4 [USER] → out-of-repertoire-response | evalDrop=12.50 (ok) [source: embedded]
    ...
```

## Eval Sources

The annotation logic tries eval sources in priority order:

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `explorer` | Pre-computed ExplorerEvals from static JSON (repertoire positions only) |
| 2 | `embedded` | Per-ply analysis from the Lichess game data (`analysis[]` array, Lichess games only) |
| 3 | `masters` | Lichess Masters Explorer API — used for opponent moves in the ambiguous eval-drop zone (15–44 cp) to determine if the move is real theory or out of theory |

Cloud eval (Lichess Cloud Eval API) is implemented but currently disabled. See `GamesPage.tsx` comment and git history.

When eval data is found, the debug trace shows `[source: explorer]`, `[source: embedded]`, or `[source: embedded+masters]` (when masters data supplements the eval-drop decision). When no source has data, it logs `no eval data for drop calc`.

## Opponent Out-of-Repertoire Classification

When the opponent plays a move that leaves the user's repertoire, the eval drop determines the classification:

| Eval drop range | Classification | Masters check? |
|---|---|---|
| ≥ 45 cp | `out-of-theory` — stop analysis | No |
| 15–44 cp | Ambiguous — needs masters verification | Yes (if Lichess connected) |
| < 15 cp | `out-of-repertoire` — clearly in theory, continue | No |

For ambiguous moves, the masters API checks if the move is played by masters:
- If < 5 absolute master games OR < 5% of position's total games → `out-of-theory`
- Otherwise → `out-of-repertoire` (in theory, continue analysis)

Masters data is fetched asynchronously (rate-limited to 1 req/sec, max 20 per page load) and cached in IndexedDB (`chesslaunchpad-masters-explorer`). The first annotation pass marks ambiguous positions optimistically as `out-of-repertoire`; once masters data arrives, affected games are re-annotated.

## Fields

| Field | Description |
|-------|-------------|
| `gameId` | Lichess game ID |
| `username` | The logged-in user |
| `userColor` | `white` or `black` |
| `vs` | Opponent name |
| `repertoire size` | Number of FENs in the user's repertoire for that color |
| `hasEmbeddedEvals` | Whether the game has embedded Lichess analysis data |
| `ply N` | Zero-based ply index |
| `SAN` | Move in standard algebraic notation |
| `USER/OPP` | Whether this is the user's move or the opponent's |
| `highlight` | `in-repertoire`, `deviation`, `out-of-repertoire-response`, `out-of-repertoire`, or `out-of-theory` |
| `reason` | Human-readable explanation of why the highlight was chosen |

For deviation and out-of-repertoire-response moves, the reason includes eval-drop data and source when available (e.g., `evalDrop=-0.45 (inaccuracy) [source: embedded]`).

## Source

`app/src/GameAnnotationService.ts` — the `getDebugGameFilter` function reads the `debugGame` parameter from the URL hash query string (supports both HashRouter and regular routing). Only games against the matching opponent produce debug output.

`app/src/MastersExplorerService.ts` — Lichess Masters Explorer API client with IndexedDB caching, rate limiting, and the `MastersLookup` class used by the annotation service.
