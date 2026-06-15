# DAL Refactor

## Goal

Solve two concrete problems:

1. **Avoid the "sync vs training" 412.** When Dashboard or Games is mid-sync and the user navigates to /training and finishes a traversal, the commit currently fails with a 412 (ETag conflict) and the user sees an error.
2. **Faster page navigation.** Today every page mount triggers its own `GET /variants`. Pages that share the same blob should reuse a cached snapshot instead of refetching.

## Approach

Introduce two layers above the existing `IDataAccessLayer`:

- **`SessionStore`** — a session-scoped singleton that owns the cached `(data, etag)` and exposes an explicit-etag API (caller provides etag on save; 412 throws).
- **`DataAccessProxyLayer`** — a per-page instance, created via `SessionStore.createDataAccessProxyLayer()`, that exposes only the two methods pages and helpers use today (`retrieveRepertoireData` / `storeRepertoireData`). It holds its own etag, copied from the SessionStore at creation, and delegates to the SessionStore on every retrieve/store. Pages see the same shape they use today — etag stays hidden from them.

The "sync vs training" race is avoided by making long-running background writes (`runIngest`, `GameRecordAnalysisPass`, `OpponentAnalysisService`) abortable and cancelling them on Dashboard/Games unmount.

- One `SessionStore` singleton, scoped to the logged-in user. Parameterized by `(username, password)`; torn down on logout. Initiates a `GET /variants` immediately on construction (eager fetch) so the first page after login can pick up the cached snapshot without waiting on a fresh network round-trip.
- Caches `(data, etag)` for the session. `getSnapshot()` returns the cached pair, awaiting the in-flight initial fetch only if called before it completes. The cache is updated on every successful `save` (by any proxy) and on `importBlob`.
- `SessionStore.save` takes the caller-provided `etag` and PUTs verbatim. Returns the new etag from the server. The cache is updated as a side effect. On 412 the store throws `DataAccessError`; the cache is left untouched.
- `importBlob` is the only method that bypasses the cached ETag (rescue path for a corrupt server blob).
- `DataAccessProxyLayer` exposes exactly two methods: `retrieveRepertoireData` and `storeRepertoireData`. On construction it captures `(data, etag)` from `SessionStore.getSnapshot()`. `retrieveRepertoireData()` returns SessionStore's current cached data and updates the proxy's etag (so a retry-loop refetch sees fresh in-tab state). `storeRepertoireData(data)` calls `SessionStore.save(data, this.etag)` and updates `this.etag` from the response. It does not implement the full `IDataAccessLayer` interface — account ops and ETag-bypass remain on the one-shot DAL / SessionStore.importBlob respectively.
- The existing `IDataAccessLayer` interface stays unchanged so tests keep working without changes.
- All long-running background writes started by a page gain an `AbortSignal` and tear themselves down on navigation. This covers `runIngest` (Dashboard + Games), the full `GameRecordAnalysisPass` including its batched flushes, and `OpponentAnalysisService` (long-running per-row analyzer on /games). Each page passes a signal from its `useEffect` cleanup. Re-annotate clear/refresh persists are single fast PUTs and are not separately aborted.

## Surface area

### `SessionStore` — 5 methods

| Method | Used in | Parameters | Returns |
| --- | --- | --- | --- |
| `ready` | `ProtectedRoute` (gate before rendering protected page bodies) | — | `Promise<void>` (resolves once the cache is populated; throws `DataAccessError` on fetch failure) |
| `getSnapshot` | First page after login; internally by every proxy on construction and on retrieve | — | `{ data: RepertoireData, etag: string }` (cached) |
| `save` | Internally by every proxy on store | `data: RepertoireData`, `etag: string` | new `etag: string`; on 412 fires the global conflict notifier (drives the app-root `<ConflictModal>` "Reload" prompt) and throws `DataAccessError` |
| `importBlob` | SettingsPage Import (file replace; ETag bypass) | `data: RepertoireData` | `void` (cache + etag updated as a side effect) |
| `createDataAccessProxyLayer` | Every page on mount (synchronous; requires `ready()` to have resolved) | — | a new `DataAccessProxyLayer` pre-populated with the current cached `(data, etag)`; throws if the cache is not yet populated |

Account lifecycle (`createAccount`, `deleteAccount`) stays on the existing `IDataAccessLayer`; LoginPage and SettingsPage continue to construct a one-shot DAL for those calls.

Note: there is no `refresh()` method. Recovery from any 412 is a hard page reload, owned by the app-root `<ConflictModal>` (see *Conflict handling* below).

#### `importBlob` mechanics

`importBlob` is the only method that bypasses the cached ETag, but it does **not** bypass the server's `If-Match` requirement. The backend enforces `If-Match` on every PUT, so the import-rescue path must obtain a fresh etag from the server — it just can't trust the body the server returns alongside it (the whole point of the rescue path is that the stored blob may be a wire format this client can't decode).

Concretely, `importBlob(data)` performs the same two-step sequence the current `fetchEtagOnly` + `storeRepertoireData` pair performs:

1. `GET /variants` — read the `ETag` response header. **Do not** call `response.json()` / `decodePersistedBlob` on the body (it may be corrupt or a future wire format).
2. `PUT /variants` with `If-Match: <etag from step 1>` and the encoded `data` as the body. Read the new `ETag` from the response.
3. On success, replace the SessionStore's cached `(data, etag)` with `(data, newEtag)` so subsequent proxy reads see the imported blob.

Other implementations (PUT with `If-Match: *`, PUT with no `If-Match`) are **not** validated against this backend and must not be substituted — the server may reject them with 412, leaving the user stranded on the corrupt blob with no other recovery path.

### `DataAccessProxyLayer` — 2 methods

| Method | Behavior |
| --- | --- |
| `retrieveRepertoireData()` | Returns `SessionStore.getSnapshot().data` (cached, no network); refreshes `this.etag` from the snapshot |
| `storeRepertoireData(data)` | Calls `SessionStore.save(data, this.etag)`; updates `this.etag` from the response; on 412 the store fires the conflict notifier and the error propagates verbatim |

Helpers (`GameRecordAnalysisPass`, `runIngest`, etc.) accept the proxy via a narrow type that covers just these two methods (introduced as a new interface or inferred structurally — implementer's choice). The full `IDataAccessLayer` interface keeps its current shape for the one-shot DAL used by account ops.

### Conflict handling — universal modal + hard reload

There is exactly one user-facing recovery path for a 412 conflict, owned at the app root and shared by every write site:

1. `SessionStore.save` catches the 412 response and calls `notifyConflict()` (a tiny module-level pub/sub in `src/data/ConflictNotifier.ts`) *before* throwing `DataAccessError(412)`.
2. `<ConflictModal>` (mounted at app root in `App.tsx`) registers a listener at mount time. When fired it flips `visible` to `true` and renders a single-button "Reload" modal.
3. The only action is `window.location.reload()`. Local in-memory state is discarded; the next bootstrap re-fetches the blob via the eager `GET /variants` in the new SessionStore.

Helpers and pages **do not retry on 412**. Each write is a single attempt:

- `runIngest` / `runIngestInternal` — one GET-compose-PUT pass. On 412 the top-level catch swallows the error and reports `didWrite: false`; the trailing `done` progress emit is also suppressed so Dashboard doesn't flash a "Synced @ HH:MM" badge under the conflict modal. The next Dashboard visit (after the user reloads) re-runs ingest from the fresh blob.
- `flushAnUpdates`, `persistOpponentAnalysis`, `persistReannotateClear`, `persistReannotateRefresh`, `persistDeleteRecordsFromTimestamp` — one GET-mutate-PUT pass. On 412 the error propagates to the caller's existing try/catch; the modal handles user-facing recovery.
- `ExplorerPage.handleSave` — single PUT. On 412 the local catch swallows the error silently (no duplicate "Save failed" banner); the modal owns the reload prompt.

**Silent-catch rule for every 412 caller.** The modal owns the user-facing recovery flow, so any page-level catch that wraps a `SessionStore.save` / `DataAccessProxyLayer.storeRepertoireData` / `SessionStore.importBlob` call must treat `DataAccessError` with `statusCode === 412` as a no-op: no inline error banner, no `alert()`, no console warn. (The local UI-state cleanup that some callers do on hard failure — e.g. clearing a "re-annotate in flight" set — may still run; it's harmless on the imminent reload.) The current call sites that follow this rule are:

- `ExplorerPage.handleSave` — no `setSaveError` on 412.
- `TrainingPage.handleTraversalComplete` — no `setError` on 412.
- `SettingsPage.handleSave` — no `setErrorMessage` on 412.
- `SettingsPage` Import (`handleImportFileSelected`) — no `alert()` on 412 (a blocking native dialog under the modal would be especially bad UX).
- `GamesPage.runAnalysisPass` — no `setAnalysisError` on 412.
- `GamesPage.handleReannotate` / `handleDeleteFromHere` — no `console.warn` on 412.
- `GameIngestService.runIngest` (Dashboard's caller) — no `console.error` on 412; also suppresses the trailing `done` progress emit so Dashboard doesn't flash a "Synced @ HH:MM" badge under the modal.

Don't surface 412 anywhere except through `<ConflictModal>`.

This eliminates the previous per-helper "refetch fresh blob, re-apply local mutation, re-PUT" retry loops, which silently overwrote concurrent same-field writes from other tabs (e.g., `persistOpponentAnalysis` last-write-wins on the `op` field). The new posture matches the "no silent data loss" principle: any 412 surfaces as a visible modal and a fresh page load.

### Proxy lifecycle

The `SessionStore` singleton lives for the whole logged-in session. Proxies are short-lived per-page handles:

1. **Page mount** (e.g., user opens /games) → `useMemo` runs → `SessionStore.createDataAccessProxyLayer()` returns a new proxy, pre-populated with the SessionStore's current cached `(data, etag)`.
2. **Page unmount** (user navigates away) → React drops the component, the proxy reference is dropped, the proxy is garbage-collected. Any in-flight background work using that proxy (`runIngest`, `GameRecordAnalysisPass`, `OpponentAnalysisService.analyzeOpponent`) is aborted via the `useEffect` cleanup signal so it stops before its next PUT.
3. **Page re-mount** (user navigates back) → a **new** proxy is constructed, again pre-populated from the SessionStore's current cache — which may have moved on (e.g., due to a Training commit on the page they visited in between). The fresh proxy starts with the up-to-date etag automatically.

The SessionStore's cache is the warm state that persists across these mount/unmount cycles. Proxies carry an etag snapshot for their page's lifetime; nothing more.

### Readiness gate (non-null etag invariant)

`SessionStore.createDataAccessProxyLayer()` is **synchronous** and requires `cachedEtag !== null`; calling it on an unready store throws `DataAccessError`. The proxy's `etag` field is therefore `string` (not `string | null`) for the proxy's entire lifetime — there is no in-proxy "rehydrate from cache" fallback, which historically masked subtle "save used the wrong etag" bugs.

The gate is enforced by `ProtectedRoute`: before rendering any protected page body, it awaits `SessionStore.ready()` (a `Promise<void>` that resolves once the eager `GET /variants` populates the cache). While the fetch is in flight the route shows a small loading placeholder; on fetch failure it shows an error with a Retry button that triggers a fresh `ready()` await. Pages can then safely call `createDataAccessProxyLayer()` inside `useMemo` without any preflight check.

### Abort signal plumbing

Each page that starts a long-running background write owns one page-scoped `AbortController` (`pageAbortRef`), created at mount and aborted on real unmount. Helpers (`runIngest`, the `GameRecordAnalysisPass.*` persist functions, `OpponentAnalysisService.analyzeOpponentGames`) take a single `signal: AbortSignal` parameter and observe it at their existing checkpoints (between compose and PUT, and inside `fetch` options). Helpers don't need to know about page vs operation distinctions — composition is the caller's concern.

For call sites that need both a page signal and a per-operation signal (the analysis pass aborted by `handleReannotate`, opponent analysis aborted by the row's own controller), combine them at the call site with `AbortSignal.any([pageSignal, opSignal])`. ES2024 `AbortSignal.any` is supported in every browser version the app already targets; if the implementer prefers to avoid it, a 5-line `composeSignals(...signals)` helper that wires `addEventListener('abort')` onto a fresh controller is equivalent and idiomatic. Either way, helpers see a single signal and the test surface (`new AbortController(); pass .signal`) stays identical to today.

**StrictMode caveat.** Calling `pageAbortRef.current.abort()` from a top-level `useEffect` cleanup naively will misfire in dev: React's synthetic mount → unmount → remount cycle fires the cleanup before the remount, so a pass started on first mount gets aborted immediately and looks broken. The existing GamesPage analysis-pass `useEffect` already documents this exact tension (it explicitly skips abort-on-cleanup); the page-lifecycle controller needs equivalent protection. The idiomatic fix is to defer the abort by a tick — cleanup schedules `const t = setTimeout(() => pageAbortRef.current?.abort(), 0)` and stashes the timer id; the next effect run (if any) clears the pending timer with `clearTimeout(t)`. Real unmount → no remount fires → timer fires → controller aborts. Synthetic dev cycle → remount fires first → timer cleared → in-flight work proceeds. Just recreating the controller on every effect run is *not* sufficient — the cleanup still aborts the controller whose signal the in-flight pass is observing.

## How this solves the two goals

**Faster navigation.** First page after login fetches via `SessionStore.getSnapshot()` and populates the cache. Every later page mount constructs a proxy pre-populated from the cache; the first `dal.retrieveRepertoireData()` returns the cached data instantly. The repeated GET on each page mount goes away.

**Sync vs training.** Within one tab:

- Ingest finished before navigation → cache holds post-ingest pair → Training's proxy is pre-populated with it → Training's save uses the current etag → succeeds. ✓
- Ingest still running at navigation → `AbortSignal` cancels it before PUT → no concurrent writer → Training's save uses the cache's etag → succeeds. ✓ Ingest's fetched games are dropped; the next Dashboard visit re-fetches them.
- Ingest's PUT already landed before navigation → cache holds the post-ingest pair → Training reads it → save succeeds. ✓

**Intra-tab concurrent writes** (e.g., analysis pass batch flush + opponent-click handler on /games using the same proxy) follow the same universal modal path: a losing `store` 412 fires `notifyConflict()`, the modal appears, the user reloads. The previous behavior — helpers' internal "refetch fresh blob and re-apply local mutation" retry loops — has been removed because the re-apply step was field-scoped last-write-wins (silently overwriting concurrent same-record writes). The new design trades the now-rare retry-recovery for visible, never-silent loss.

When 412 surfaces (rare — multi-tab race, or an abort that didn't beat an in-flight PUT), the modal handles it identically across every page.

## Out of scope

- **Multi-tab races.** Tab A writes; Tab B's cached etag is stale; Tab B's save throws 412. The app-root `<ConflictModal>` shows; user reloads Tab B.
- **In-store concurrency control beyond proxy-level etag tracking.** No serialized write queue, no `refresh()` method. Recovery from any in-tab or cross-tab race is a hard page reload owned by `<ConflictModal>`.
- Cross-tab coordination (BroadcastChannel), visibility/focus auto-revalidation, subscribe API.

## Migration notes

- **Pages — one-line change.** Replace `useMemo(() => createDataAccessLayer(u, p))` with `useMemo(() => sessionStore.createDataAccessProxyLayer())`. Everything else identical. Pages never see an etag.
- **Helpers — retry loops removed.** `GameRecordAnalysisPass` (`flushAnUpdates`, `persistOpponentAnalysis`, `persistReannotateClear`, `persistReannotateRefresh`, `persistDeleteRecordsFromTimestamp`) and `runIngest` no longer carry per-helper retry-on-412 loops. Each helper is a single GET-mutate-PUT pass; on 412 the underlying `SessionStore.save` fires the universal conflict notifier and rethrows. The previous retry-then-re-apply path was field-scoped last-write-wins (silently overwriting concurrent same-record writes from other tabs); the universal modal-and-reload path replaces it.
- **`runIngest`, `GameRecordAnalysisPass`, and `OpponentAnalysisService.analyzeOpponent`** all gain an `AbortSignal` parameter and bail between their compose / PUT steps if aborted. Dashboard and Games pass a signal from `useEffect` cleanup. `GameRecordAnalysisPass` already has internal abort plumbing (`passAbortRef`) for in-page concerns — extend it to also honor the page-lifecycle signal.
- **`SettingsPage` import** uses `SessionStore.importBlob` directly (single call site; doesn't need to go through a proxy). Replaces today's `dal.fetchEtagOnly()` + `dal.storeRepertoireData()` two-call dance. SettingsPage already follows a successful `importBlob` with `window.location.reload()`.
- **Account ops** (LoginPage signup, SettingsPage delete) keep constructing a one-shot `createDataAccessLayer(u, p)` for `createAccount` / `deleteAccount`.
- **ExplorerPage in-page conflict modal — removed.** The page's old "Refresh / Keep editing" prompt on a save 412 is gone; the app-root `<ConflictModal>` handles 412 universally. ExplorerPage's `handleSave` 412 catch is now silent (no duplicate "Save failed" banner) because the modal already owns the recovery UI.
- **ExplorerPage `visibilitychange` handler — remove.** The existing `useEffect` at the top of `ExplorerPage` that calls `fetchAll(false)` on tab regain becomes a no-op under the new design (the proxy's `retrieveRepertoireData` returns the SessionStore cache; there is no `refresh()`). Delete the effect outright rather than leaving dead code. The behavioral cost is narrow: a Tab B user who leaves Explorer, edits in Tab A, returns to Tab B, and starts a new edit session will see the universal conflict modal on Save instead of getting silently up-to-date state on focus. Multi-tab freshness is explicitly out of scope (see "Out of scope" above).
