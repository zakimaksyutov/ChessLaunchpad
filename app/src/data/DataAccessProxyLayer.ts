import { RepertoireData } from "../models/RepertoireData";
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
 * in place (`applyIngest`, `flushAnUpdates`) and we don't want those
 * mutations leaking back into the cache.
 *
 * `storeRepertoireData` is a thin pass-through to `SessionStore.save`:
 * the store fires the global conflict notifier on 412 (driving the
 * app-root `<ConflictModal>`) and throws. Helpers no longer carry
 * their own retry loops — recovery is a hard page reload, owned by
 * the modal.
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
        const newEtag = await this.store.save(data, this.etag, signal);
        this.etag = newEtag;
    }
}
