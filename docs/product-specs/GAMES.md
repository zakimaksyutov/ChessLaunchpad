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

The Games page reads from `activity.practiceLog[].games.records[]` on the synced repertoire blob (see [`GAME-INGEST.md`](./GAME-INGEST.md) §1 for the record shape). Records are written by ingest; the **frozen annotation** (`fan`) and opponent analysis (`op`) are written by the Games page's analysis pass and persist back to the same record. Once written, a `fan` syncs across devices — a game is analyzed once, then instant everywhere. Render is a **pure read** of `fan` (see [Frozen Annotation](#frozen-annotation-fan) below).

## Landing Flow

On opening `/games` (logged-in, with linked accounts):

1. **Render immediately** from records that already have `fan`, newest first.
2. **Background ingest** — run the same ingest pipeline the Dashboard runs. New games land as new records; the 100-record retention cap is enforced inside the ingest write path (see below). The two entry points (Dashboard auto, Games page) share the same pipeline, so neither can leave the blob over-cap.
3. **Plan** — enumerate records lacking `fan`, oldest-first. No network and no per-game gating: every queued game runs. Analysis resolves evals and masters verdicts **on demand** in a single engine walk per game, and the walk itself defers any game that reaches a masters-needing position with no Lichess token connected — see "Move highlighting" and "Masters theory" below.
4. **Reserve placeholders** — every queued record gets a **skeleton row** in its final sorted slot before the analyze loop begins. This prevents the "rows pop in newest-first, push everything down" jumping effect as each game's `fan` lands.
5. **Analyze sequentially, oldest-first**. Each game's frozen annotation is computed (full engine run, then frozen), written back optimistically to the in-memory tree, and the row hydrates from skeleton to content in place. Annotations flush to the backend in batches.
6. A manual **Sync** button (next to the header) re-runs the same pipeline; the auto-trigger and the button share a single-flight lock.

A **sticky session ordering** keeps already-rendered rows in their slot for the duration of the session; newly arriving rows are placed by their timestamp relative to the current bounds. Without this, an evicted-then-re-ingested game could jump in the list.

### Progress indicator

A status pill next to the Games header shows the current state — syncing (spinner), analyzing N of M games (progress bar) when the pass has more than a few games to process, or last-sync timestamp once complete. The timestamp is stamped on every completion path (success, error, empty) since failures are silent in the UI.

## Analysis Pipeline

A pass analyzes each queued game in **one async engine walk** that resolves evals and masters verdicts **on demand** as it steps ply-by-ply. There is no separate pre-fetch phase — the walk's own stop conditions bound how far the (rate-limited) cloud-eval and masters APIs are consulted, so neither is ever hit for a game's already-settled tail.

```
sync / open /games
   │
   ▼
ingest games  ──▶  plan: list records lacking `fan`, oldest-first   (no network)
   │
   ▼
for each game, sequentially (cloud-eval + masters caches shared across the pass):
   │
   single async walk ──▶ freeze into `fan`
   │      │
   │      ├─ completed              → write `fan`, hydrate the row, flush in batches
   │      ├─ reached masters-needing → defer: count toward "connect Lichess" banner;
   │      │   position, no token        persist cloud evals gathered so far into `ev`
   │      ├─ cloud-eval throttled    → defer: count toward "Lichess rate-limited" banner;
   │      │   (HTTP 429) mid-walk        persist cloud evals gathered so far; retries later
   │      └─ transient failure /     → skip without freezing; re-queues next pass
   │          abort
   ▼
final flush of remaining `fan` writes back to the blob
```

The per-game walk steps moves oldest→newest, tracking whether the game is "still in theory":

```
walk move i:
   │
   ├─ user move stays in repertoire     → in-repertoire
   ├─ user leaves repertoire            → deviation            (+ eval drop)
   ├─ opponent leaves repertoire        → classify by opponent's eval drop:
   │        ≥ 45 cp   → out of theory → STOP analysing
   │        < 15 cp   → in theory     → keep analysing user moves
   │        15–44 cp  → ambiguous     → masters verdict (fetched on demand):
   │                                       out of theory → STOP
   │                                       in theory     → keep analysing
   │                                       no token      → DEFER the game
   │        no eval   → out of theory → STOP (a total miss, incl. a cloud 404,
   │                                       means the position is too rare to be
   │                                       book; no drop is computed, so this
   │                                       path never reaches masters / defers)
   ├─ user response (post-theory)       → eval drop; first notable drop → STOP
   │                                       (no eval → can't grade, leave as ok)
   └─ stop after ~30 plies, or theory-end + a short buffer
   │
   ▼
eval for any position is resolved in priority order, on demand:
   ExplorerEvals (static) → record.ev (embedded) → Lichess cloud-eval (gaps only)
   a total miss on an opponent's move ends theory (too rare to be book); a miss
   when grading a user move just leaves that move ungraded (ok)
```

The walk produces a live annotation that is immediately **frozen** into `fan` (below); render never re-runs this walk — it is a pure read of `fan`.

The **starting position is always treated as book** (seeded into the analysis pass's FEN set; ingest excluded), so move 1 is graded even for an opening the repertoire doesn't cover — including an empty repertoire.

## Frozen Annotation (`fan`)

`fan` is the page's "done" marker on a record and the **only** input render reads. It freezes everything the row needs at analysis time, so render is a pure read — no repertoire lookups, no eval lookups, no masters queries. This means editing your repertoire later can never retroactively turn an old, previously-fine game into a "mistake," and a row paints correctly on first render (no eval-resource load-order flash).

```jsonc
"fan": {
  "hl": [0, 2, 2, 2, 2, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7],  // one code per USER move, in order
  "alt": ["Be7", "Nbd7"],   // repertoire alternatives at the deviation (only when hl has a code 1)
  "mb": 4                    // mini-board anchor: replay 4 plies of `m` -> shown position
}
```

- **`hl`** holds one **highlight code per user move** across the frozen display window (opponent moves carry no code — they always render neutral). `hl.length` *is* the window: render replays `m`, assigns codes to user moves in order, and shows moves through the last user move in `hl`. Codes: `0` in-repertoire, `1` deviation, `2` post-theory ok, `3` inaccuracy (≥ 30 cp), `4` mistake (≥ 50 cp), `5` blunder (≥ 70 cp), `7` out-of-theory. (`6`, out-of-repertoire, applies only to opponent moves and is never stored.)
- **`alt`** carries the repertoire move(s) available at the deviation, as SAN, for the green arrows and the deviation summary — present only when `hl` contains a `1`. Render parses each at the deviation position to recover `{from, to}`.
- **`mb`** is the mini-board anchor ply: the half-move depth of the position shown on the row's mini board. For a deviation it's the position *before* the code-`1` ply (where the arrows are drawn).
- **No automatic invalidation.** `fan` is not recomputed when the repertoire changes — that's the whole point of freezing it. The user applies their current repertoire to a game deliberately via **Re-annotate**.

### Masters theory + the Lichess OAuth requirement

Computing `fan` can require the masters opening explorer (`explorer.lichess.org/masters`), which needs a Lichess OAuth token. The masters decision is **baked into the frozen codes** at analysis time — nothing about it is cached separately or re-queried at render. Masters is consulted only at the ambiguous-zone (15–44 cp) opponent moves the walk actually reaches, and applies to **both platforms** — the masters database is opening theory, independent of where the game was played.

- **Games that never reach an ambiguous position** freeze normally without any masters query, regardless of token or platform.
- **A game that reaches an ambiguous position with a token connected** resolves the verdict on demand and freezes it.
- **A game that reaches an ambiguous position with no token** is **deferred**, not frozen — we must not bake an optimistic in-theory verdict, because for a position that is genuinely out of theory that would mis-color the user's subsequent moves as mistakes (this is why Chess.com games are no longer optimistically frozen). The deferred game stays unrendered and counts toward a top-of-page banner prompting the user to connect Lichess. On connect, it re-runs and freezes.
  - To keep deferral cheap, the cloud evals the walk gathered before deferring are persisted into `record.ev` (additively, never overwriting). The re-run resolves those plies from `ev` instead of re-hitting the rate-limited cloud API, reaching the masters check with no cloud calls.
- If the user has linked accounts but no Lichess connection, the empty-state copy nudges them to connect.

Transient masters failures (network / HTTP) also leave the game without a `fan` — it re-queues on the next pass; a separate banner counts those for the current session.

**Cloud-eval throttling.** A Lichess cloud-eval **429 (rate limit)** is a transient deferral, *not* a "no eval" miss: the game stays unfrozen (re-queues on a later pass, no user action), its gathered evals persist into `record.ev`, and it counts toward a distinct "Lichess rate-limited" banner. Mistaking it for a 404 would end theory early and freeze a less-informed verdict; a real 404 (position too rare to be in book) is still a miss that ends theory. The first 429 also **latches the whole pass**: every subsequent cloud-needing game defers immediately without re-hitting the rate-limited API, so they all back off together. A fresh pass clears the latch and retries.

## Re-annotate

Per-row **Re-annotate** (overflow menu) clears `fan` and `op` for that record and triggers a fresh analysis pass that re-queries masters, reads the *current* repertoire and evals, and freezes a new annotation. While the new annotation is pending, the row stays visible with its **prior `fan`** so it doesn't disappear; on failure the prior annotation is restored.

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

Eval drops use the same thresholds as the Repertoire page (inaccuracy ≥ 30 cp, mistake ≥ 50 cp, blunder ≥ 70 cp). They are computed **at analysis time** (frozen into `fan.hl`), resolving each position's eval in priority order:

1. **`ExplorerEvals`** — pre-computed static evals for repertoire positions (no network).
2. **Embedded per-ply evals** (`record.ev`). Originally Lichess-only (absent for Chess.com), but a deferred game's persisted cloud back-fill (see "Masters theory") also lands here, so a Chess.com record may carry a sparse `ev`.
3. **Lichess cloud-eval API** (`lichess.org/api/cloud-eval`, public — no OAuth, so it covers Chess.com too) — consulted only for the **gaps** the first two sources miss, resolved on demand as the engine walks the game. Sources may mix per move (e.g. an explorer "before" with a cloud "after"). Throttled (1 req/sec) and deduped per-pass; a **429** defers the game (see "Masters theory") rather than counting as a miss. Not cached across passes for a frozen game (its verdict is in `fan`); for a *deferred* game the gathered evals are persisted into `record.ev` so its re-run needn't refetch.

When no source has eval data for an **opponent** move that left the repertoire, the engine treats it as **out of theory** and stops. With cloud-eval as the final source, a total miss means a Lichess cloud-eval 404 — the position is so rare nobody on Lichess has analysed it — which is itself strong evidence the game has left book. (This replaces the older optimistic in-theory default, which made sense when the only eval source was the small static `ExplorerEvals` set.) A miss while grading a **user** move is different: that move simply can't be scored, so it stays an uncolored post-theory move and the walk continues. Render itself reads none of this — it replays `m` and paints the frozen `hl` codes.

Each row's left border is color-coded for at-a-glance status: purple for user-deviation rows, gold/red/purple for EOT inaccuracy/mistake/blunder, no border otherwise.

### Filter bar & "mark reviewed"

A filter bar selects one of four views — **To review** (default; unreviewed mistakes), **Reviewed**, **All mistakes**, **All games** — each with a live count. The choice is remembered per user on the device.

Each mistake row has a **Mark reviewed** toggle that sets a persistent `rv` flag, so the decision syncs across devices and the row leaves the **To review** queue. It's a user decision independent of the annotation: **Re-annotate does not clear it**, and clean games never carry it.

## Opponent Analysis (`op`)

When the EOT summary fires (opponent deviated, user's response was an eval drop), the row's overflow menu shows **"Analyze opponent"**. This downloads up to **1,000** of the opponent's most recent public games from the same platform and counts how many reached the critical positions:

- `fenBefore` — after the opponent's out-of-repertoire move.
- `fenAfter` — after the user's eval-dropped response.

Only one row at a time runs opponent analysis; other rows' actions are disabled during a run. A per-row progress bar shows download count.

The result is persisted on the record as `op`:

```jsonc
"op": {
  "ply": 14,           // anchor — ply of the user's first EOT eval-drop response
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

- Keyed by **ply** so the analysis re-attaches even after a repertoire change. If no EOT eval-drop sits at that ply after a change (e.g., the user added the played move to their repertoire), `op` is treated as **stale** — hidden from render and the menu action becomes available again.
- Re-annotate clears `op` along with `fan`.
- One analysis per game today; the shape leaves room for an array later.

A **threat-level** label is derived from `nb` (`0–2` low, `3–9` moderate, `10–24` high, `25+` very high), with up to 5 recent game links.

## Repertoire Suggestion (`sg`)

On **EOT** rows, a **"Suggest a fix"** link (beside "Analyze opponent") proposes a concrete line to add so the user is ready next time. It is **not** shown on deviation rows — the user's own repertoire already holds the intended move. Like masters verdicts it **requires a connected Lichess account** (the masters explorer needs OAuth); without a token the result area shows a connect-Lichess prompt instead.

The algorithm (see `GameSuggestionService`) walks the game from the start and, at the first out-of-repertoire user move, either keeps a sufficiently sound user move or substitutes a stronger masters move, closing the corrected line out shortly after. The result is a suggested **PGN** rendered below the tile:

- In-repertoire user plies keep the **greenish** in-repertoire styling; opponent plies are greyed (matching the main tile).
- Moves that **differ from the played game** are **bold**; the first carries a muted **"(instead of X)"** note naming the replaced user move.
- **Open in Lichess Opening Explorer** links to the line (with the replaced move appended as a one-ply variation for comparison).
- **Add to repertoire** deep-links into the Explorer Review & Save flow; Save/Discard returns to `/games` at the row. When every ply is already in the repertoire there is nothing to add, so the action becomes an **"Already exists in the repertoire"** confirmation.

One suggestion per row, persisted as `sg` on the record (anchored on the EOT user ply like `op`, so it survives reloads and the link hides on return). Re-annotate clears it; a repertoire change that moves the anchored deviation marks it stale and re-offers the action. Committing the suggestion sets `sg.ap`, freezing the annotation and flipping the action to a persistent **"Added to repertoire"** confirmation.

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
