# FSRS Support for Autoplay Decisions

## Overview

[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) drives autoplay decisions during training. Positions the user has mastered (high retrievability, in Review state) are autoplayed at the start of each variant traversal, so training focuses on positions the user actually needs to practice. The existing custom weight-based variant selection system is unchanged.

### Scope

- **Included:** FSRS card state per (FEN, move) pair; autoplay policy using retrievability with lookahead; persisting cards in the server payload; rating cards after user interaction.
- **Not included:** Replacing variant selection logic; move-tree traversal changes; per-user FSRS parameter optimization; freshness rules.

## What Is a Card?

A card represents a **user-turn position and the expected move**: `(normalizedFEN, moveSAN)`.

- Only user-turn positions are tracked (opponent moves are always autoplayed by the system already).
- Transpositions collapse naturally — the same (FEN, move) across different variants shares one card.
- At branching points where the user has multiple valid responses, each response is a separate card.

## Autoplay Policy

A position is **autoplayed** when ALL of the following are true:

1. No previous move in this traversal was user-played (autoplay is a **prefix only** — once the user is asked to play, all subsequent moves are user-played too).
2. **Every** repertoire move at the position satisfies conditions 3–5 (at branch points, all branches must qualify).
3. A card exists for the move.
4. The card state is `Review` (not `New`, `Learning`, or `Relearning`).
5. The card is **not due** (`now < card.due`) and retrievability `R ≥ 0.97`.
6. **Lookahead**: the next user-turn position (reached through all possible opponent responses) also satisfies conditions 2–5. This is a recursive check with a total depth of `contextDepth` user-turn moves (default: 2, meaning the current position + 1 future position). If the variant ends within the lookahead window, that branch passes (there is nothing weak ahead).

If any repertoire move at the position (or at any position within the lookahead window) has no card, or its card fails conditions 4–5, autoplay stops and the user is asked to play. Once autoplay ends, it does not resume for the remainder of that variant traversal.

The lookahead depth is controlled by `contextDepth` on `PathPlanner` (default: 2, configured via `TrainingEngine.setContextDepth()`). A depth of 2 means the user starts playing 1 user-turn move before the first weak card, giving them a warm-up move before the actual challenge.

**Early-move exception:** For the first 2 user-turn moves of a traversal, the lookahead is skipped (depth is reduced to 1). This avoids excessive tree evaluation at the root where the branching factor is highest, and allows mastered opening moves to be autoplayed even when deeper positions are still being learned.

When a position is autoplayed, the move is selected using the existing weighted-probability variant selection system (same as opponent-turn moves).

## FSRS Rating Mapping

After the user plays a move:
- **Correct on first attempt** → `Rating.Good`
- **Incorrect (any error), then corrected** → `Rating.Again`

Error state is tracked per-position in `TrainingEngine.errorFens` and cleared after rating, so if the same FEN appears again later in the traversal it gets a fresh first-attempt assessment.

> `Hard` and `Easy` are not used. They could be exposed later via UI gestures.

## Data Model

### Dependency

```
ts-fsrs ^5.3.2
```

### RepertoireData

```typescript
export interface RepertoireData {
    // ... existing fields unchanged ...
    fsrsCards?: Record<string, FSRSCardData>;  // key = "normalizedFEN::moveSAN"
}
```

### FSRSCardData

A JSON-serializable mirror of the `ts-fsrs` `Card` interface, using **minified keys** to match the backend schema. Defined in `models/FSRSCardData.ts`:

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

`FSRSService` converts between this wire format and the `ts-fsrs` `Card` type via `hydrate()` and `serialize()`.

### Card key format

```
normalizedFEN::moveSAN
```

Example: `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1::e5`

The FEN part uses `normalizeFenResetHalfmoveClock()` from `FenUtils`.

## FSRS Configuration

Defaults configured in `FSRSService`:

```typescript
{
    request_retention: 0.97,
    maximum_interval: 90,
    enable_fuzz: true,
    enable_short_term: true
}
```

`retention` and `maxInterval` are **user-configurable** via the Settings page. Changes are clamped (retention: 0.80–0.99, max interval: 7–365 days) and persisted in the backend `settings` field, so they roam across devices. `contextDepth` (lookahead depth) is also stored in `settings` and synced to backend.

After a traversal completes, there is a **300 ms inter-traversal delay** before the next one begins, allowing the success sound to finish playing.

## Architecture

### FSRSService (`services/FSRSService.ts`)

Wraps ts-fsrs and owns card lifecycle:
- `shouldAutoplay(fen, san, now)` — checks card state, due date, and retrievability against threshold (`R ≥ 0.97`).
- `rateCard(fen, san, correct, now)` — creates a new card if none exists (`createEmptyCard`), then applies `Good` or `Again`.
- `getCards()` — returns the shared cards map (same object reference passed to constructor).
- `getRetrievability(fen, san, now)` — returns current retrievability for a card in Review state, or `null`.

### TrainingEngine (`services/TrainingEngine.ts`)

Orchestrates traversal lifecycle and integrates FSRS with game traversal:
- Owns `errorFens` set — tracks incorrect attempts per-position. Error state is cleared after rating.
- `handleUserMove(san)` — validates the move, rates the FSRS card (`Good` or `Again`), and advances the traversal.
- `getFsrsCards()` — returns the shared cards map for persistence.
- `getContextDepth()` / `setContextDepth(depth)` — static getter/setter for lookahead depth (synced to backend via `settings`).

### PathPlanner (`services/PathPlanner.ts`)

Computes traversal plans from root to target card(s):
- `planTraversal(targetCardKey, dueCardKeys)` — builds a step-by-step plan marking each position as `autoplay`, `warm-up`, `target`, or `cool-down` based on FSRS card state and `contextDepth`.
- `planTeachRecall(newCardKeys)` — builds a teaching plan for new cards.
- Autoplay prefix is determined by card state: positions with Review-state cards at `R ≥ 0.97` and not due are autoplayed; once a weak card is within `contextDepth` user-turn moves, the user takes over.

### TrainingPageControl (`components/TrainingPageControl.tsx`)

Orchestrates autoplay and card rating during a training round:
- Drives the `TrainingEngine` step-by-step: autoplays system moves, waits for user input on user-turn moves, and handles teaching/recall flows.
- `handleMove(orig, dest)` — delegates to `TrainingEngine.handleUserMove()` which rates the FSRS card and advances the plan.
- On traversal completion, saves updated cards and starts the next traversal after a 300 ms delay.

### Persistence

- On traversal completion (`onTraversalComplete` callback), the already-mutated `fsrsCards` from `repertoireData` is included in the `RepertoireData` written to the server. The `fsrsCards` object is shared by reference between `RepertoireData` and `FSRSService`, following the same mutation pattern used for variant stats.
- User-configurable settings (`retention`, `maxInterval`, `contextDepth`) are stored in the backend `settings` field via `RepertoireDataUtils.buildCurrentSettings()` and hydrated on load via `RepertoireDataUtils.normalize()`.
- On load (`retrieveRepertoireData`), `fsrsCards` is stored as-is with minified keys. ISO date strings are converted to `Date` objects lazily by `FSRSService` when cards are accessed, not upfront during normalization.
- Missing/undefined `fsrsCards` field means no FSRS data yet (backward compatible).

### Normalization

`RepertoireDataUtils.normalize()` defaults `fsrsCards` to `{}` if missing. No epoch-based decay or transformation — FSRS manages its own scheduling.

## Backend API

The backend schema accepts the optional `fsrsCards` field. See `docs/BACKEND_API_CONTRACT.md` (FSRS Card Entry section) for the validated wire format with minified keys.

## Backward Compatibility

- `fsrsCards` is optional on `RepertoireData`. Existing users without it get an empty map and cards are created on first encounter.
- No changes to existing fields (`errorEMA`, `successEMA`, `lastSucceededEpoch`, etc.) — they continue to drive variant selection as before.
- Server API payload grows but the field is additive (no breaking schema change).

## Test Coverage

Tests in `services/FSRSService.test.ts`:
- Card key generation from (FEN, move).
- Autoplay decision logic: card state, due date, retrievability threshold.
- Rating mapping: correct → Good, error → Again.
- Hydration/serialization round-trip of FSRSCardData, including optional `last_review`.

Tests in `services/TrainingEngine.test.ts` (FSRS Integration section):
- Autoplay behavior, card rating (Good/Again), error tracking and clearing.
- Context depth effects on warm-up/cool-down steps.
- Branch-point handling, teach/recall flows, ahead-of-schedule detection.

Tests in `services/PathPlanner.test.ts`:
- Plan generation for due cards, new cards, and teach/recall flows.
- Context depth warm-up and cool-down step assignment.
- Autoplay prefix based on card state and retrievability.

Tests in `utils/RepertoireDataUtils.test.ts`:
- `fsrsCards` preserved during normalization, defaulted to `{}` when missing.
- `convertToRepertoireData` includes/defaults `fsrsCards`.

All existing tests continue to pass unchanged.
