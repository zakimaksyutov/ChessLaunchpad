# FSRS Card List — Product Specification

A diagnostic page at `/fsrs` that lists every FSRS card with its
position identity and scheduling state. For inspecting how the
scheduler behaves on real data — not part of the normal training flow.
It does not edit the repertoire; its only write is Track/Untrack.

## Access

- Reached only via a new **FSRS cards** item in the `⋯` overflow menu
  on `/explorer`.
- No header nav link, but the direct URL works (Back/Refresh/share).

## Content

Lists every card across both repertoires — one **card block** per
`(normalized FEN, move SAN)`. Each block shows:

- **Repertoire** — White or Black, derived from the FEN's side to move.
- **Identity** — the move SAN and the normalized FEN of the card's
  position.
- **State** — pill for New / Learning / Review / Relearning.
- **FSRS details** — due (relative + absolute), retrievability,
  stability, difficulty, reps, lapses, last reviewed, current interval.
  Show only fields meaningful for the card's state (New cards have no
  due / retrievability / last reviewed).
- **Open in Explorer** — a link back to `/explorer` at the card's
  position (its own orientation).
- **`⋯` menu** — per-card actions. **Track** turns on audit capture
  for the card; once tracked the action becomes **Untrack**, which
  removes the card's audit entry (snapshot + events). Track is disabled
  for **New** cards (no FSRS snapshot exists yet) — available only once
  the card has been rated at least once.

Internal/derivable fields (elapsed days, learning steps) are omitted.

## Behavior

- No board interaction and no repertoire- or card-level editing. The
  only mutation is **Track/Untrack** on the audit array, persisted as
  described below.
- **Find position** — a FEN/PGN input at the top (like Explorer's)
  that filters the list to the matching position's card(s).
- **Sort dropdown** over any shown field — due, retrievability,
  stability, difficulty, reps, lapses, last reviewed, state — ascending
  or descending. Default: most overdue first; New cards last.
- New/Learning/Due counts shown as a summary header.
- Empty repertoire → simple empty state.

## Tracking (audit)

**Track** records a card's trajectory for offline inspection. This
replaces the old automatic capture (which triggered on a recall
mistake — an `Again` on a non-New card); that trigger is removed.

- On Track, snapshot the card's current FSRS state, then append every
  later rating event (`Again`/`Good`, with timestamp and source phase)
  for that card going forward. (New cards have no stored card to
  snapshot, so Track is unavailable for them — see above.)
- A tracked card's block lists its captured evaluations inline — each
  `Again`/`Good` with when it happened, in chronological order.
- Reuse the existing audit plumbing (`FSRS-AUDIT.md`): the top-level
  `audit` array on the user blob keyed by `<normalizedFen>::<san>`,
  with the same packed `before` snapshot + append-only `events`. Track
  adds no new storage.
- Capacity is capped (max 10 tracked cards); Track is unavailable once
  full. **Untrack** frees a slot — there's no auto-eviction, but the
  user can always remove an entry (including legacy auto-captured ones)
  to make room, so the cap can't permanently lock Track out.
- The captured evaluations are surfaced on the card (above); the packed
  `audit` blob remains the source of truth for deeper offline analysis.

### Persisting Track/Untrack

Track/Untrack mutate `RepertoireData.audit` and must save the blob —
this is the page's one write path. Reuse the standard DAL save (PUT
with `If-Match` on the cached etag); don't invent a new flow.

- Apply the toggle optimistically.
- **Version conflict (412)** is already handled globally — the DAL
  fires the shared Reload prompt; nothing page-specific is needed.
- **Other save error / offline** — surface an inline error and revert
  the optimistic toggle so the card reflects the persisted state.

### What to remove

The old behavior is replaced, not extended:

- Delete the automatic capture trigger — the audit hook that created a
  new watched entry on an `Again` rating of a non-`New` card. Entry
  creation now happens only via **Track**.
- Keep the audit storage/codec plumbing (`AuditData` model, the
  top-level `audit` blob array + codec packing, and event appending for
  already-tracked cards).
- Delete `docs/product-specs/FSRS-AUDIT.md` and repoint the
  code/comments that referenced it to this spec — its content is now
  fully covered here.
