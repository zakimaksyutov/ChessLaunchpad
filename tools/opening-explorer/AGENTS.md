# AGENTS.md — Opening Explorer

This tool produces the **`opening-explorer-evals.json`** artifact — a mapping of compact FEN positions to Stockfish centipawn evaluations.

## Pipeline Overview

The artifact is produced in two stages:

1. **Build opening tree** — Parse a master-games PGN database to identify common opening positions.
2. **Enrich with evals** — Stream the Lichess cloud eval database, match positions from the opening tree (and Lichess named openings), and write centipawn values.

## Data Sources

### 1. Lumbra's Giga Base — Elite OTB PGN

Master games (both players ≥ 2400 Elo). Free, updated monthly on the first Tuesday.

- **Download page**: https://lumbrasgigabase.com/en/download-in-pgn-format-en/
- **Tab**: "Downloads OTB" → "OTB Elite – ELO > 2400"
- **MEGA URL** (2026-04-07 version): `https://mega.nz/file/stQXSSDC#VEsidq2EvEgzhJki9ZQJgve3s_6xu7uOYbmS5SD0mw4`
- **Size**: ~124 MB compressed (.7z), ~682 MB extracted (.pgn), ~838,293 games

### 2. Lichess Cloud Eval Database

Bulk database of ~369 million Stockfish-evaluated positions, crowdsourced from lichess.org users.

- **URL**: https://database.lichess.org/lichess_db_eval.jsonl.zst
- **Format**: Zstandard-compressed JSONL (one JSON object per line)
- **Size**: ~18.8 GB compressed
- **Requires**: `zstd` CLI tool for streaming decompression

### 3. Lichess Named Openings (TSV)

ECO-classified openings from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings). Files `a.tsv` through `e.tsv`, each with columns: `eco`, `name`, `pgn`.

## Quick Start

```bash
cd tools/opening-explorer
npm run produce
```

This installs dependencies, builds the opening tree, and produces `data/opening-explorer-evals.json`.

### Downloading source data (first time only)

```bash
npm install
node mega-download.mjs    # Download PGN from MEGA (~124 MB .7z)
node download.mjs         # Extract .7z → .pgn (~682 MB)
```

## Data Files (gitignored)

All files in `data/` are gitignored. They should already be present on disk. Do not re-download unless files are missing or a newer version is explicitly needed.

| File | Size | Description |
|------|------|-------------|
| `data/elite.7z` | ~124 MB | Lumbra Elite PGN archive |
| `data/LumbrasGigaBase_OTB_Elite_ELO2400.pgn` | ~682 MB | Extracted PGN (838,293 games) |
| `data/20260412_lichess_db_eval.jsonl.zst` | ~18.8 GB | Lichess cloud eval database |
| `data/[a-e].tsv` | ~367 KB total | Lichess named openings |
| `data/opening-tree_{N}.json` | 21–44 MB | Opening tree output; `N` = MIN_GAMES threshold |
| `data/opening-explorer-evals.json` | ~29 MB | Public artifact (current format) |

## Algorithm — How the Artifact Is Produced

### Stage 1: Opening Tree (`build-tree.mjs`)

Parse master PGN → flat JSON mapping compact FEN positions to per-move game statistics.

### Stage 2: Eval Enrichment (`enrich-evals.mjs`)

Match positions from the opening tree and Lichess named openings against the Lichess cloud eval DB → flat JSON mapping compact FEN to centipawn values.

### Output Format

```json
{
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq": [18, 27],
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq": [27]
}
```

- Keys: **compact FEN** — piece placement + side to move + castling rights (3 fields, no en-passant or move counters)
- Values: array of up to 2 centipawn values from the 2 deepest Stockfish entries (deepest first). Positions with only one eval entry produce a single-element array.
- Mate encoding: `±(100000 + N)`

## Key Scripts

| Script | Purpose |
|--------|---------|
| `mega-download.mjs` | Download .7z from MEGA. Default URL hardcoded as `DEFAULT_URL`. |
| `download.mjs` | Extract .7z → .pgn. Requires `mega-download.mjs` to run first. |
| `build-tree.mjs` | Parse PGN → opening tree JSON. `MIN_GAMES` env var controls threshold. Output filename includes threshold suffix (e.g. `opening-tree_3.json`). |
| `enrich-evals.mjs` | Stream Lichess eval DB → public artifact. Requires `zstd` CLI. |
| `loader.mjs` | Runtime loader (not used in artifact production). |

## Refreshing the Artifact

1. Download a new Lumbra PGN if a newer monthly release is available (update `DEFAULT_URL` in `mega-download.mjs`).
2. Download a new Lichess eval DB if a newer version is available from https://database.lichess.org/.
3. Re-run the pipeline (steps 1–4 above).

## CommonJS Note

`package.json` uses `"type": "commonjs"`. Scripts use `.mjs` extension for ESM imports.
