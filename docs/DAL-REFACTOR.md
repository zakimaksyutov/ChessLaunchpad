# DAL Refactor

## Goal

Solve two concrete problems:

1. **Avoid the "sync vs training" 412.** When Dashboard or Games is mid-sync and the user navigates to /training and finishes a traversal, the commit currently fails with a 412 (ETag conflict) and the user sees an error.
2. **Faster page navigation.** Today every page mount triggers its own `GET /variants`. Pages that share the same blob should reuse a cached snapshot instead of refetching.

## Approach

Introduce a session-scoped **`SessionStore`** singleton that owns the cached snapshot + ETag. Pages stop constructing their own `DataAccessLayer` instances; they read and write through the store. The store does **no** concurrency magic — it passes through the caller's ETag, and surfaces 412 as an exception. The "sync vs training" race is avoided by making `runIngest` abortable and cancelling it on Dashboard/Games unmount.

- One singleton, scoped to the logged-in user. Parameterized by `(username, password)`; torn down on logout.
- Caches `(data, etag)` for the session. First `getSnapshot` after login fetches; subsequent calls return the cached pair.
- `save` takes the caller-provided `etag` and PUTs verbatim. Returns the new `etag` from the server's response (the caller already has the data they sent, so only the new etag is interesting). The cache is updated to the new `(data, etag)` as a side effect. On 412 the store throws `DataAccessError`; the cache is left untouched.
- `importBlob` is the only method that bypasses the cached ETag (rescue path for a corrupt server blob).
- The existing `IDataAccessLayer` stays as the transport so tests can keep injecting a fake.
- `runIngest` gains an `AbortSignal`. Dashboard and Games pass a signal from their `useEffect` cleanup so navigation aborts the in-flight sync before its PUT lands — this is how the "sync vs training" 412 is prevented in practice.

## Surface area

3 methods total. (Account lifecycle — `createAccount`, `deleteAccount` — stays on the existing `IDataAccessLayer`; LoginPage and SettingsPage continue to construct a one-shot DAL for those calls, as they do today.)

| Method | Used in | Parameters | Returns |
| --- | --- | --- | --- |
| `getSnapshot` | Every page on mount | — | `{ data: RepertoireData, etag: string }` (cached) |
| `save` | Every write site (Training commit, Settings save, Explorer save, ingest pipeline, all GamesPage record edits) | `data: RepertoireData`, `etag: string` | new `etag: string` (cache + etag also updated as a side effect); throws `DataAccessError` (412) on conflict |
| `importBlob` | SettingsPage Import (file replace; ETag bypass) | `data: RepertoireData` | `void` (cache + etag updated as a side effect) |

## How this solves the two goals

**Faster navigation.** Every page mount calls `store.getSnapshot()`. The first call after login fetches; every subsequent call across page navigation is a cache hit. The repeated GET on each page mount goes away.

**Sync vs training.** Within one tab:

- Ingest finished before navigation → cache already has the new data + etag → Training reads it → Training's save uses the current etag → succeeds. ✓
- Ingest still running at navigation → `AbortSignal` cancels it before PUT → no concurrent writer → Training's save uses the cache's etag → succeeds. ✓ Ingest's fetched games are dropped; the next Dashboard visit re-fetches them.
- Ingest's PUT already landed before navigation → cache holds the post-ingest pair → Training reads it → save succeeds. ✓

The cancellation contract makes 412 vanishingly rare in normal use. When 412 does occur (e.g., a multi-tab race, or an abort that didn't beat an in-flight PUT), `save` throws and the calling page handles it the same way it does today.

## Out of scope

- **Multi-tab races.** Tab A writes; Tab B's cached etag is stale; Tab B's save throws 412. Calling page handles it the same way it does today.
- **In-store retry / queueing / ETag rewriting.** The store does not attempt to recover from 412 on the caller's behalf. The caller's etag is passed through verbatim.
- Cross-tab coordination (BroadcastChannel), visibility/focus auto-revalidation, subscribe API. Pages keep using local React state seeded from `getSnapshot` / `save` return values.

## Migration notes

- Replace each page's `useMemo(() => createDataAccessLayer(...))` with access to the shared `SessionStore`.
- Replace `dal.retrieveRepertoireData()` with `store.getSnapshot()` and `dal.storeRepertoireData(blob)` with `store.save(blob, etag)`. Pages must thread the etag through their local React state alongside the data (today they don't track etag at all — the DAL hides it).
- `GameRecordAnalysisPass.ts`'s per-write 412-retry loops (`flushAnUpdates`, `persistOpponentAnalysis`, `persistReannotateClear`, `persistReannotateRefresh`, `persistDeleteRecordsFromTimestamp`) keep their refetch-and-retry shape — but `refetch` now goes through `store.getSnapshot()` (or a `store.refresh()` if added) instead of `dal.retrieveRepertoireData()`, so they share the cache too.
- `runIngest` gains an `AbortSignal` parameter and bails between its compose / PUT steps if aborted. Dashboard and Games pass a signal from `useEffect` cleanup.
- `SettingsPage`'s import path keeps using `importBlob` for the ETag-bypass rescue behavior.
