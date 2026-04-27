---
name: investigate-position
description: Investigate why a move in a chess position is or isn't highlighted on the Repertoire page. Use when asked to check evals, eval drops, or move highlighting for a position.
parameters:
  - name: position
    type: string
    description: The position to investigate — either a FEN string or a PGN move sequence (e.g. "1. d4 d5 2. c4 e6 3. Nf3 Nf6"). The move to investigate should be the last move in the sequence or specified separately by the user.
    required: true
---

## Context

The Repertoire page highlights moves whose Lichess cloud evaluation drops significantly compared to the previous position. This skill walks through the full investigation pipeline to explain why a given move **is** or **isn't** highlighted.

### Eval-drop formula (`app/src/EvalDropService.ts`)

All evaluations are stored from **White's perspective**.

- **White's move:** `drop = evalBefore − evalAfter` (positive → White lost eval)
- **Black's move:** `drop = evalAfter − evalBefore` (positive → Black lost eval, i.e. position got better for White)

A **positive** drop ≥ 30 cp triggers highlighting. A **negative** drop means the mover **improved** the position — no highlight.

### Master theory override (`app/src/MastersEvalOverrideService.ts`)

Even if an eval drop exceeds the threshold, the highlight can be **suppressed** when master game data shows the move is standard theory:

1. **High game count**: The move has ≥ 150 master games → auto-suppress.
2. **Dominant top move**: The move is the #1 continuation by game count, has ≥ 90% share, **and** no alternative with ≥ 5% share has a win-rate edge ≥ 5 percentage points.

### Key source files

| File | Role |
| ---- | ---- |
| `app/public/opening-explorer-evals.json` | Precomputed eval artifact (~29 MB). Maps compact FEN (pieces + side + castling, 3 fields) → `[centipawns, depth]` tuples. Evals are from White's perspective. Depth is the Stockfish search depth that produced the eval. |
| `app/src/ExplorerEvals.ts` | Loads the artifact; `lookup(fen)` returns cp, `lookupEntry(fen)` returns `{ cp, depth }`. Strips FEN to 3 fields before searching. |
| `app/src/EvalDropService.ts` | `computeEvalDrops(pgn, evals, orientation)` — computes per-move eval drops. Only evaluates the **user's own moves** (based on `orientation`). |
| `app/src/MastersEvalOverrideService.ts` | `shouldSuppressHighlight(mastersResult, moveSan, orientation)` — checks master theory suppression. |
| `app/src/PgnControl.tsx` | Renders PGN on the Repertoire page. Applies eval-drop background colors per move. |
| `tools/opening-explorer/lookup-fen.mjs` | Looks up raw eval data for a FEN from the Lichess cloud eval DB (compressed JSONL). Shows all depths and PVs from the source data. Useful when the artifact and live API disagree. |

---

## Steps

The user will provide a **position** (PGN line or FEN) and a **move** to investigate.

### 1. Establish the position

Use chess.js (via Node) to replay the PGN and obtain:
- The **FEN before** the move (the position where the move is played)
- The **FEN after** the move
- Confirm the move is **legal** at that position
- Determine whose move it is (White or Black)

```sh
cd app && node -e "
const { Chess } = require('chess.js');
const c = new Chess();
c.loadPgn('<PGN up to the move before>');
console.log('FEN before:', c.fen());
console.log('Turn:', c.turn());
c.move('<THE_MOVE>');
console.log('FEN after:', c.fen());
"
```

### 2. Look up evals in the public artifact

Check `app/public/opening-explorer-evals.json` for both positions. The file uses **3-field compact FENs** (pieces, side-to-move, castling — no en passant or move counters).

```sh
cd /home/mainuser/Projects/GitHub/ChessLaunchpad && python3 -c "
import json, sys

with open('app/public/opening-explorer-evals.json') as f:
    data = json.load(f)

def compact(fen):
    return ' '.join(fen.split()[:3])

def parse_entry(val):
    if isinstance(val, list):
        return val[0], val[1]
    return val, None

fen_before = '<FULL_FEN_BEFORE>'
fen_after  = '<FULL_FEN_AFTER>'

raw_b = data.get(compact(fen_before))
raw_a = data.get(compact(fen_after))
eb, db = parse_entry(raw_b) if raw_b is not None else (None, None)
ea, da = parse_entry(raw_a) if raw_a is not None else (None, None)
print(f'Before: {eb} cp (depth {db})')
print(f'After:  {ea} cp (depth {da})')

if eb is not None and ea is not None:
    # Determine whose move it is from the FEN (second field: 'w' or 'b')
    is_white = fen_before.split()[1] == 'w'
    drop = (eb - ea) if is_white else (ea - eb)
    print(f'Eval drop: {drop} cp')
    if drop >= 70: print('Category: BLUNDER')
    elif drop >= 50: print('Category: MISTAKE')
    elif drop >= 30: print('Category: INACCURACY')
    else: print('Category: ok (no highlight)')
    if db is not None and da is not None and abs(db - da) > 10:
        print(f'WARNING: depth mismatch ({db} vs {da}) — eval drop may be unreliable')
"
```

If either eval is missing from the artifact, note that — the move won't be highlighted if either side is missing.

### 3. Cross-check with Lichess Cloud Eval API

Query the live API for both positions to compare with the artifact values. Use `multiPv=3` for richer context. The API endpoint documented in `specs/project-description.md`:

```sh
source .env 2>/dev/null
curl -s -H "Authorization: Bearer $LICHESS_TOKEN" \
  "https://lichess.org/api/cloud-eval?fen=$(python3 -c "import urllib.parse; print(urllib.parse.quote('<FEN>'))")&multiPv=3" \
  | python3 -m json.tool
```

Run this for **both** the before and after FENs. Compare the top-line `cp` value with what the artifact has. Note any differences in depth — the artifact and live API may disagree if computed at different depths or multiPv settings.

### 4. Deep-dive with raw Lichess eval DB (optional)

If the artifact and live API **disagree** (e.g. different cp at similar depths, or a depth present in the artifact but missing from the live API), use `lookup-fen.mjs` to inspect the raw source data. This streams the compressed Lichess cloud eval JSONL and shows **all** depth/PV entries for a position:

```sh
cd tools/opening-explorer && node lookup-fen.mjs "<FEN>"
```

This reveals:
- Which depths have been evaluated and their cp values per PV
- Whether a specific depth (e.g. the one the artifact captured) still exists in the raw DB or was purged
- Knodes searched at each depth, which can indicate evaluation quality

> **Note:** The `.jsonl.zst` database file must be present in `tools/opening-explorer/data/`. It is not checked into git due to size.

### 5. Query Master Theory

Check the Lichess Masters Opening Explorer for the **before** position to see if the move in question appears in master games:

```sh
source .env 2>/dev/null
curl -s -H "Authorization: Bearer $LICHESS_TOKEN" \
  "https://explorer.lichess.ovh/masters?fen=$(python3 -c "import urllib.parse; print(urllib.parse.quote('<FEN_BEFORE>'))")" \
  | python3 -m json.tool
```

From the response, check:
- Is the investigated move listed? How many games?
- Would `shouldSuppressHighlight` suppress it? (≥ 150 games → auto-suppress; or #1 move with ≥ 90% share and no strong alternative)

### 6. Synthesize the answer

Report to the user:

1. **Artifact evals**: before and after centipawn values and depths
2. **Eval drop**: computed value and category (ok / inaccuracy / mistake / blunder)
3. **Depth comparison**: whether the before/after depths are similar (large mismatches may produce unreliable drops)
4. **Live API check**: whether the live evals confirm or differ from the artifact
5. **Master theory**: game count and whether a highlight would be suppressed
6. **Conclusion**: why the move is or isn't highlighted, citing the specific threshold or suppression rule

#### Common reasons a move is NOT highlighted

- **Negative or zero eval drop** — the mover improved or held the position.
- **Drop below 30 cp** — too small to trigger any category.
- **Missing eval** — one or both positions aren't in the artifact; `computeEvalDrops` silently skips moves with missing data.
- **Opponent's move** — only the user's own moves (matching `orientation`) are evaluated.
- **Master theory suppression** — the move has ≥ 150 master games, or is the dominant top move.

#### Common reasons a move IS highlighted

- **Eval drop ≥ 30 cp** — and master theory did not suppress it.
- **Artifact depth disagreement** — the before/after positions were evaluated at different depths, creating an artificial gap.
- **Stale artifact eval** — Lichess periodically purges cloud evals when Stockfish is upgraded. A depth that existed when the artifact was built may no longer be available, and the current eval at a nearby depth can differ significantly. Use `lookup-fen.mjs` to verify.
