# Performance Instrumentation

All logs are emitted to `console.log` with prefix `[Perf]` followed by a JSON object.

## Repertoire Page Steps

| Step | File | Fields | Description |
|------|------|--------|-------------|
| `explorer-evals` | `RepertoirePage.tsx` | `totalMs` | Load explorer eval data from static JSON |
| `idb-preload` | `RepertoirePage.tsx` | `totalMs` | Preload IndexedDB masters cache into memory |
| `eval-drops` | `RepertoirePage.tsx` | `totalMs`, `variants`, `withDrops` | Compute eval drops per variant |
| `master-overrides` | `MastersEvalOverrideService.ts` | `totalMs`, `fens`, `cacheHits`, `apiCalls` | Lichess masters API lookups (1s throttle between API calls) |

## Example Output

```
[Perf] {"step":"explorer-evals","totalMs":3938}
[Perf] {"step":"idb-preload","totalMs":80}
[Perf] {"step":"eval-drops","totalMs":575,"variants":132,"withDrops":132}
[Perf] {"step":"master-overrides","totalMs":571,"fens":26,"cacheHits":26,"apiCalls":0}
```
