# Games Page — Product Specification

## Overview

The **Games** page shows the user's recently played games from linked Lichess and Chess.com accounts, annotated against their repertoire. It surfaces where the user followed theory, where they deviated, and how well they handled deviations by their opponents.

Game ingestion is shared with the Dashboard (see [`GAME-INGEST.md`](./GAME-INGEST.md)) — both pages run the same pipeline under a single-flight lock. The Games page reads the resulting records from the synced repertoire blob and adds a per-game **masters-theory verdict** on top.

## Account Linking

Linked accounts live in `settings.linkedAccounts` on the synced blob and are managed on the Settings page. Each entry is `{ platform: 'lichess' | 'chess.com', username }`. No OAuth is required to *list* a username — the public APIs are enough.

A separate **Lichess OAuth connection** (Settings → Lichess Integration) is required to query the masters opening explorer for theory verdicts; see "Theory verdicts" below.

Unlinking an account:
- Removes its per-account ingest state from the blob (`games.{platform}:{user}`).
- Purges stored `GameRecord` entries whose `wa`/`ba` matches that account from every day's `practiceLog[].games.records`.
- Per-day counters (`ingested`/`reviewed`/`mistakes`) are left intact — historical activity remains visible on the Dashboard.

## Data Source

The Games page reads from `activity.practiceLog[].games.records[]` on the synced repertoire blob (see [`GAME-INGEST.md`](./GAME-INGEST.md) §1 for the record shape). Records are written by ingest; verdicts (`an`, `op`) are written by the Games page's analysis pass and persist back to the same record. Once written, a verdict syncs across devices — a game is analyzed once, then instant everywhere.

## Landing Flow

On opening `/games` (logged-in, with linked accounts):

1. **Render immediately** from records that already have `an`, newest first.
2. **Background ingest** — run the same ingest pipeline the Dashboard runs. New games land as new records; the 100-record retention cap is enforced inside the ingest write path (see below). The two entry points (Dashboard auto, Games page) share the same pipeline, so neither can leave the blob over-cap.
3. **Plan** — enumerate records lacking `an`, oldest-first; for each, discover the ambiguous-zone opponent moves that need a masters lookup.
4. **Reserve placeholders** — every queued record gets a **skeleton row** in its final sorted slot before the analyze loop begins. This prevents the "rows pop in newest-first, push everything down" jumping effect as each game's `an` lands.
5. **Analyze sequentially, oldest-first**. Each game's verdict is computed, written back optimistically to the in-memory tree, and the row hydrates from skeleton to content in place. Verdicts flush to the backend in batches.
6. A manual **Sync** button (next to the header) re-runs the same pipeline; the auto-trigger and the button share a single-flight lock.

A **sticky session ordering** keeps already-rendered rows in their slot for the duration of the session; newly arriving rows are placed by their timestamp relative to the current bounds. Without this, an evicted-then-re-ingested game could jump in the list.

### Progress indicator

A status pill next to the Games header shows the current state — syncing (spinner), analyzing N of M games (progress bar) when the pass has more than a few games to process, or last-sync timestamp once complete. The timestamp is stamped on every completion path (success, error, empty) since failures are silent in the UI.

## Theory Verdicts (`an`)

`an` is the page's "done" marker on a record. It holds only the masters-dependent decisions; everything else is recomputed at render time from `m` + repertoire + `ev`.

```jsonc
"an": {
  "tv": [                       // RESOLVED masters verdicts only (sparse)
    { "ply": 12, "in": true },  // confirmed in theory
    { "ply": 16, "in": false }  // confirmed out of theory
    // ambiguous plies with no masters data are OMITTED
  ]
}
```

Verdicts are keyed by **ply** (replay is deterministic) and only populated for opponent moves whose eval drop lands in the **ambiguous zone (15–44 cp)**. Below 15 cp is trivially in-theory; ≥ 45 cp is out-of-theory; both are decidable locally.

- **Sparse-map rule.** A ply that masters had **no data** for — i.e. the masters API returned `totalGames === 0` for the position — is omitted, not stored as `false`. At render, an ambiguous ply absent from `tv` falls through to the engine's optimistic in-theory default. This avoids conflating "confirmed out of theory" with "no data" — a one-way door — and lets a later pass retry only the no-data plies. Note that a position with `totalGames > 0` but where the opponent's SAN was never played is **not** no-data; that's a confirmed out-of-theory signal (`{ in: false }`).
- **Empty `tv` is valid.** A game with no ambiguous positions, or all ambiguous plies returned no-data, is still considered analyzed once `an` is present.
- **No automatic invalidation.** `an` is not cleared when the repertoire changes. A stale verdict simply persists; the user re-runs it via Re-annotate.

### Lichess OAuth gate

The masters opening explorer (`explorer.lichess.org/masters`) requires a Lichess OAuth token to query.

- **Chess.com records** never need masters (they always write `an: {}` immediately).
- **Lichess records with no ambiguous positions** (K = 0) also write `an: {}` immediately.
- **Lichess records with K > 0** require a connected Lichess account. When disconnected, these records are held out of the pass and a top-of-page banner counts them and prompts the user to connect.
- If the user has linked accounts but no Lichess connection, the empty-state copy nudges them to connect.

Transient masters failures (network / HTTP) leave the game unanalyzed — it re-queues on the next pass; a banner counts the deferred games for the current session.

## Re-annotate

Per-row **Re-annotate** (overflow menu) clears `an` and `op` for that record and triggers a fresh analysis pass. While the new verdict is pending, the row stays visible with its **prior `an`** so it doesn't disappear; on failure the prior verdict is restored.

For **Lichess** records, Re-annotate first re-fetches the game from `/api/game/export/{id}` so any post-ingest server analysis (per-ply evals, refined opening name) is picked up. Chess.com has no per-game endpoint worth the cost; it just re-runs analysis against the cached record.

## Render

Each row shows:

- **Mini board** — position at the first notable event (in priority): user deviation > first user eval-drop > end of theory > start. When the user deviated, **green arrows** mark the repertoire moves and a **red arrow** marks the move played.
- **Players** — White / Black names with ratings; the user's side is visually emphasized.
- **Right column** — Result · Rated/Casual · Speed · Time control · Date · "View on platform" link.
- **Opening name** (from `o`).
- **Annotated PGN** with per-move highlighting (see below).
- **Deviation summary** when the user deviated from repertoire — names the expected repertoire move(s) and the move actually played.
- **End-of-theory (EOT) summary** when the opponent left repertoire and the user's response was an eval drop (inaccuracy/mistake/blunder).
- **Opponent analysis** result if `op` is present and not stale (see below).

### Move highlighting

| Highlight | Condition |
|---|---|
| `in-repertoire` (green) | User move whose resulting FEN matches a repertoire position. |
| `deviation` (purple) | First user move that leaves the repertoire. |
| `out-of-repertoire-response` (eval-drop colored) | A user move after the **opponent** left repertoire, colored by its eval drop (inaccuracy = gold, mistake = red, blunder = purple). |
| `out-of-repertoire` / `out-of-theory` (dimmed) | Opponent moves outside repertoire, or any move once theory has truly ended. |

Eval drops use the same thresholds as the Repertoire page (inaccuracy ≥ 30 cp, mistake ≥ 50 cp, blunder ≥ 70 cp). Eval sources, in priority order:

1. **`ExplorerEvals`** — pre-computed static evals for repertoire positions (no network).
2. **Embedded Lichess per-ply evals** (`record.ev`). Absent for Chess.com.

When neither source has eval data for a ply, the engine falls back to its optimistic in-theory default — the same behavior the Repertoire page uses.

Each row's left border is color-coded for at-a-glance status: purple for user-deviation rows, gold/red/purple for EOT inaccuracy/mistake/blunder, no border otherwise.

## Opponent Analysis (`op`)

When the EOT summary fires (opponent deviated, user's response was an eval drop), the row's overflow menu shows **"Analyze opponent"**. This downloads up to **1,000** of the opponent's most recent public games from the same platform and counts how many reached the critical positions:

- `fenBefore` — after the opponent's out-of-repertoire move.
- `fenAfter` — after the user's eval-dropped response.

Only one row at a time runs opponent analysis; other rows' actions are disabled during a run. A per-row progress bar shows download count.

The result is persisted on the record as `op`:

```jsonc
"op": {
  "ply": 14,           // anchor — ply of the user's deviation
  "m": 842,            // opponent games analyzed
  "nb": 7,             // count reaching fenBefore
  "na": 2,             // count reaching fenAfter
  "os": "Nxe4",        // opponent move SAN (critical)
  "us": "exd6",        // user move SAN (critical)
  "rb": [...],         // ≤5 recent before-games (date + URL)
  "ra": [...],         // ≤5 recent after-games (date + URL)
  "at": 1716700000000  // analyzedAt (ms)
}
```

- Keyed by **ply** so the analysis re-attaches even after a repertoire change. If no deviation sits at that ply after a change (e.g., the user added the played move to their repertoire), `op` is treated as **stale** — hidden from render and the menu action becomes available again.
- Re-annotate clears `op` along with `an`.
- One analysis per game today; the shape leaves room for an array later.

A **threat-level** label is derived from `nb` (`0–2` low, `3–9` moderate, `10–24` high, `25+` very high), with up to 5 recent game links.

## Retention

The total number of `GameRecord` entries across every day is capped at **100**. When ingest exceeds the cap, it evicts the **oldest day's records as a whole**, repeating oldest-first until total ≤ 100. Eviction:

- Empties only the `records` array — per-day counters stay so the Dashboard activity feed still shows the day had ingested games.
- Never partials a day. If a single day alone exceeds the cap, it is preserved intact.
- Runs inside the shared ingest write path, so masters budget is never spent on games about to be dropped.

The invariant `records.length == ingested || records.length == 0` holds per day (empty `records` with non-zero `ingested` means the day was evicted).

## Out of Scope

- A separate `recentIds` ring (ingest dedup state) keeps using its own 50-ID per-account window. `records` is display data only and cannot bound the 5-day dedup window. See [`GAME-INGEST.md`](./GAME-INGEST.md) §1.
- Bullet games, variants, daily/correspondence, casual games.
- Full-game (un-truncated) PGNs on the backend.
