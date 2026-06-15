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
 * mutations leaking back into the cache. It deliberately does NOT
 * advance `this.etag`: the proxy's etag is locked at construction
 * and only moves forward on a successful save (see below).
 *
 * `storeRepertoireData` is a thin pass-through to `SessionStore.save`:
 * the store fires the global conflict notifier on 412 (driving the
 * app-root `<ConflictModal>`) and throws. Helpers no longer carry
 * their own retry loops — recovery is a hard page reload, owned by
 * the modal.
 *
 * Etag lifecycle (deliberately locked, not auto-refreshed):
 * - Set once at construction from the SessionStore's currently-cached
 *   etag (`createDataAccessProxyLayer`).
 * - Advanced on every successful `storeRepertoireData` to the new
 *   etag returned by the server. This makes multi-save sequences on
 *   the same proxy work without conflict.
 * - NEVER refreshed from the cache mid-life — even if another in-tab
 *   writer (a sibling helper, a background ingest) updates the
 *   SessionStore cache, this proxy keeps its own etag. The next save
 *   will 412 and surface via `ConflictModal` → hard reload.
 *
 * That guarantee is intentional: silently pulling a fresher etag
 * forward on retrieve would let a `retrieve → user-pauses →
 * intervening writer → store` sequence overwrite the intervening
 * writer's changes, bypassing the conflict modal that the design
 * promises is the only 412 recovery path. The codebase's writes are
 * non-idempotent (e.g. `entry.reviewed += stats.reviewed`), so
 * silent merging is unsafe in general.
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
        // Deliberately do NOT advance `this.etag` from the snapshot.
        // See class doc: the proxy's etag is locked at construction
        // and only moves forward on a successful save, so that an
        // intervening in-tab writer is surfaced via the conflict
        // modal rather than silently merged.
        return snapshot.data;
    }

    public async storeRepertoireData(data: RepertoireData, signal?: AbortSignal): Promise<void> {
        const newEtag = await this.store.save(data, this.etag, signal);
        this.etag = newEtag;
    }
}
