# Backlog

Items here are tracked but not currently scheduled. Move to the appropriate spec or open an issue when picked up.

## FSRS

### Exact due dates when retention hasn't changed

`FSRSService.computeDueDate` currently recomputes the due date from `(lastReview, stability, currentRetention, currentMaxInterval)`. Our standalone formula can't perfectly mirror ts-fsrs's short-term scheduler (which bumps `good_interval ≥ hard_interval + 1` using a hypothetical `hard_stability` we don't store), so the recomputed due date drifts ±1 day from what ts-fsrs originally scheduled — even when the user hasn't touched retention.

**Fix:** stamp each card with the `request_retention` (and optionally `max_interval`) used at scheduling time. When `computeDueDate` sees that stamp matches the current settings, return the stored `card.d` verbatim (exact). Only fall back to the approximate formula when the stamp differs (retention/preset changed). Worst-case approximation window per card is one interval; the next review re-anchors the card to ts-fsrs's authoritative `d`.

**Wire-format option:** only emit the stamp when it differs from the blob's `settings.retention`, so the happy path stays at 10-element packed cards.

### Fuzz is enabled in the scheduler but currently has no effect

`FSRSService` constructs ts-fsrs with `enable_fuzz: true` (overriding the library default of `false`), so ts-fsrs writes a fuzzed value into `card.due` for any Review-state interval ≥ 2.5 days. However, every production reader of due dates goes through `FSRSService.computeDueDate`, which for Review cards recomputes `lastReview + intervalFromStability(...)` — a deterministic, fuzz-free formula — and the stored `card.due` is only consulted as a fallback for New/Learning cards.

Net effect: users see the same deterministic due dates as if fuzz were off, so we pay the (small) cost of seeded randomness with none of the load-smoothing benefit.

Two ways out:
- **(a)** Make fuzz real by adopting the "stamp `request_retention`, return stored `card.due` verbatim when it matches" fix from the **Exact due dates** item above — this restores ts-fsrs's intended load-spreading and also closes the ±1-day drift.
- **(b)** Drop fuzz entirely by passing `enable_fuzz: false`, which also lets the end-to-end snapshot test stop poking the scheduler's private `parameters.enable_fuzz` to disable it.

## Explorer

### Move on board in read mode to navigate

`/explorer`: Move on explorer in read mode on the board to navigate. If a new move / annotation — toast — "Switch to edit mode?".

### Home / Back / Forward navigation

Home, Back, Forward in `/explorer`.

## Dashboard

### Link to /games for activity tiles with non-analyzed games

On dashboard — for activity tiles with non-analyzed games — let's have a link to `/games`.

## Badges

### Position milestone badges

Badges — 10, 100, 1000, 2000, 5000 positions; dedication. Capture from stack overflow.

## Authentication

### Lichess / Chess.com login

Lichess / Chess.com login.
