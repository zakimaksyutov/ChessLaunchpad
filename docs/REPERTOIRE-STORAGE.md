# Repertoire Storage

Technical reference for how a user's repertoire is held in memory and
persisted on the wire. Cross-cutting — every feature (training,
Explorer, game ingestion, save/load) keys off this shape.

For the REST envelope around the blob see `BACKEND_API_CONTRACT.md`.
For how the legacy variant-centric blob is read once and then dropped
see [Legacy compatibility](#legacy-compatibility) below.

## The Idea

A user has named **repertoires**. Each is a dictionary of positions and
the moves leaving them. FSRS cards live inline on user moves; opponent
moves are present but empty.

## Shape

The position-centric model is written below with **full FEN keys and
object-shaped cards**. This is the *in-memory* model — every consumer
(training, Explorer, game annotation) uses this shape. The *persisted*
shape on disk and on the wire is a compact encoding of the same model —
see [Wire Encoding](#wire-encoding-v3) below.

```jsonc
{
  "repertoires": [
    {
      "name": "White",
      "orientation": "white",
      "positions": {
        "<normalizedFEN>": {
          "annotations": [
            { "brush": "G", "orig": "e2", "dest": "e4" },
            { "brush": "R", "orig": "e5" }
          ],
          "moves": {
            "e4":  { "card": { ...FSRSCardData } },
            "d4":  { "card": { ... } }
          }
        },
        "<normalizedFEN-after-1e4>": {
          "moves": {
            "e5": {},
            "c5": {}
          }
        }
      }
    },
    { "name": "Black", "orientation": "black", "positions": { ... } }
  ],

  "settings": { ... },
  "activity": { ... },
  "games": { ... }
}
```

### Rules

- A repertoire's `orientation` is the side the user plays.
- For a position whose side-to-move matches the repertoire's orientation,
  each entry in `moves` is a **user move** and carries a `card`. For any
  other position, each entry is an **opponent move** and is `{}`. No
  discriminator field is stored — it's derived.
- The wrapper object on every `moves` entry (`{ "card": ... }` /
  `{}`) leaves a symmetric, extensible home for future per-edge metadata
  on both sides.
- `annotations` is position-level. Omitted when empty. Each entry is an
  arrow (`{ brush, orig, dest }`) or a square highlight (`{ brush, orig }`)
  — matches today's `Annotation` model.
- The `to`-FEN of an edge is not stored. Recompute by replaying SAN.
- Names are unique within `repertoires`. v1 hardcodes `"White"` and
  `"Black"`; both entries are always present, even if one's `positions`
  is `{}`.

## Read

```
1. GET blob.
2. Decode the wire shape into the in-memory model (see Wire Encoding):
     - v3 (compact): rebuild full-FEN-keyed positions by walking the
       `positions` array from index 0 (= standard initial FEN) and
       unpacking each card.
     - Absent `v` (legacy v1): pass through unchanged; the in-memory
       `repertoires` are bootstrapped from `data` + `fsrsCards` (see
       [Legacy compatibility](#legacy-compatibility)).
3. Build the in-memory model from `repertoires`.
```

No reconciliation across sources, no consistency check.

## Write

```
1. Serialize in-memory model → `repertoires`.
2. Encode `repertoires` to the v3 wire shape (see Wire Encoding):
     - convert each repertoire's positions dict to an array via a
       deterministic BFS from the standard initial FEN
     - emit each outgoing move as "<SAN>:<childIndex>" (or
       "<SAN>:-1" if the child position is not stored)
     - pack each FSRS card as a positional array
     - convert `d` / `lr` to epoch milliseconds
3. PUT { v: 3, repertoires, settings, activity, games }.
```

The legacy `data` and `fsrsCards` fields are never written. Any user
who has saved through the v3 client has no legacy fields on their blob.

## Wire Encoding (v3)

The in-memory model is FEN-keyed and uses object-shaped FSRS cards with
ISO date strings — convenient for runtime reasoning. The persisted blob
on the backend (`PUT /user/{u}/variants`) and in `.chess` export files
uses a compact encoding (v3) that is ~55% smaller than v1 on real
repertoires (measured: 398 KB → 175 KB on a 2266-position blob). The
transform is confined to the persistence boundary
(`app/src/utils/BlobCodec.ts`); no runtime code uses the v3 shape.

The wire format intentionally does **not** store FEN strings. Every FEN
is reconstructed at decode time by replaying the SAN edges from the
standard initial position. Position identity on the wire is just the
array index; identity in memory is the normalized FEN string.

### Shape

```jsonc
{
  "v": 3,
  "repertoires": [
    {
      "name": "White",
      "orientation": "white",
      "positions": [
        // index 0 = standard initial position (always, when non-empty)
        {
          "annotations": [ ... ],                 // optional, unchanged shape
          "moves": {
            "e4:1": { "card": [d, s, di, e, sd, ls, r, l, st, lr?] },
            "d4:2": {}                            // opponent move — envelope kept
          }
        },
        // index 1 = position after 1.e4
        { "moves": { "e5:3": {}, "c5:4": {} } },
        // ...
      ]
    },
    { "name": "Black", "orientation": "black", "positions": [ ... ] }
  ],
  "settings": { ... },
  "activity": { ... },
  "games": { ... }
}
```

### Rules

- **Version flag.** `v` is required at the root for v3. Absent → legacy
  v1 (pass-through; `normalize` handles it). `v: 2` is a hard error
  (interim hashed-key format never shipped — see Versioning policy).
  Any other value is also a hard error
  (`Unsupported repertoire blob version`).
- **Positions array.** Per repertoire, `positions` is an array of
  position entries in deterministic BFS-from-root order. Index 0 is the
  standard initial position (normalized via
  `normalizeFenResetHalfmoveClock`) when the repertoire is non-empty.
  Empty repertoires emit `[]`.
- **Move keys.** Each move is keyed by `"<SAN>:<childIndex>"`, where
  `childIndex` is the index of the child position in this repertoire's
  `positions` array, or `-1` if the child position is not stored in the
  repertoire (e.g., a user-move whose continuation was never explored).
  Standard PGN SAN never contains `:`, so splitting on the last `:` is
  unambiguous.
- **Transpositions collapse.** Different SAN paths that reach the same
  normalized FEN share the same `childIndex`. The encoder maintains a
  `FEN → index` map during the BFS; the decoder cross-checks that any
  re-visited index produces a consistent FEN.
- **Determinism.** BFS visits children in `Array.prototype.sort()` order
  over SAN keys. Combined with the ECMAScript guarantee (ES2015+) that
  string-keyed object properties iterate in insertion order, the same
  in-memory model always encodes to byte-identical JSON across browsers
  and Node.
- **Packed cards.** Each FSRS card is a positional array:
  `[d, s, di, e, sd, ls, r, l, st]` (length 9, no `last_review`) or
  `[d, s, di, e, sd, ls, r, l, st, lr]` (length 10). `d` and `lr` are
  **epoch milliseconds**, not seconds — preserves the sub-second ordering
  `GameIngestService.shouldApplyRating` relies on.
- **Other date fields are untouched.** `activity.practiceLog[].date` stays
  `YYYY-MM-DD`; `games.watermarkMs` / `recentIds[].ts` stay as already-ms
  integers.
- **Edge envelope unchanged.** Opponent moves are still `{}`; user moves
  are `{ "card": [...] }`. The symmetric wrapper is preserved to keep
  future per-edge metadata possible on both sides.
- **Annotations unchanged.** Same shape and meaning as in-memory.

### Round-trip integrity

- **Encode** rejects any position whose FEN is not reachable from the
  standard initial FEN by replaying SANs in `moves` (orphan check) and
  any SAN that cannot be replayed from its parent's FEN (illegal-move
  check). Either condition throws rather than silently dropping data.
- **Decode** rebuilds the FEN-keyed dict by walking `positions` from
  index 0. The walk is cycle-safe (FENs collapse under
  `normalizeFenResetHalfmoveClock` — knight shuffles can transpose back
  to root; their wire edges point at a smaller index, which is fine).
  Decode rejects:
  - any persisted index not reached by the walk (orphan, symmetric with
    encode's check),
  - any `childIndex` outside `[-1, positions.length - 1]`,
  - any illegal SAN (replayed even for `-1` edges, so corrupt SANs can't
    silently inject ghost `moves[SAN]` entries),
  - any case where two paths reach the same `childIndex` but compute
    different child FENs (consistency cross-check; catches blobs with
    mis-pointed edges).

### Versioning policy

- v1 readers seeing a v3 blob will treat it as missing data — same risk
  already accepted for the `repertoires` migration ("Stale tabs running
  the old client" below).
- **v2 (skipped).** An interim hashed-FEN-key format briefly lived on
  the `migration` branch but never shipped. The decoder hard-errors on
  `v: 2` so any stale dev blob surfaces loudly instead of being
  mis-parsed.
- Future versions (v4+) must be introduced by bumping `v` and routing
  through a new decoder branch; unknown versions are a hard error.
- Server-side schema validation is currently disabled
  (`BACKEND_API_CONTRACT.md`), so the backend accepts v3 today.
  When validation is re-enabled it must be updated to match v3.

## Legacy compatibility

Older blobs and `.chess` exports store a flat array of PGN lines
(`data: [...]`) plus a flat dictionary of FSRS cards keyed by
`<FEN>::<SAN>`. The decoder accepts these as-is (no `v` field). A
one-time bootstrap in `app/src/utils/RepertoiresSerde.ts` walks each
legacy PGN, builds the position dict per orientation, places FSRS
cards on user-turn moves, and lifts PGN-comment annotations onto
their positions. Result is the in-memory v3 model; on the next save
the blob is rewritten as v3 and the legacy fields are gone forever.

The same bootstrap runs when a user imports a `.chess` file in the
legacy shape on the Settings page.

Consequences worth knowing about:

- **Roll-forward only.** A user who has saved through the v3 client
  has no `data` / `fsrsCards` on their blob. Reverting them to a
  pre-v3 client would surface an empty repertoire.
- **Stale v1 tabs** that read a v3 blob will treat it as missing data
  (no `data` field). Same accepted risk.
- **Illegal-SAN handling.** The v3 encoder throws on any
  `moves[SAN]` entry whose SAN can't be replayed from its parent
  FEN, rather than silently dropping it. All current SAN sources
  (PGN import, game ingestion, FSRS updates) pre-validate via
  chess.js, so this only surfaces on a corrupted legacy blob — and
  in that case the next save fails loudly. Recovery is manual
  (export → fix → import).
