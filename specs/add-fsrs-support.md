# Spec: Add FSRS Support for Autoplay Decisions

## Goal

Integrate [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) to make autoplay decisions during training. The existing custom weight-based variant selection system remains unchanged.

## Scope

- **In scope:** FSRS card state per (FEN, move) pair; autoplay policy using retrievability; persisting cards in the server payload; rating cards after user interaction.
- **Out of scope:** Replacing variant selection logic; move-tree traversal changes; per-user FSRS parameter optimization; freshness rules (future work).

## Key Concept: What Is a Card?

A card represents a **user-turn position and the expected move**: `(normalizedFEN, moveSAN)`.

- Only user-turn positions are tracked (opponent moves are always autoplayed by the system already).
- Transpositions collapse naturally — the same (FEN, move) across different variants shares one card.
- At branching points where the user has multiple valid responses, each response is a separate card.

## Autoplay Policy

A position is **autoplayed** when ALL of:
1. No previous move in this traversal was user-played (autoplay is a **prefix only** — once the user is asked to play, all subsequent moves are user-played too)
2. Card state is `Review` (not `New`, `Learning`, or `Relearning`)
3. Card is **not due** (`now < card.due`)
4. Retrievability `R ≥ 0.97`

Otherwise, the user is asked to play the move. Once autoplay ends, it does not resume for the remainder of that variant traversal.

## FSRS Rating Mapping

After the user is tested on a position:
- **Correct on first attempt** → `Rating.Good`
- **Incorrect (any error), then corrected** → `Rating.Again`

> `Hard` and `Easy` are not used in this initial implementation. They could be exposed later via UI gestures.

## Data Model Changes

### New dependency

```
ts-fsrs (npm)
```

### RepertoireData extension

```typescript
export interface RepertoireData {
    // ... existing fields unchanged ...
    fsrsCards?: Record<string, FSRSCardData>;  // key = "normalizedFEN::moveSAN"
}
```

### FSRSCardData

A JSON-serializable mirror of the `ts-fsrs` `Card` interface, using **minified keys** to match the backend schema:

```typescript
export interface FSRSCardData {
    d: string;              // due — ISO 8601
    s: number;              // stability
    di: number;             // difficulty
    e: number;              // elapsed_days
    sd: number;             // scheduled_days
    ls: number;             // learning_steps
    r: number;              // reps
    l: number;              // lapses
    st: number;             // state — 0=New, 1=Learning, 2=Review, 3=Relearning
    lr?: string;            // last_review — ISO 8601 (optional)
}
```

The client must convert between this wire format and the `ts-fsrs` `Card` type when hydrating/serializing.

### Card key format

```
normalizedFEN::moveSAN
```

Example: `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1::e5`

Use `normalizeFenResetHalfmoveClock()` (already exists in FenUtils) for the FEN part.

## FSRS Configuration

Use shared defaults for all users initially:

```typescript
{
    request_retention: 0.9,
    maximum_interval: 365,
    enable_fuzz: true,
    enable_short_term: true
}
```

These are not user-configurable in this iteration.

## Integration Points

### LaunchpadLogic / TrainingPageControl

When traversing a variant and it's the user's turn:
1. Look up the card for `(currentFEN, expectedMove)`.
2. If no card exists, create a new one (`createEmptyCard` from ts-fsrs).
3. Apply the autoplay policy.
4. If autoplayed — animate the move, skip to next position.
5. If tested — wait for user input, then rate the card (`Good` or `Again`), update FSRS state.

### Persistence

- On round completion (existing `handleCompletion` in TrainingPage), include updated `fsrsCards` in the `RepertoireData` written to the server.
- On load (`retrieveRepertoireData`), hydrate `fsrsCards` — convert ISO date strings back to `Date` objects for ts-fsrs consumption.
- Missing/undefined `fsrsCards` field means no FSRS data yet (backward compatible).

### Normalization

Add to `RepertoireDataUtils.normalize()`:
- If `fsrsCards` is missing, default to `{}`.
- No epoch-based decay or transformation — FSRS manages its own scheduling.

## Backend API Change

**Done.** The backend schema has been updated to accept the optional `fsrsCards` field. See `specs/backend-api-contract.md` (FSRS Card Entry section) for the validated wire format with minified keys.

## Backward Compatibility

- `fsrsCards` is optional on `RepertoireData`. Existing users without it get an empty map and cards are created on first encounter.
- No changes to existing fields (`errorEMA`, `successEMA`, `lastSucceededEpoch`, etc.) — they continue to drive variant selection as before.
- Server API payload grows but the field is additive (no breaking schema change).

## Testing

- Unit tests for card key generation from (FEN, move).
- Unit tests for autoplay decision logic (state, due, retrievability thresholds).
- Unit tests for rating mapping (correct → Good, error → Again).
- Unit tests for hydration/serialization round-trip of FSRSCardData.
- Existing tests must continue to pass unchanged.
