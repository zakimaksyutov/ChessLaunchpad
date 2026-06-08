# FSRS Audit (Temporary)

**Status:** Temporary diagnostic feature. Intended to validate that FSRS
scheduling behaves as expected on real user data. Remove once confidence is
established.

## Goal

Capture the FSRS card state and rating history for a small number of cards
where the user makes a real recall mistake, so the trajectory can be replayed
and inspected offline.

## What triggers a capture

An `Again` rating on a card whose pre-call state is **not** `State.New`.

Rationale: this app rates `Again` once as part of bootstrapping a newly added
move (after which the card is in `Learning`, not `New`), so the "not New"
check filters out the bootstrap and keeps only genuine recall failures.

## What is captured

A top-level array of audit entries on the user blob. Each entry:

- **`k`** — `"<normalizedFen>::<san>"` (no index optimization)
- **`before`** — snapshot of the FSRS card immediately before the triggering
  `Again`, in the same packed array shape used for stored cards
- **`events`** — append-only list of `{ ts, r, s }` rating events for this
  card from the trigger onward, where:
  - `ts` — epoch ms of the rating
  - `r` — rating (Again or Good)
  - `s` — source phase the rating came from (e.g. `warmup`, `cooldown`,
    `review`, `ingest`, `manual` — exact enum to be decided by the
    implementer based on actual call sites)

Both `Again` and `Good` events are appended for watched cards, so the
post-mistake recovery trajectory is visible.

## Capacity

- **Max 10 entries.** Once full, new triggers on unwatched cards are
  silently dropped.
- Existing watched entries continue to accumulate events regardless.
- Entries are **never deleted or evicted**, even if the underlying
  repertoire position is removed.

## Out of scope

- No UI. Inspection is by reading the blob directly.
- No migration. Field is additive; absent on existing blobs.
- No backfill. Only captures events going forward.
