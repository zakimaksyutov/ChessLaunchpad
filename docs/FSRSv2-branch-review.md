# 🔍 FSRSv2 Branch — Consolidated Multi-Perspective Review

**Branch:** 32 files changed, +4011/−933 lines, 28 commits
**Reviewers:** 6× Claude Opus 4.6 (specialized dimensions) + 1× GPT-5.4 (independent)
**Tests:** All 343 pass ✅
**Date:** 2026-05-24

---

## 🚨 CRITICAL / HIGH (fix before merge)

### 1. Null assertion crash on missing credentials
**TrainingPage.tsx:27** — `createDataAccessLayer(username!, hashedPassword!)` proceeds even when credentials are null. `setError()` is async and doesn't halt execution.
*Found by: Code Review*

### 2. Shared graph edges are orientation-order-dependent
**RepertoireGraph.ts:84-93** — `GraphEdge` stores one `isUserTurn` flag, but edges can be shared across white/black repertoires. Whichever PGN loads first determines `isUserTurn` for all orientations. `getCardKeys()` can silently drop real user cards.
*Found by: Codex (GPT-5.4)*

### 3. Branch-point validation ignores orientation
**TrainingEngine.ts:268-292** — `handleUserMove()` accepts any `graph.getEdge(currentFen, san)` without filtering by `plan.orientation`. A black traversal could rate a card from a white-only repertoire line, creating orphan FSRS cards.
*Found by: Codex (GPT-5.4)*

### 4. Dynamic interval recomputation causes review flood on upgrade
**FSRSService.ts:260** — `computeInterval()` uses runtime settings (retention=0.97, maxInterval=90), NOT the stored `sd` field. Existing v1 cards scheduled at retention=0.9 get dramatically shorter intervals retroactively. All Review cards become due much sooner on first v2 session.
*Found by: Data Migration*

### 5. `Math.max(...[])` → `-Infinity` on empty variants
**RepertoireDataUtils.ts:138** — If `variants` is empty, produces an invalid `currentEpoch`.
*Found by: Code Review*

### 6. Stale closure on teaching→recall transition
**TrainingPageControl.tsx:296** — `phase` is captured from the render closure; by the time the user acts, React state may have moved on. Board-reset logic for teach→recall could fire at the wrong time.
*Found by: Code Review, React State*

---

## ⚠️ MAJOR (should fix)

### 7. `dailyPlayCount` undercounting
**TrainingPageControl.tsx:236-239** — Only counts `ratingWasCorrect && isTargetCard`. Misses Again ratings, recall-pass ratings, warm-up/cool-down, and branch-point Good reviews. Spec says "per card rated."
*Found by: Spec Alignment, Codex — 3 reviewers flagged this independently*

### 8. Annotations shown during autoplay
**TrainingEngine.ts:335-341, TrainingPageControl.tsx:163-176** — Spec says annotations should NOT appear during autoplay segments. Current code shows them with delay, slowing the root→target path.
*Found by: Spec Alignment, Codex — 2 reviewers flagged*

### 9. Teach/recall replays known prefix moves
**PathPlanner.ts:86-100** — `planTeachRecall()` marks every user-turn step as manual. If only one deep card is new, the user replays all earlier known moves twice (teach + recall). Spec says autoplay to the new cards, then teach/recall only those.
*Found by: Codex (GPT-5.4)*

### 10. Module-level state corrupted on save failure
**SettingsPage.tsx:131-132** — `setContextDepth()`/`setRetention()` mutate module globals *before* the save succeeds. On save failure, module state is wrong until page refresh.
*Found by: React State*

### 11. Unhandled promise rejection in `handleTraversalComplete`
**TrainingPageControl.tsx:308** — Called without `await` from multiple sites. If the save rejects, error is silently swallowed.
*Found by: Code Review*

### 12. Non-deterministic branch selection
**PathPlanner.ts:308** — `Math.random() < 0.5` tiebreak makes traversals non-reproducible and tests non-deterministic.
*Found by: Code Review*

### 13. Module-level state leaks across sessions
**LinkedAccountsService.ts, FSRSService.ts, TrainingEngine.ts** — If a user/repertoire has no `settings` blob, previous in-memory values survive from the prior session. Can write stale settings on save.
*Found by: Codex, React State*

---

## 📋 MODERATE (recommended)

| # | Issue | Source |
|---|-------|--------|
| 14 | Frozen `currentEpoch` breaks v1 rollback recency scoring | Data Migration |
| 15 | PGN edits silently delete FSRS card history for changed positions | Data Migration |
| 16 | `initialFsrsCardsRef` stale when variants+fsrsCards change simultaneously | React State |
| 17 | Orphan timeout on unmount during async save | React State |
| 18 | `setError` side effect inside `useMemo` (anti-pattern for future React) | React State |
| 19 | `allAnnotations` creates new array every render, defeating memo | React State |
| 20 | SettingsPage fragile coupling to `normalize()` side effects for hydration | Code Review |
| 21 | `isDue()` returns true for New cards (confusing API, unused in queue) | Code Review |
| 22 | `isUserTurn` field on shared edges incorrect for multi-orientation | Code Review |
| 23 | No 412 retry logic for ETag conflicts between tabs | Data Migration |

---

## 🧹 DEAD CODE & CLEANUP (~1,300 lines removable)

| Priority | Item | Lines |
|----------|------|-------|
| **A** | Delete `LaunchpadLogic.ts` + test (entirely dead) | ~1,150 |
| **A** | Delete `BadgeRowUtils.ts` + test (orphaned) | ~80 |
| **A** | Remove unused `GraphEdge` import (TrainingEngine.ts:5) | 1 |
| **A** | Remove dead methods: `peekIsNew`, `getCardDataByKey`, 5 graph accessors | ~30 |
| **A** | Drop write-only `TraversalPlan.targetCardKeys` & `isTeachingPlan` | ~10 |
| **B** | Unify duplicated `isUserTurn` logic (TrainingEngine vs PathPlanner) | — |
| **B** | Have `requestHint` reuse `getHintForStep` | — |
| **B** | Extract common retry-loop from `startRegularTraversal`/`startTeachRecall` | — |
| **C** | V1 fields (`currentEpoch`, `errorEMA`, `successEMA`, `WeightSettings`) — plan sunset | ~40 |

---

## 🧪 TEST GAPS

- **Zero direct tests:** `FSRSService.isDue`, `getOverdueness`, `getWeakestCards`, `computeInterval`, `computeDueDate`
- **Missing flows:** wrong-move→retry→correct, multi-card traversals, ahead-of-schedule play-through, branch points
- **Weak tests:** 6 tests use `if` guards that can silently pass without exercising assertions
- **E2E flakiness risks:** pixel-based arrow coords, time-dependent assertions, no drag-failure recovery
- **No integration test** for full queue→plan→rate→save cycle with mixed card states

---

## ✅ WHAT'S WORKING WELL

- **30+ spec features correctly implemented** — core architecture (graph/queue/planner/engine) is solid
- **All 343 tests pass**
- **Callback ref pattern** for `onTraversalComplete` etc. is correct
- **`repertoireDataRef` / state split** correctly avoids engine recreation on saves
- **ETag chain** within single tab is correct (sequential await)
- **API contract compliance** — `fsrsCards` schema, `settings` free-form field
- **LinkedAccounts migration** path is safe
- **Card reconciliation** correctly preserves existing FSRS state

---

## 📊 SPEC DRIFT (intentional, update spec)

| Item | Spec says | Code does | Likely intentional? |
|------|-----------|-----------|---------------------|
| Retention default | 0.9 | 0.97 | ✅ Aligns with autoplay threshold |
| Max interval | 365 | 90 | ✅ Better for chess openings |
| Context depth storage | Local only | Backend sync | ✅ Improvement (roaming) |
| Inter-traversal delay | Immediate | 300ms | ✅ UX (sound plays) |
| Retention/maxInterval settings | Fixed | User-configurable | ✅ Extension |

---

## Cross-Reviewer Consensus

- `dailyPlayCount` was independently flagged by Spec Alignment, Code Review, AND Codex
- Annotations during autoplay flagged by both Spec Alignment and Codex
- Module state issues flagged by both React State and Codex

---

## Full Individual Reports

- **Spec/Code Alignment:** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/spec-alignment.md`
- **Regular Code Review:** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/code-review.md`
- **Dead Code & Unification:** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/dead-code.md`
- **Test Coverage & Quality:** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/test-coverage.md`
- **React State & Race Conditions:** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/react-state.md`
- **Data Migration & API Contract:** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/data-migration.md`
- **Codex Independent Review (GPT-5.4):** `/home/mainuser/.copilot/session-state/35fb7f31-62ef-4687-9931-b4982b855b67/files/codex-review.md`
