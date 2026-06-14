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

### `SessionStore` — 4 methods

| Method | Used in | Parameters | Returns |
| --- | --- | --- | --- |
| `getSnapshot` | First page after login; internally by every proxy on construction and on retrieve | — | `{ data: RepertoireData, etag: string }` (cached) |
| `save` | Internally by every proxy on store | `data: RepertoireData`, `etag: string` | new `etag: string`; throws `DataAccessError` (412) on conflict |
| `importBlob` | SettingsPage Import (file replace; ETag bypass) | `data: RepertoireData` | `void` (cache + etag updated as a side effect) |
| `createDataAccessProxyLayer` | Every page on mount | — | a new `DataAccessProxyLayer` pre-populated with the current cached `(data, etag)` |

Account lifecycle (`createAccount`, `deleteAccount`) stays on the existing `IDataAccessLayer`; LoginPage and SettingsPage continue to construct a one-shot DAL for those calls.

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
| `storeRepertoireData(data)` | Calls `SessionStore.save(data, this.etag)`; updates `this.etag` from the response; throws on 412 |

Helpers (`GameRecordAnalysisPass`, `runIngest`, etc.) accept the proxy via a narrow type that covers just these two methods (introduced as a new interface or inferred structurally — implementer's choice). The full `IDataAccessLayer` interface keeps its current shape for the one-shot DAL used by account ops.

### Proxy lifecycle

The `SessionStore` singleton lives for the whole logged-in session. Proxies are short-lived per-page handles:

1. **Page mount** (e.g., user opens /games) → `useMemo` runs → `SessionStore.createDataAccessProxyLayer()` returns a new proxy, pre-populated with the SessionStore's current cached `(data, etag)`.
2. **Page unmount** (user navigates away) → React drops the component, the proxy reference is dropped, the proxy is garbage-collected. Any in-flight background work using that proxy (`runIngest`, `GameRecordAnalysisPass`, `OpponentAnalysisService.analyzeOpponent`) is aborted via the `useEffect` cleanup signal so it stops before its next PUT.
3. **Page re-mount** (user navigates back) → a **new** proxy is constructed, again pre-populated from the SessionStore's current cache — which may have moved on (e.g., due to a Training commit on the page they visited in between). The fresh proxy starts with the up-to-date etag automatically.

The SessionStore's cache is the warm state that persists across these mount/unmount cycles. Proxies carry an etag snapshot for their page's lifetime; nothing more.

## How this solves the two goals

**Faster navigation.** First page after login fetches via `SessionStore.getSnapshot()` and populates the cache. Every later page mount constructs a proxy pre-populated from the cache; the first `dal.retrieveRepertoireData()` returns the cached data instantly. The repeated GET on each page mount goes away.

**Sync vs training.** Within one tab:

- Ingest finished before navigation → cache holds post-ingest pair → Training's proxy is pre-populated with it → Training's save uses the current etag → succeeds. ✓
- Ingest still running at navigation → `AbortSignal` cancels it before PUT → no concurrent writer → Training's save uses the cache's etag → succeeds. ✓ Ingest's fetched games are dropped; the next Dashboard visit re-fetches them.
- Ingest's PUT already landed before navigation → cache holds the post-ingest pair → Training reads it → save succeeds. ✓

**Intra-tab concurrent writes** (e.g., analysis pass batch flush + opponent-click handler on /games using the same proxy) behave exactly as today: one helper's `store` may 412, the helper's existing retry loop refetches via `proxy.retrieveRepertoireData()` (which returns the now-current SessionStore cache, including the racing write), re-applies, and retries successfully. No silent loss; no user-visible 412.

When 412 does surface to the page (rare — e.g., a multi-tab race or an abort that didn't beat an in-flight PUT), the calling page handles it the same way it does today.

## Out of scope

- **Multi-tab races.** Tab A writes; Tab B's cached etag is stale; Tab B's save throws 412. Calling page handles it the same way it does today. Existing retry loops bound their attempts and stop; the user reloads to recover.
- **In-store concurrency control beyond proxy-level etag tracking.** No serialized write queue, no `refresh()` method. Recovery for in-tab races comes from helpers' existing retry-on-412 loops, which work because the SessionStore cache reflects every in-tab successful save.
- Cross-tab coordination (BroadcastChannel), visibility/focus auto-revalidation, subscribe API.

## Migration notes

- **Pages — one-line change.** Replace `useMemo(() => createDataAccessLayer(u, p))` with `useMemo(() => sessionStore.createDataAccessProxyLayer())`. Everything else identical. Pages never see an etag.
- **Helpers — zero changes.** `GameRecordAnalysisPass.ts` (`flushAnUpdates`, `persistOpponentAnalysis`, `persistReannotateClear`, `persistReannotateRefresh`, `persistDeleteRecordsFromTimestamp`) and `runIngest` keep their existing retry-on-412 loops verbatim. They receive a proxy via the same `IDataAccessLayer` interface.
- **`runIngest`, `GameRecordAnalysisPass`, and `OpponentAnalysisService.analyzeOpponent`** all gain an `AbortSignal` parameter and bail between their compose / PUT steps if aborted. Dashboard and Games pass a signal from `useEffect` cleanup. `GameRecordAnalysisPass` already has internal abort plumbing (`passAbortRef`) for in-page concerns — extend it to also honor the page-lifecycle signal.
- **`SettingsPage` import** uses `SessionStore.importBlob` directly (single call site; doesn't need to go through a proxy). Replaces today's `dal.fetchEtagOnly()` + `dal.storeRepertoireData()` two-call dance.
- **Account ops** (LoginPage signup, SettingsPage delete) keep constructing a one-shot `createDataAccessLayer(u, p)` for `createAccount` / `deleteAccount`.
