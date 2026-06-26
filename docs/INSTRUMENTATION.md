# Games Page — Tracing a Game

The Games page includes detailed debug logging for its annotation/highlighting logic. This logging is **disabled by default** and is activated per-game through the UI.

## Activation

Click the **⋯** menu on any game row, then click **Re-annotate**. The game's annotation is recomputed and a detailed ply-by-ply trace is written to the browser console. For Lichess records, this also re-fetches the game from the provider before re-annotating, so newly-available server-side evals are reflected in the trace.

No URL parameters are needed. Debug logs are **not** produced during regular annotation (sync, initial page load, or masters-triggered re-annotation) — only when the user explicitly re-annotates a game.

**Automated (Playwright):** use the existing Playwright MCP — do not install Playwright separately. Log in, navigate to the Games page, find the target game row, open its **⋯** menu, click **Re-annotate**, and collect the console output.

## Output

Logs are emitted to `console.log` inside a collapsed `console.groupCollapsed` group. Each re-annotated game produces output like:

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

Cloud eval (Lichess Cloud Eval API) is implemented but currently disabled. See `pages/GamesPage.tsx` comment and git history.

When eval data is found, the debug trace shows `[source: explorer]`, `[source: embedded]`, or `[source: embedded+masters]` (when masters data supplements the eval-drop decision). When no source has data, it logs `no eval data for drop calc`.

## Opponent Out-of-Repertoire Classification

When the opponent plays a move that leaves the user's repertoire, the eval drop determines the classification:

| Eval drop range | Classification | Masters check? |
|---|---|---|
| ≥ 45 cp | `out-of-theory` — stop analysis | No |
| 15–44 cp | Ambiguous — needs masters verification | Yes (if Lichess connected) |
| < 15 cp | `out-of-repertoire` — clearly in theory, continue | No |

For ambiguous moves, the masters API checks if the move is played by masters:
- If ≥ 50 absolute master games → `out-of-repertoire` (in theory — high absolute count overrides percentage)
- If < 5 absolute master games OR < 5% of position's total games → `out-of-theory`
- Otherwise → `out-of-repertoire` (in theory, continue analysis)

Masters data is fetched asynchronously (rate-limited to 1 req/sec) and accumulated in an in-memory `MastersLookup` for the current analysis batch. The masters decision is **baked into the frozen `fan.hl` codes** at analysis time — nothing about it is cached separately on the record, and render never re-queries. Re-annotate re-queries masters fresh.

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

`app/src/services/GameAnnotationService.ts` — the `annotateGame` function accepts an optional `debug` parameter. When `true`, it emits a ply-by-ply console trace.

`app/src/pages/GamesPage.tsx` — the `handleReannotate` callback adds the record key to `debugRecordKeysRef`; the key is threaded into `buildAnalysisPlan` so the analysis pass passes `debug: true` for those records. The trace therefore fires while the game is re-annotated by the pass, not at render (render is a pure read of `fan`).

`app/src/services/MastersExplorerService.ts` — Lichess Masters Explorer API client with IndexedDB caching, rate limiting, and the `MastersLookup` class used by the annotation service.
