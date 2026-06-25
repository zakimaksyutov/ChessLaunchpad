# Backend Eval DB

## Goal

Host a full Stockfish-eval lookup in the backend, derived from the Lichess
cloud eval DB, reduced to one value per position. Replaces reliance on the
master-tree-filtered artifact; covers any position users reach, including
opening blunders.

Hosting our own also removes reliance on Lichess's live cloud-eval API, which
is load-sensitive and throttles at our usage level.

## Input

Lichess cloud eval DB (`lichess_db_eval.jsonl.zst`, ~388M positions, ~19 GB).
Each record: a position FEN plus multiple Stockfish evaluations (varying
depth and PV count, each with full principal-variation lines and metadata).

Each record reduces to a single `position → value` entry: the compact FEN as
key, one scalar (centipawns, or a mate score encoded distinctly) from the
deepest evaluation's best line as value. All PV lines, secondary PVs, shallower
evaluations, and engine metadata are discarded. All positions are kept (no
filtering).

## Size calculations

Measured on a 1M-record sample, extrapolated to all ~388M positions:

| Format                          | Per entry | Total (388M) |
| ------------------------------- | --------- | ------------ |
| Raw JSON                        | 57.5 B    | ~22 GB       |
| gzip                            | 13.1 B    | ~5.1 GB      |
| brotli                          | 9.4 B     | ~3.7 GB      |
| packed binary (u64 hash + i16)  | 10 B      | ~3.9 GB      |

Format alone, not position count, is the only lever here — every position is
retained. brotli (~3.7 GB) is the reference target.

## Position source — amateur games

The cloud eval DB above is keyed by position only, with no notion of which
positions are openings or how often they occur. The current artifact narrows it
with a master-games position set, which excludes the bad opening moves masters
never play. To cover those, source the position set from the Lichess standard
game dumps instead.

- **Source**: Lichess standard game dumps (monthly PGN, all rating levels,
  amateurs included), from the same site as the cloud eval DB.
  - Index page: <https://database.lichess.org/> (Standard games section)
  - Download list: <https://database.lichess.org/standard/list.txt>
  - Per-month file, e.g.
    <https://database.lichess.org/standard/lichess_db_standard_rated_2026-05.pgn.zst>
  - Cloud eval DB (eval source):
    <https://database.lichess.org/lichess_db_eval.jsonl.zst>
- **Use**: extract early-game positions (first N plies) to define an
  opening-position universe that includes amateur blunders, weighted by
  occurrence.
- **Evals still come from the 19 GB cloud eval DB** — the amateur games supply
  only *which* positions to keep, not their values.

This yields an opening-tailored, blunder-inclusive dataset far smaller than the
full cloud DB, at the cost of streaming large monthly PGN dumps (tens of GB
compressed each).

