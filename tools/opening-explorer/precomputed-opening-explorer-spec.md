# Precomputed Opening Explorer — Spec

## Goal

Produce a static opening explorer file that ships with ChessSecond. For any common opening position, the app can instantly show master game statistics and engine evaluation without calling an external API.

## Input

Lumbra's Giga Base — Elite OTB PGN (games where both players are rated 2400+). Free, updated monthly.

### How to download

1. Go to [lumbrasgigabase.com/en/download-in-pgn-format-en](https://lumbrasgigabase.com/en/download-in-pgn-format-en/)
2. Under the **"Downloads OTB"** tab, find the file labeled **"OTB Elite"** (both players ≥ 2400 Elo). It is ~124 MB in 7z format.
3. Download and extract with [7-Zip](https://7-zip.org/) (Windows) or [Keka](https://www.keka.io/) (Mac). The result is a single PGN file (~682 MB).

The file is re-generated on the first Tuesday of each month. No incremental updates needed — just re-download the full Elite file.

### Automated download

The download button on the Lumbra site redirects to MEGA. For scripted downloads use `mega-download.mjs` with this URL:

```
https://mega.nz/file/stQXSSDC#VEsidq2EvEgzhJki9ZQJgve3s_6xu7uOYbmS5SD0mw4
```

- **File**: `LumbrasGigaBase_OTB_Elite_ELO2400.7z`
- **Version**: 2026-04-07
- **Size**: ~124 MB compressed, ~682 MB extracted (838,293 games)

When refreshing, visit the source page, click the Elite download, and copy the new MEGA URL.

### Already downloaded

The .7z archive and extracted PGN are cached locally at:

```
tools/opening-explorer/data/elite.7z                              (~124 MB)
tools/opening-explorer/data/LumbrasGigaBase_OTB_Elite_ELO2400.pgn (~682 MB)
```

**Do not re-download.** These files are gitignored but already present on disk. Re-download only if the files are missing or a newer version of the database is needed.

## Output

A single JSON file (`opening-tree.json`) containing a flat map of opening positions, up to 15 moves (30 half-moves) deep.

### Current output — game statistics

Three opening tree variants have been generated with different `MIN_GAMES` thresholds:

```
tools/opening-explorer/data/opening-tree_3.json   (~44 MB)
tools/opening-explorer/data/opening-tree_6.json   (~19 MB)
tools/opening-explorer/data/opening-tree_12.json  (~21 MB)
```

All three files are already generated and present on disk.

The `_3` variant (default threshold) is used by the `produce` pipeline.

The threshold is configurable via `MIN_GAMES` env var; the suffix is always `_<threshold>`.

### Current output — engine evaluations

`enrich-evals.mjs` produces an evals file (e.g., `opening-explorer-evals_3.json`) keyed by compact FEN.

The script collects positions from **two sources**:

1. **Opening tree** — all positions in the tree JSON (e.g., 483,925 from `_3`).
2. **Lichess named openings** — TSV files (`a.tsv`–`e.tsv` from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)). Each PGN line is replayed move-by-move, collecting **every intermediate position** (not just the final one). This adds positions for named openings that may fall below the tree's `MIN_GAMES` threshold.

The union of both sets is matched against the Lichess cloud eval DB.

Existing eval files (old format with depth/PV):

```
tools/opening-explorer/data/evals_3.json   (~52 MB, 440,328 / 483,925 positions — 91%)
tools/opening-explorer/data/evals_6.json   (~23 MB, 198,377 positions)
tools/opening-explorer/data/evals_12.json  (~12 MB,  96,051 /  96,375 positions — 99.7%)
```

All eval files are already generated and present on disk.

Coverage is partial (~68% of the Lichess eval DB was readable) due to a data corruption error in `lichess_db_eval.jsonl.zst` at line ~251.6M of ~369M. A re-download of the source file may improve coverage.

### JSON structure

The file is a flat object keyed by **compact FEN** (piece placement + side to move + castling rights; no en-passant, halfmove, or fullmove counters).

Each value is an object of moves, where each move maps to a stats array:

```json
{
  "<compact FEN>": {
    "<SAN move>": [count, whiteWins, draws, blackWins, eloSum],
    ...
  },
  ...
}
```

Example:

```json
{
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq": {
    "c5": [157439, 48652, 73370, 35417, 397204136],
    "e5": [98751, 28066, 52561, 18124, 251558748],
    "e6": [39723, 12831, 18956, 7936, 100103028]
  }
}
```

- **`count`** — total games where this move was played from this position
- **`whiteWins`** / **`draws`** / **`blackWins`** — result breakdown
- **`eloSum`** — sum of average player Elo across all games (divide by `count` to get average Elo)

### Engine evaluations file

`enrich-evals.mjs` produces a public-artifact-format evals file (e.g., `opening-explorer-evals_3.json`) keyed by compact FEN:

```json
{
  "<compact FEN>": eval
}
```

- **`eval`** — centipawn score (integer, from white's perspective). For mate positions: `100000 + N` for white mate-in-N, `-100000 - N` for black mate-in-N.

Usage:

```bash
node enrich-evals.mjs <opening-tree.json> --eval-db <path-to-zst> --openings <dir> --output <path>
```

- `<opening-tree.json>` — path to the opening tree JSON (required)
- `--eval-db <path>` — path to Lichess cloud eval `.jsonl.zst` (required)
- `--openings <dir>` — directory containing `a.tsv` … `e.tsv` from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (required)
- `--output <path>` — output JSON file path (required)

The script validates that all input files exist before processing, and prints a configuration banner at startup.

## Engine Evaluations — Lichess Cloud Eval Database

### Source

The Lichess project publishes a bulk database of **369 million** Stockfish-evaluated positions, crowdsourced from users running analysis on lichess.org.

- **URL**: https://database.lichess.org/lichess_db_eval.jsonl.zst
- **Format**: Zstandard-compressed JSONL (one JSON object per line)
- **Size**: ~18.8 GB compressed
- **Last updated**: 2026-04-02

### Already downloaded

```
tools/opening-explorer/data/lichess_db_eval.jsonl.zst   (~18.8 GB)
```

**Do not re-download.** This file is gitignored but already present on disk. Re-download only if the file is missing or a newer version is needed.

### JSONL record format

Each line is a JSON object keyed by FEN (piece placement + active color + castling + en-passant):

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
  "evals": [
    {
      "depth": 50,
      "knodes": 13683,
      "pvs": [
        { "cp": 27, "line": "e7e5 d2d4 d7d5 ..." },
        { "cp": 52, "line": "g1f3 d7d5 ..." }
      ]
    },
    {
      "depth": 34,
      "knodes": 74318,
      "pvs": [
        { "cp": 27, "line": "e7e5 d2d4 d7d5 ..." },
        { "mate": 15, "line": "e5e6 g8f8 e4d6 ..." }
      ]
    }
  ]
}
```

### Eval extraction logic

To get the best evaluation for a position:

1. **`record.fen`** — identifies the position (4-part FEN: pieces + side + castling + EP).
2. **`record.evals`** — array of eval entries at different Stockfish depths. Pick the entry with the **highest `depth`** (= most accurate).
3. **`.pvs[0]`** — first PV is the **best line** (strongest continuation).
4. **`.cp`** — centipawn evaluation from **white's perspective** (positive = white is better, negative = black is better). Mutually exclusive with `.mate`.
5. **`.mate`** — mate-in-N moves (positive = white delivers mate, negative = black delivers mate). Mutually exclusive with `.cp`.
6. **`.line`** — principal variation in **UCI** long-algebraic format (e.g., `e7e5 d2d4`), not SAN.

Field notes:
- `evals` is ordered by number of PVs, **not** by depth — always sort/scan to find the highest-depth entry.
- `knodes` = thousands of nodes searched (informational, not needed for enrichment).
- A single record may have multiple eval entries (e.g., depth 46 with 5 PVs and depth 34 with 20 PVs).

### FEN key matching

The Lichess eval DB uses a **4-part FEN** (pieces + side + castling + EP), while the opening tree uses a **3-part compact FEN** (pieces + side + castling, no EP). To match:

- Strip the EP field from the Lichess FEN: `"rnbqkbnr/... b KQkq -"` → `"rnbqkbnr/... b KQkq"`.
- Look up the result in the opening tree's compact FEN keys.

### Enrichment process

1. **Load** the opening tree (e.g., `opening-tree_3.json`) into a Set of compact FEN keys.
2. **Load** Lichess named openings from TSV files (`a.tsv`–`e.tsv`). Each PGN line is replayed move-by-move via chess.js, collecting the compact FEN of every intermediate and final position.
3. **Merge** both sets into a single lookup set (union).
4. **Stream** the compressed JSONL through `zstd -d -c` (pipe to stdout — no need to extract the full ~100+ GB file to disk).
5. For each line, convert the Lichess 4-part FEN to compact 3-part FEN and check if it exists in the lookup set.
6. For matching positions, extract the **highest-depth** eval entry's **first PV**: `cp` (or `mate`).
7. Write output as `{ "compactFEN": eval }` — matching the public artifact format consumed by the app.

This avoids the Lichess Cloud Eval API rate limit (~1 req/sec) and provides offline, instant lookup for all 369M positions.


## Size Target

The eval artifact is ~30 MB raw / ~5.8 MB gzipped. Web servers serve the gzipped version.

