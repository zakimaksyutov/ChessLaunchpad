# Performance Instrumentation

All logs are emitted to `console.log` with prefix `[Perf]` followed by a JSON object.

## Repertoire Page Steps

| Step | File | Fields | Description |
|------|------|--------|-------------|
| `explorer-evals` | `RepertoirePage.tsx` | `totalMs` | Load explorer eval data from static JSON |
| `idb-preload` | `RepertoirePage.tsx` | `totalMs` | Preload IndexedDB masters cache into memory |
| `eval-drops` | `RepertoirePage.tsx` | `totalMs`, `variants`, `withDrops` | Compute eval drops per variant |
| `master-overrides` | `MastersEvalOverrideService.ts` | `totalMs`, `fens`, `cacheHits`, `apiCalls` | Lichess masters API lookups (1s throttle between API calls) |

## Measuring Against a Production Build

Always measure performance against the **production build** (`yarn build` + `yarn preview`), not the dev server. The dev server includes React StrictMode double-rendering and unminified code, which inflates timings (e.g., `idb-preload` can appear ~40× slower in dev due to double-mounting).

### Steps

```sh
cd app
yarn build            # produces minified bundle in build/
yarn preview          # serves on http://localhost:4274/ChessLaunchpad/
```

Then open the Repertoire page in the browser and check `[Perf]` logs in the console.
## Example Output

```
[Perf] {"step":"idb-preload","totalMs":25}
[Perf] {"step":"explorer-evals","totalMs":428}
[Perf] {"step":"eval-drops","totalMs":218,"variants":132,"withDrops":132}
[Perf] {"step":"master-overrides","totalMs":227,"fens":26,"cacheHits":26,"apiCalls":0}
```
