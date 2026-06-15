import { RepertoireData } from "../models/RepertoireData";
import { DataAccessError } from "./DataAccessLayer";
import { SessionStore } from "./SessionStore";

/**
 * Narrow store interface used by helpers (`runIngest`, `flushAnUpdates`,
 * etc.) so they can accept either a real `DataAccessProxyLayer` or a
 * test `MockDal` without depending on the full `IDataAccessLayer`.
 *
 * `storeRepertoireData`'s optional `AbortSignal` is forwarded all the
 * way to the underlying `fetch` so a page-level abort cancels the
 * in-flight HTTP request — a pre-PUT abort check in the helper alone
 * isn't enough.
 */
export interface IRepertoireDataStore {
    retrieveRepertoireData(): Promise<RepertoireData>;
    storeRepertoireData(data: RepertoireData, signal?: AbortSignal): Promise<void>;
}

/**
 * Per-page handle that exposes only `retrieveRepertoireData` /
 * `storeRepertoireData` to pages and helpers. Constructed by
 * `SessionStore.createDataAccessProxyLayer()` and dropped on page
 * unmount (no explicit dispose).
 *
 * `retrieveRepertoireData` returns a clone of the SessionStore's
 * cached data — load-bearing because helpers mutate the returned blob
 * in place (`applyIngest`, `flushAnUpdates`), and a 412 retry must
 * not re-read an already-mutated cache.
 *
 * `storeRepertoireData` delegates to `SessionStore.save` and updates
 * the proxy's `etag` from the response. On 412 it calls
 * `SessionStore.refresh()` so the helper's retry loop's next
 * `retrieveRepertoireData` picks up the winning writer's blob;
 * without this the retry just re-PUTs with the same stale etag until
 * exhaustion. The optional `signal` is forwarded all the way to
 * `fetch` — the pre-PUT abort check in the helper isn't enough on
 * its own (it races React cleanup's deferred `setTimeout(0)`).
 *
 * `etag` is non-null for the proxy's whole lifetime: the factory
 * requires a ready SessionStore, and both `save` and `getSnapshot`
 * always return a non-empty etag. Removing the null fallback here
 * eliminated a class of "save used the wrong etag" bugs.
 */
export class DataAccessProxyLayer implements IRepertoireDataStore {
    private etag: string;

    constructor(
        private readonly store: SessionStore,
        initialEtag: string,
    ) {
        this.etag = initialEtag;
    }

    public async retrieveRepertoireData(): Promise<RepertoireData> {
        const snapshot = await this.store.getSnapshot();
        // Refresh from the cache so subsequent stores satisfy `If-Match`
        // after another in-tab writer landed a save.
        this.etag = snapshot.etag;
        return snapshot.data;
    }

    public async storeRepertoireData(data: RepertoireData, signal?: AbortSignal): Promise<void> {
        try {
            const newEtag = await this.store.save(data, this.etag, signal);
            this.etag = newEtag;
        } catch (e) {
            if (e instanceof DataAccessError && e.statusCode === 412) {
                // Cross-tab race: server etag moved without our cache
                // seeing it. Force a refresh so the retry loop's next
                // retrieve picks up the winning blob. Refresh failure
                // is non-fatal — surface the original 412.
                try {
                    await this.store.refresh();
                } catch {
                    /* swallow */
                }
            }
            throw e;
        }
    }
}
