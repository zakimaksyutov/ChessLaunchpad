# Repertoire Storage

How a user's repertoire is held in memory and persisted. Covers intent
and invariants only — for exact shapes, validation, and encoding
behavior, read the code:

- `app/src/models/Repertoires.ts` — in-memory types
- `app/src/models/RepertoireData.ts` — top-level blob type
- `app/src/utils/BlobCodec.ts` — v3 wire encode/decode + version policy
- `app/src/utils/RepertoiresSerde.ts` — legacy bootstrap, card sync

## Model

A user has named **repertoires** (v1 hardcodes `White` and `Black`).
Each is a dict of normalized FEN → position entry. A position entry
carries `moves` (keyed by SAN) and optional `annotations`. Move
entries are `{ card }` on user moves (side-to-move matches the
repertoire's orientation) and `{}` on opponent moves. The symmetric
wrapper leaves room for per-edge metadata on either side without a
schema change.

Position-centric so transpositions are first-class: training,
Explorer, and game ingestion all key off FENs, and a position has one
set of next moves regardless of how many PGN paths reach it.

## Invariants

- Always two repertoires (White, Black), both present even when one
  has zero positions.
- User-vs-opponent move is derived from FEN side-to-move + orientation;
  no discriminator is stored.
- FEN keys are normalized via `normalizeFenResetHalfmoveClock`
  (`app/src/utils/FenUtils.ts`).
- The `to`-FEN of an edge is not persisted — it is recomputed by SAN
  replay and denormalized onto the in-memory entry as a hot-path
  shortcut.
- FSRS cards inline on user moves are authoritative. The flat
  `fsrsCards` map is an in-memory view, rebuilt on load and projected
  back on save.

## Persistence

The in-memory shape (FEN-keyed dicts, object FSRS cards) is convenient
for runtime. The wire form is a compact v3 encoding: positions become
a BFS-ordered array, move keys carry the child's array index,
transpositions collapse onto a shared index, and FSRS cards pack as
positional arrays with epoch-ms dates. Roughly 55% smaller than v1 on
real repertoires. `settings`, `activity`, and `games` ride along the
same blob unchanged.

The codec rejects illegal SANs and orphan positions on both encode and
decode rather than silently dropping data.

## Legacy compatibility

Older blobs and `.chess` exports use a flat array of PGN lines plus a
flat FSRS-card map. On read, a one-time bootstrap rebuilds the
position-centric model from these; the next save rewrites the blob as
v3 and the legacy fields are gone. The same bootstrap handles legacy
`.chess` imports.

Roll-forward only: a user who has saved through the v3 client has no
`data` / `fsrsCards` on their blob, so reverting them to a pre-v3
client would surface an empty repertoire. Server-side schema
validation is currently disabled (`BACKEND_API_CONTRACT.md`); when
re-enabled it must match v3.
