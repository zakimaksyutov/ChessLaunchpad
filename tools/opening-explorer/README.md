# Opening Explorer — Experiment

Static opening tree built from master games (≥2400 Elo) for offline position statistics.

## Quick Start

```bash
cd tools/opening-explorer
npm install

# 1. Download from MEGA (~124 MB .7z)
node mega-download.mjs

# 2. Extract .7z → .pgn (~682 MB)
node download.mjs

# 3. Build the opening tree (up to 15 moves deep, ≥3 games per move)
node build-tree.mjs

# Override min-games threshold:
MIN_GAMES=20 node build-tree.mjs

# Output: data/opening-tree_3.json (~44 MB at default threshold)
```

### Refreshing the data

The Lumbra Elite PGN is updated on the first Tuesday of each month. To refresh:

1. Visit https://lumbrasgigabase.com/en/download-in-pgn-format-en/
2. Under "Downloads OTB" → "OTB Elite – ELO > 2400", click Download
3. Copy the new MEGA URL and update `DEFAULT_URL` in `mega-download.mjs`
4. Delete `data/` and re-run steps 1–3 above

## What It Produces

**96,375 positions** and **132,195 moves** from **838,293 elite games** (both players ≥2400 Elo).

A JSON file mapping **compact FEN** → **move statistics**:

```json
{
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq": {
    "c5": [157439, 48652, 73370, 35417, 397204136],
    "e5": [98751, 28066, 52561, 18124, 251558748]
  }
}
```

Each move value is an array: `[count, whiteWins, draws, blackWins, eloSum]`.
At query time: `avgElo = eloSum / count`.

**Compact FEN** = piece placement + side to move + castling rights (no en-passant, no move counters).

## Using the Loader

```js
import { OpeningExplorer } from './loader.mjs';

const explorer = await OpeningExplorer.load('/opening-tree.json');

const data = explorer.lookup(chess.fen());
if (data) {
  // data.moves = { "e4": { count, white, draw, black, avgElo }, ... }
}
```

## File Structure

```
tools/opening-explorer/
├── download.mjs       # Extracts .7z if already downloaded
├── mega-download.mjs  # Downloads from MEGA
├── build-tree.mjs     # Parses PGN, builds position tree, outputs JSON
├── enrich-evals.mjs   # Enriches tree with Lichess cloud evals
├── loader.mjs         # Runtime loader
├── lookup-fen.mjs     # Diagnostic: look up a FEN in the raw eval DB
├── README.md
├── package.json
├── .gitignore
└── data/              # (gitignored) PGN + output files
    ├── elite.7z                      # 124 MB (downloaded)
    ├── *.pgn                         # 682 MB (extracted)
    ├── opening-tree_N.json           # Opening tree (N = MIN_GAMES threshold)
    └── opening-explorer-evals.json   # Public artifact (evals)
```

## Design Decisions

- **Compact FEN key**: Strips en-passant, halfmove, and fullmove counters. In opening theory these rarely differ for the same position.
- **Flat map, not a trie**: Simpler to query; positions are independent lookups.
- **Array values**: `[count, white, draw, black, eloSum]` saves ~40% vs named fields.
- **eloSum stored, not avgElo**: Allows future merging of trees without losing precision.
- **Min 3 games default threshold**: Configurable via `MIN_GAMES` env var. Output filename includes the threshold as suffix (`opening-tree_3.json`, etc.).
