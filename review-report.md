# Code Review Report: `feature/landing-page-dashboard`

**Branch:** `feature/landing-page-dashboard` vs `main`
**Scope:** 23 files, +1,503 / −67 lines
**Date:** 2026-05-25
**Reviewers:** 8× Claude Opus 4.6 agents (specialized dimensions) + 1× GPT-5.4 Codex (independent)

---

## Executive Summary

The branch adds a **Dashboard page** for logged-in users, an **ActivityService** for tracking practice history (daily log + lifetime stats + streaks), **time tracking** per traversal with idle detection, **badge row enhancements** (4 animated badges), and **format utilities**. The implementation is well-structured and closely aligned with the product spec (DASHBOARD.md). **No critical bugs** were found. The top concerns are: an **asymmetric warm-up/cool-down counting issue** that biases accuracy low (found only by Codex), a **UTC vs local-time date boundary disagreement** (flagged by 5/9 reviewers), a **UI counter drift** for the today badge, and **missing test coverage** for key business logic.

---

## Findings by Severity

### 🔴 HIGH (4 findings)

| # | Dimension | Finding | Files |
|---|-----------|---------|-------|
| H1 | Data Integrity | ✅ **FIXED — UTC vs local-time day boundary disagreement.** `getCurrentDateOnly()` now uses local time (`setHours`) matching `getTodayDateString()`. `dailyPlayCount` demoted to legacy field (always 0); practice log is single source of truth. | `RepertoireDataUtils.ts:48-57`, `ActivityService.ts:18-24` |
| H2 | Data Integrity | ✅ **FIXED — `reviewedToday` UI counter drifts from persisted `dailyPlayCount`.** Badge now reads from practice log via `getTodayPlayCount()`. Eager increment only fires for correct target cards, matching the reconciled value. `dailyPlayCount` no longer involved. | `TrainingPage.tsx:49,101,117` |
| H3 | Test Coverage | ✅ **FIXED — `ActivityService.test.ts` uses real clock.** Added `vi.useFakeTimers()` pinned to `2026-05-25T12:00:00`. Replaced dynamic `getTodayDateString()` call and manual `new Date()` arithmetic with deterministic `today`/`yesterday` constants. All tests pass. | `ActivityService.test.ts:24-37` |
| H4 | Correctness (Codex) | **Asymmetric warm-up/cool-down counting biases accuracy low.** Correct answers on non-target cards (`step.role !== 'target'`) are excluded from `reviewed`, but wrong answers still increment `mistakes`. With context depth 2, many correct answers vanish from the numerator while mistakes remain — systematically underreporting accuracy. Fix: either count all regular-review moves symmetrically, or exclude both correct and incorrect non-target outcomes. | `TrainingEngine.ts:258-269` |

### 🟡 MEDIUM (15 findings)

| # | Dimension | Finding | Files |
|---|-----------|---------|-------|
| M1 | Correctness | **`ensureActivity` cleanup heuristic runs repeatedly.** The bogus-migration check (`lifetime.traversals === 0 && lifetime.reviewed === 0`) fires on every `ensureActivity()` call, not just once. Should use a migration flag or run-once pattern. | `ActivityService.ts:49-57` |
| M2 | Correctness | ✅ **FIXED — `dailyPlayCount` excludes learned count.** `dailyPlayCount` is now a legacy field (always 0). The today badge is powered by `getTodayPlayCount()` which reads `reviewed` from the practice log — only successful target-card reviews count. | `ActivityService.ts:119` |
| M3 | Duplication | **Card-state classification duplicated.** `computeCardBreakdown()` in DashboardPage reimplements FSRS state categorization using raw numeric literals (`0/1/2/3`) instead of reusing `ReviewQueue`'s logic or the `State` enum. Counts can drift if one is updated without the other. | `DashboardPage.tsx:12-36` vs `ReviewQueue.ts` |
| M4 | Duplication | ✅ **FIXED — Two "today" helpers with different semantics.** `getCurrentDateOnly()` now uses local time, consistent with `getTodayDateString()`. Both use the same timezone strategy. | `ActivityService.ts:18` vs `RepertoireDataUtils.ts:161` |
| M5 | Duplication | ✅ **FIXED — Redundant `ensureActivity()` call.** Removed from `handleTraversalComplete`; `recordTraversal()` handles it internally. | `TrainingPage.tsx:87` |
| M6 | Maintainability | **Business logic in DashboardPage.** `computeCardBreakdown()` and `getAccuracyColor()` belong in a service or utility file, not in a page component. | `DashboardPage.tsx:12-43` |
| M7 | Maintainability | **TrainingEngine has too many responsibilities.** Now handles queue building, path planning, move validation, rating, phase transitions, hints, annotations, stat tracking, timestamp tracking, and elapsed-time calculation. Stats/timing should be extracted. | `TrainingEngine.ts` |
| M8 | Maintainability | **`_setUserMoveTimestamps` test backdoor.** Public `@internal` method on a production class for test injection. Better to use constructor injection or extract time tracking. | `TrainingEngine.ts:~459` |
| M9 | Maintainability | **`cardsRated` overlaps with `_reviewedCount + _mistakeCount + _learnedCount`.** `cardsRated` also counts branch-point ratings. The relationship between these counters is unclear. | `TrainingEngine.ts` |
| M10 | Security/Perf | **Raw backend error text rendered in DOM.** `e.message` from API failures shown directly to users. React escapes XSS, but internal server details could leak. | `DashboardPage.tsx:72-83` |
| M11 | Security/Perf | **`isDue()` closure allocated per card in hot loop.** `computeCardBreakdown` creates a closure for every card. With 1000+ cards, unnecessarily allocates. | `DashboardPage.tsx:20-23` |
| M12 | Data Integrity | **No concurrency guard on rapid traversals.** If two `handleTraversalComplete` calls race, the second's `updatedCards` (FSRS state) overwrites the first's. Activity is safe (shared reference), but card ratings could be lost. | `TrainingPage.tsx:82-102` |
| M13 | Data Integrity | **`bestStreak` limited by 30-entry log window.** A user with a 35-day streak in the past will never see it reflected once entries are evicted. Consider persisting `bestStreak` in lifetime. | `ActivityService.ts:172-197` |
| M14 | Spec Alignment | **Ahead-of-schedule traversals contribute to time tracking.** The spec says only "recall-pass and regular-review moves" contribute timestamps, but ahead-of-schedule moves also add. Minor time inflation in edge cases. | `TrainingEngine.ts` |
| M15 | Data Integrity (Codex) | **Eager empty-day creation can evict real history.** `normalize()` eagerly calls `getTodayEntry()`, creating a zeroed row even if the user never trains. Read-modify-write flows (Settings save) persist these blanks. Empty rows count toward the 30-entry cap, so inactive days gradually push real activity out. | `RepertoireDataUtils.ts:55-57`, `ActivityService.ts:67-84` |

### 🟢 LOW (16 findings)

| # | Dimension | Finding |
|---|-----------|---------|
| L1 | UX | No `:focus-visible` on CTA button — keyboard users can't see focus |
| L2 | UX | No `aria-live` on loading/error, no `aria-hidden` on animation floats |
| L3 | UX | No `prefers-reduced-motion` media query on badge animations |
| L4 | UX | Color-only accuracy indicators (green/yellow/red) — WCAG 1.4.1 concern |
| L5 | UX | Activity feed renders all entries (up to 30) — no pagination |
| L6 | UX | Badge inline styles instead of CSS classes |
| L7 | UX | `dueNow` inflated by large new-card pool (can be alarming to new users) |
| L8 | Correctness | `formatDateHeader` has no input validation — garbage in → garbage out |
| L9 | Correctness | `formatDuration` doesn't guard NaN/negative values |
| L10 | Correctness | `recordTime()` doesn't guard `NaN`/`Infinity` — corrupts state |
| L11 | Maintainability | FSRS state magic numbers (`0,1,2,3`) instead of `State` enum |
| L12 | Maintainability | `catch (e: any)` instead of `catch (e: unknown)` |
| L13 | Maintainability | Hardcoded CSS colors — no CSS custom properties for future theming |
| L14 | Duplication | Three identical `useEffect` hooks for badge decrease animation — extract `useDecreaseAnimation` hook |
| L15 | Duplication | `recordTime()` exported but unused in production code (only tests) |
| L16 | Test Coverage | No component tests for DashboardPage, BadgeRow, or TrainingPage integration |

---

## Test Coverage Assessment

### What's Tested ✅
- `ActivityService`: ensureActivity, getTodayEntry (cap), recordTraversal, recordTime, computeAccuracy, basic streak logic
- `TrainingEngine`: getTraversalStats (learned, reviewed), getTraversalElapsedSeconds (all boundary conditions)
- `FormatUtils`: duration, date header, accuracy formatting
- `RepertoireDataUtils`: normalize with activity, convertToRepertoireData with activity preservation

### What's Missing ❌
- ~~**Fake timers in ActivityService tests**~~ ✅ Fixed — uses `vi.useFakeTimers()` pinned to a deterministic date
- **`computeCardBreakdown()`** — zero tests, embedded in component
- **Streak across month/year boundaries** (relies on JS Date underflow)
- **`computeCurrentStreak` with zero-activity-today** — test description/assertion mismatch
- **`recordTime(NaN)`** — passes guard, corrupts state
- **Component rendering** — no tests for DashboardPage, BadgeRow, or integration flows
- **Teach→recall timestamp reset** interaction with `getTraversalElapsedSeconds`

---

## Spec Alignment Summary

| Spec Section | Status |
|---|---|
| §1.1 Today's Session | ✅ All 6 metrics |
| §1.2 Lifetime Stats | ✅ Complete |
| §1.3 Repertoire Summary | ✅ Complete |
| §1.4 Activity Feed | ✅ Complete (minor label wording differences) |
| §1.5 Call to Action | ✅ Complete |
| §2.1 Practice Log (30-cap) | ✅ Complete |
| §2.2 Lifetime Totals | ✅ Complete |
| §2.3 Time Tracking | ✅ Mostly — ahead-of-schedule edge case |
| §3 Unauthenticated → Landing | ✅ Complete |

---

## Top Recommendations (Priority Order)

1. **Fix asymmetric warm-up/cool-down counting** — either count correct non-target answers in `reviewed`, or exclude non-target mistakes from `mistakes`. Current logic biases accuracy low. *(Codex-only finding)*
2. ~~**Unify date logic**~~ ✅ Done — `getCurrentDateOnly()` switched to local time; `dailyPlayCount` demoted to legacy (always 0).
3. ~~**Fix `reviewedToday` drift**~~ ✅ Done — badge reads from practice log via `getTodayPlayCount()`; eager increment only fires for correct target cards.
4. ~~**Add `vi.useFakeTimers()` to `ActivityService.test.ts`**~~ ✅ Done — pinned to `2026-05-25T12:00:00` with deterministic `today`/`yesterday` constants.
5. **Defer empty-day creation** — only call `getTodayEntry()` when recording actual activity, not in `normalize()`. Strip zero-only rows before persisting. *(Codex-only finding)*
6. **Extract `computeCardBreakdown` to a service** — deduplicate with ReviewQueue's state classification, use `State` enum.
7. **Persist `bestStreak` in lifetime** — so it survives the 30-entry log eviction.
8. **Add accessibility basics** — `:focus-visible`, `aria-live`, `prefers-reduced-motion`.

---

## Independent Review: GPT-5.4 Codex

The Codex agent (GPT-5.4, `--effort xhigh`) independently reviewed the full `main...HEAD` diff, ran all tests (349 passed), and identified **3 substantive issues**:

### Codex Finding 1 — HIGH: Mixed UTC/local day handling ⟵ *Also found by 4 Opus agents* ✅ FIXED
Same as H1 above. `getCurrentDateOnly()` now uses local time. `dailyPlayCount` demoted to legacy field (always 0).

### Codex Finding 2 — HIGH: Asymmetric warm-up/cool-down counting biases accuracy low ⟵ *NEW — missed by all Opus agents*
In `TrainingEngine.ts:258-269`, correct answers on warm-up/cool-down cards (`step.role !== 'target'`) are **not** counted in `reviewed`, but wrong answers **are** counted in `mistakes`. This systematically undercounts the numerator and biases dashboard accuracy low. With the default context depth of 2, many correct answers disappear from stats while mistakes are still recorded. Either count all regular-review user moves symmetrically, or exclude both correct and incorrect non-target outcomes.

**Files:** `TrainingEngine.ts:258-269`, `TrainingPageControl.tsx:271-283`, `ActivityService.ts:106-119`

### Codex Finding 3 — MEDIUM: Eager empty-day creation can evict real history ⟵ *NEW — missed by all Opus agents*
`normalize()` eagerly calls `getTodayEntry()`, which appends a zeroed practice-log row even if the user never trains. Read-modify-write flows (e.g., Settings save) persist these blank rows. Since empty rows still count toward the 30-entry cap, inactive days gradually push real activity out of stored history. Only create the day entry when actual activity is recorded, or strip zero-only rows before storing.

**Files:** `RepertoireDataUtils.ts:55-57`, `ActivityService.ts:67-84`

---

## Reviewer Agreement Matrix

Cross-referencing findings that multiple reviewers independently flagged:

| Finding | Flagged By |
|---------|-----------|
| UTC vs local date disagreement | Correctness, Data Integrity, Duplication, Test Coverage, **Codex** |
| `reviewedToday` UI drift | Data Integrity |
| Missing fake timers in tests | Test Coverage |
| `computeCardBreakdown` duplication | Duplication, Maintainability |
| Business logic in DashboardPage | Maintainability, Duplication |
| TrainingEngine SRP violation | Maintainability |
| Accessibility gaps | UX |
| ensureActivity cleanup heuristic | Correctness, Data Integrity |
| **Asymmetric warm-up/cool-down counting** | **Codex only** |
| **Eager empty-day evicts history** | **Codex only** |

**Consensus:** The branch is well-implemented and spec-aligned. The UTC/local date disagreement is the most cross-cutting concern, flagged by 5 of 9 reviewers independently. The asymmetric counting issue (Codex finding #2) is a genuine accuracy-bias bug that all 8 Opus agents missed — it's the highest-value finding from the independent review. No blockers for merge, but the asymmetric counting and date issues should be addressed before or shortly after.
