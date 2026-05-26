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
| H4 | Correctness (Codex) | ✅ **FIXED — Asymmetric warm-up/cool-down counting biased accuracy low.** Non-target mistakes no longer increment `mistakes`. Only target cards contribute to `reviewed`/`mistakes`, making accuracy symmetric. | `TrainingEngine.ts:260-266` |

### 🟡 MEDIUM (15 findings)

| # | Dimension | Finding | Files |
|---|-----------|---------|-------|
| M1 | Correctness | 🔕 **DISMISSED — `ensureActivity` cleanup heuristic runs repeatedly.** Runs on every call but is O(30) max and short-circuits once `lifetime.traversals > 0`. Harmless in practice. | `ActivityService.ts:49-57` |
| M2 | Correctness | ✅ **FIXED — `dailyPlayCount` excludes learned count.** `dailyPlayCount` is now a legacy field (always 0). The today badge is powered by `getTodayPlayCount()` which reads `reviewed` from the practice log — only successful target-card reviews count. | `ActivityService.ts:119` |
| M3 | Duplication | **Card-state classification duplicated.** `computeCardBreakdown()` in DashboardPage reimplements FSRS state categorization using raw numeric literals (`0/1/2/3`) instead of reusing `ReviewQueue`'s logic or the `State` enum. Counts can drift if one is updated without the other. | `DashboardPage.tsx:12-36` vs `ReviewQueue.ts` |
| M4 | Duplication | ✅ **FIXED — Two "today" helpers with different semantics.** `getCurrentDateOnly()` now uses local time, consistent with `getTodayDateString()`. Both use the same timezone strategy. | `ActivityService.ts:18` vs `RepertoireDataUtils.ts:161` |
| M5 | Duplication | ✅ **FIXED — Redundant `ensureActivity()` call.** Removed from `handleTraversalComplete`; `recordTraversal()` handles it internally. | `TrainingPage.tsx:87` |
| M6 | Maintainability | 🔕 **DISMISSED — Business logic in DashboardPage.** `computeCardBreakdown()` and `getAccuracyColor()` are small helpers not reused elsewhere. Code org preference, not a bug. | `DashboardPage.tsx:12-43` |
| M7 | Maintainability | 🔕 **DISMISSED — TrainingEngine has too many responsibilities.** Valid SRP observation but a future refactoring suggestion, not a bug. | `TrainingEngine.ts` |
| M8 | Maintainability | 🔕 **DISMISSED — `_setUserMoveTimestamps` test backdoor.** Common TS testing pattern. Acceptable without a DI framework. | `TrainingEngine.ts:~459` |
| M9 | Maintainability | 🔕 **DISMISSED — `cardsRated` overlaps with other counters.** `cardsRated` intentionally counts all ratings (including branch-point); the other counters track target-only stats. Different purposes, correct behavior. | `TrainingEngine.ts` |
| M10 | Security/Perf | 🔕 **DISMISSED — Raw backend error text rendered in DOM.** React escapes XSS. Leaking internal text is a cosmetic UX concern, not a security issue. | `DashboardPage.tsx:72-83` |
| M11 | Security/Perf | ❌ **FALSE POSITIVE — `isDue()` closure allocated per card.** ~1000 closures is trivial for modern JS engines. Runs once on page load, not in a render loop. No measurable perf impact. | `DashboardPage.tsx:20-23` |
| M12 | Data Integrity | ❌ **FALSE POSITIVE — No concurrency guard on rapid traversals.** The UI flow is inherently sequential — a traversal must complete before the next starts. Concurrent calls to `handleTraversalComplete` cannot happen through normal interaction. | `TrainingPage.tsx:82-102` |
| M13 | Data Integrity | **`bestStreak` limited by 30-entry log window.** A user with a 35-day streak in the past will never see it reflected once entries are evicted. Consider persisting `bestStreak` in lifetime. | `ActivityService.ts:172-197` |
| M14 | Spec Alignment | 🔕 **DISMISSED — Ahead-of-schedule traversals contribute to time tracking.** Confirmed: ahead-of-schedule moves push timestamps. Minor time inflation in a rare edge case; not worth the complexity to fix. | `TrainingEngine.ts` |
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

1. ~~**Fix asymmetric warm-up/cool-down counting**~~ ✅ Done — non-target moves no longer affect `reviewed`/`mistakes`; only target cards contribute to accuracy.
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

### Codex Finding 2 — HIGH: Asymmetric warm-up/cool-down counting biases accuracy low ⟵ *NEW — missed by all Opus agents* ✅ FIXED
In `TrainingEngine.ts:258-269`, correct answers on warm-up/cool-down cards (`step.role !== 'target'`) were **not** counted in `reviewed`, but wrong answers **were** counted in `mistakes`. Fixed by removing non-target mistake counting — only target cards now contribute to `reviewed`/`mistakes`.

**Files:** `TrainingEngine.ts:260-266`

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
