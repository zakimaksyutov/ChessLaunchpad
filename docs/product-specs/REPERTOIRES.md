# Repertoires — Position-Based Storage

Replace the variant-centric repertoire blob with a position-centric one,
remove the variant-editor surface from the app, and stop persisting the
legacy `data` and `fsrsCards` fields.

## The Idea

A user has named **repertoires**. Each is a dictionary of positions and
the moves leaving them. FSRS cards live inline on user moves; opponent
moves are present but empty.

Today the repertoire is stored as a flat array of PGN lines (`data: [...]`)
plus a sibling flat dictionary of FSRS cards keyed by `<FEN>::<SAN>`. The
runtime already rebuilds a position DAG from these and every feature
(training, Explorer, game annotation) keys off positions. This spec moves
**persistence**, retires the **variant editor**, and commits the app
fully to the new shape.

## Shape

The position-centric model is written below with **full FEN keys and
object-shaped cards**. This is the *in-memory* model — every consumer
(training, Explorer, game annotation) uses this shape. The *persisted*
shape on disk and on the wire is a compact encoding of the same model —
see [Wire Encoding](#wire-encoding-v2) below.

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

`data` and `fsrsCards` are **no longer written**. After the first save
through the new client they are absent from the blob.

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
     - v2 (compact): rebuild full-FEN-keyed positions by walking the
       graph from the standard initial FEN and unpacking each card.
     - Absent `v` (legacy): pass through unchanged.
3. If `repertoires` is present:
     Build the in-memory model from `repertoires` only.
4. Else (initial migration only, before the user's first save):
     Build graph from `data`.
     Hydrate cards from `fsrsCards`.
     Hydrate annotations from PGN comments (as done today).
```

No reconciliation across sources, no consistency check.

## Write

```
1. Serialize in-memory model → `repertoires`.
2. Encode `repertoires` to the v2 wire shape (see Wire Encoding):
     - hash FEN keys
     - pack each FSRS card as a positional array
     - convert `d` / `lr` to epoch milliseconds
3. PUT { v: 2, repertoires, settings, activity, games }.   // no data, no fsrsCards
```

Once a user saves, the legacy `data` and `fsrsCards` fields are gone
from their blob. There is no rollback path that preserves data; rolling
back the new client would surface an empty repertoire to users.

## Wire Encoding (v2)

The in-memory model is FEN-keyed and uses object-shaped FSRS cards with
ISO date strings — convenient for runtime reasoning. The persisted blob
on the backend (`PUT /user/{u}/variants`) and in `.chess` export files
uses a compact encoding (v2) that is ~50% smaller on real repertoires.
The transform is confined to the persistence boundary
(`app/src/utils/BlobCodec.ts`); no runtime code uses the v2 shape.

### Shape

```jsonc
{
  "v": 2,
  "repertoires": [
    {
      "name": "White",
      "orientation": "white",
      "positions": {
        "<hash(FEN)>": {                          // 12-char base64url SHA-1
          "annotations": [ ... ],                 // unchanged
          "moves": {
            "e4": { "card": [d, s, di, e, sd, ls, r, l, st, lr?] },
            "d4": {}                              // opponent move — envelope kept
          }
        }
      }
    },
    { "name": "Black", "orientation": "black", "positions": { ... } }
  ],
  "currentEpoch": 0,
  "lastPlayedDate": "...",
  "dailyPlayCount": 0,
  "settings": { ... },
  "activity": { ... },
  "games": { ... }
}
```

### Rules

- **Version flag.** `v` is required at the root for v2. Absent → legacy
  v1 (pass-through; `normalize` handles it). Any other value → hard
  error (`Unsupported repertoire blob version`).
- **Hashed FEN keys.** Each `positions` key is the first 9 bytes of
  MurmurHash3 x86_128 of the normalized FEN, encoded as 12-char
  base64url (72 bits of entropy). Non-cryptographic — we only need
  collision avoidance, not adversarial resistance. Collisions are
  asserted on encode (per-repertoire).
- **Packed cards.** Each FSRS card is a positional array:
  `[d, s, di, e, sd, ls, r, l, st]` (length 9, no `last_review`) or
  `[d, s, di, e, sd, ls, r, l, st, lr]` (length 10). `d` and `lr` are
  **epoch milliseconds**, not seconds — preserves the sub-second ordering
  `GameIngestService.shouldApplyRating` relies on.
- **Other date fields are untouched.** Root-level `lastPlayedDate` stays
  ISO; `activity.practiceLog[].date` stays `YYYY-MM-DD`;
  `games.watermarkMs` / `recentIds[].ts` stay as already-ms integers.
- **Edge envelope unchanged.** Opponent moves are still `{}`; user moves
  are `{ "card": [...] }`. The symmetric wrapper is preserved to keep
  future per-edge metadata possible on both sides.
- **Annotations unchanged.** Same shape and meaning as in-memory.

### Round-trip integrity

- **Encode** rejects any position whose FEN is not reachable from the
  standard initial FEN by replaying SANs in `moves` (orphan check) and
  any two FENs colliding under the hash. Either condition throws
  rather than silently dropping data.
- **Decode** rebuilds the FEN-keyed dict by walking the graph from the
  standard initial FEN. The walk is cycle-safe (FENs collapse under
  `normalizeFenResetHalfmoveClock` — knight shuffles can transpose back
  to root). Decode rejects v2 blobs containing hashed entries the walk
  never reaches (symmetric with the encode-side check).

### Versioning policy

- v1 readers seeing a v2 blob will treat it as missing data — same risk
  already accepted for the `repertoires` migration ("Stale tabs running
  the old client" below).
- Future versions (v3+) must be introduced by bumping `v` and routing
  through a new decoder branch; unknown versions are a hard error.
- Server-side schema validation is currently disabled
  (`docs/BACKEND_API_CONTRACT.md`), so the backend accepts v2 today.
  When validation is re-enabled it must be updated to match v2.

## UI Changes

### Removed

- `/repertoire` page (variant table).
- `/repertoire/variant` page (variant editor).
- Header "Repertoire" link and its route registration.
- "Train with filter" handoff from the variant table.
- **Paste PGN** functionality (the textarea on the variant editor that
  loaded a PGN line into the editor). Not relocated. To add new lines
  in v1, users round-trip a `.chess` file through Import / Export.

### Relocated

- **Import / Export** move to the **Settings** page. Without them users
  cannot seed a fresh repertoire (since the variant editor is gone).
- Imported `.chess` files in the legacy `data`/`fsrsCards` shape are
  converted in-memory on import using the same one-time bootstrap as the
  blob's initial-migration read path, then persisted as v2.
- Exports emit the v2 wire shape (compact encoding — see
  [Wire Encoding](#wire-encoding-v2)).

### Unchanged

- `/explorer` stays read-only. No in-app way to add, edit, or delete
  moves in v1 of this spec.
- `/training`, `/games`, `/settings`, `/dashboard`, login.
- The on-board variant-preview behavior the variant table used today
  (`PgnControl` + `AnalysisPopover`) is preserved if it's reused
  elsewhere; otherwise it dies with the variant table.

## Migration

Lazy, on first save by the new client. No special endpoint, no eager PUT
on read. A user who never saves stays on the bootstrap read path
indefinitely and continues to see their existing repertoire — but
because there is no in-app editing surface, the practical trigger for
the first save is any FSRS card update (i.e. any training session).

### Accepted consequences

- **No in-app repertoire editing in v1** beyond Import/Export. Explorer
  editing is a separate future spec.
- **Rolling back the new client is destructive** for any user who has
  saved through it (their `data` and `fsrsCards` are gone). Roll forward,
  not back.
- **Stale tabs running the old client** after a new-client save will see
  an empty repertoire on next read (no `data`).

## Out of Scope

- Multiple repertoires per orientation in the UI (schema supports it;
  v1 hardcodes one each).
- Per-edge metadata beyond `card` (wrapper is ready; no fields yet).
- Per-position text notes (room reserved in the position entry).
- Explorer-driven editing of individual edges.
- Re-enabling server-side schema validation for the v2 wire shape.
