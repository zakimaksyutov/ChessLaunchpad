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

```jsonc
{
  "repertoires": [
    {
      "name": "White",
      "orientation": "white",
      "positions": {
        "<normalizedFEN>": {
          "arrows": [ { "brush":"G", "orig":"e2", "dest":"e4" } ],
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
- `arrows` is position-level. Omitted when empty.
- The `to`-FEN of an edge is not stored. Recompute by replaying SAN.
- Names are unique within `repertoires`. v1 hardcodes `"White"` and
  `"Black"`; both entries are always present, even if one's `positions`
  is `{}`.

## Read

```
1. GET blob.
2. If `repertoires` is present:
     Build the in-memory model from `repertoires` only.
3. Else (initial migration only, before the user's first save):
     Build graph from `data`.
     Hydrate cards from `fsrsCards`.
     Hydrate arrows from PGN comments (as done today).
```

No reconciliation across sources, no consistency check.

## Write

```
1. Serialize in-memory model → `repertoires`.
2. PUT { repertoires, settings, activity, games }.   // no data, no fsrsCards
```

Once a user saves, the legacy `data` and `fsrsCards` fields are gone
from their blob. There is no rollback path that preserves data; rolling
back the new client would surface an empty repertoire to users.

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
  blob's initial-migration read path, then persisted as `repertoires`.
- Exports emit the new blob shape.

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
- Re-enabling server-side schema validation for the new shape.
