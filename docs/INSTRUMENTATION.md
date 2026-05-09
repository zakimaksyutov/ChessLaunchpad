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

Add `?debug=true` to the URL:

```
https://zakimaksyutov.github.io/ChessLaunchpad/?debug=true#/games
```

Or in local dev:

```
http://localhost:5274/ChessLaunchpad/?debug=true#/games
```

## Output

Logs are emitted to `console.debug` (set the browser console level to **Verbose** to see them). Each game produces a collapsed console group:

```
▶ [annotate Dm0P1ZTb] zakima as white, repertoire size=1389, moves=85
    ply 0: e4 [USER] → in-repertoire | after-FEN in repertoire
    ply 1: e6 [OPP] → in-repertoire | after-FEN in repertoire
    ply 2: Nf3 [USER] → in-repertoire | after-FEN in repertoire
    ply 3: d6 [OPP] → out-of-theory | opponent deviated (before-FEN in repertoire, after-FEN not)
    ply 4: d4 [USER] → out-of-theory | past theory end
    ...
```

## Fields

| Field | Description |
|-------|-------------|
| `gameId` | Lichess game ID |
| `username` | The logged-in user |
| `userColor` | `white` or `black` |
| `repertoire size` | Number of FENs in the user's repertoire for that color |
| `ply N` | Zero-based ply index |
| `SAN` | Move in standard algebraic notation |
| `USER/OPP` | Whether this is the user's move or the opponent's |
| `highlight` | `in-repertoire`, `deviation`, or `out-of-theory` |
| `reason` | Human-readable explanation of why the highlight was chosen |

For deviation moves, the reason also includes eval-drop data when available (e.g., `evalDrop=-0.45 (inaccuracy)`).

## Source

`app/src/GameAnnotationService.ts` — the `debugAnnotation` flag at module scope reads `window.location.search` for the `debug` parameter.
