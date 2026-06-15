import { RepertoireData } from "../models/RepertoireData";
import { RepertoireDataUtils } from "../utils/RepertoireDataUtils";
import { encodePersistedBlob, decodePersistedBlob } from "../utils/BlobCodec";
import { extractFsrsCardsFromRepertoires } from "../utils/RepertoiresSerde";
import { composeSignals } from "../utils/composeSignals";
import { DataAccessError } from "./DataAccessLayer";
import { DataAccessProxyLayer } from "./DataAccessProxyLayer";

/**
 * Session-scoped, per-user cache of `(RepertoireData, etag)` that sits in
 * front of the backend so pages can share a single warm snapshot across
 * navigations.
 *
 * Lifecycle:
 *   - One instance per logged-in user, constructed via {@link createSessionStore}
 *     and stored at module scope (see {@link getSessionStore}).
 *   - On construction, it eagerly fires `GET /variants` so the first page
 *     after login can pick up the cached snapshot without waiting on a
 *     fresh network round-trip.
 *   - Torn down on logout via {@link clearSessionStore}.
 *
 * Concurrency model:
 *   - `getSnapshot()` returns the current cached `(data, etag)`; if the
 *     initial fetch hasn't completed, it awaits it.
 *   - `save(data, etag)` is an explicit-etag API: caller provides the
 *     etag, the store PUTs verbatim with `If-Match`. On 412 the store
 *     throws `DataAccessError` and the cache is left untouched.
 *   - `importBlob(data)` is the only method that bypasses the cached
 *     etag — see {@link importBlob} for the mandated GET-then-PUT
 *     sequence (the backend always enforces `If-Match`).
 *   - Every successful `save` or `importBlob` updates the cached snapshot
 *     as a side effect, so subsequent {@link getSnapshot} calls see the
 *     new value.
 */
export class SessionStore {
    readonly ApiEndpointUri = "https://chess-prod-function.azurewebsites.net/api/user";

    private cachedData: RepertoireData | null = null;
    private cachedEtag: string | null = null;
    /** Promise held while a GET /variants is in flight, so parallel
     *  `getSnapshot()` callers share the same network round-trip
     *  instead of each firing their own. Cleared after the promise
     *  resolves or rejects. */
    private inFlightFetchPromise: Promise<void> | null = null;
    /**
     * Controller that aborts every in-flight fetch this store has
     * issued. Wired into the eager + on-demand GETs, the import GET,
     * and the save PUT. `dispose()` aborts it so a slow GET from user
     * A whose response comes back after the user logs out (and
     * possibly logs in as user B) can't update the cache and — more
     * importantly — can't run its post-decode `normalize()` side
     * effects (FSRSService / TrainingEngine / setLinkedAccounts
     * module vars) against user A's blob inside user B's session.
     */
    private readonly disposeController = new AbortController();
    private disposed = false;

    constructor(
        private readonly username: string,
        private readonly password: string,
    ) {
        if (!this.username || !this.password) {
            throw new DataAccessError("No valid user session.");
        }
        // Eagerly fetch so the first page after login finds a warm cache.
        // Stash the promise so concurrent `getSnapshot()` callers (e.g.,
        // multiple pages mounting in parallel) reuse it instead of
        // firing duplicate GETs.
        this.inFlightFetchPromise = this.fetchAndPopulate()
            .catch(e => {
                // eslint-disable-next-line no-console
                if (!this.disposed) console.warn("SessionStore: initial fetch failed:", e);
                throw e;
            })
            .finally(() => {
                if (this.inFlightFetchPromise) this.inFlightFetchPromise = null;
            });
        // Swallow the unhandled rejection at this point — `getSnapshot()`
        // will await it (and re-trigger on demand) for real callers.
        this.inFlightFetchPromise.catch(() => {});
    }

    /**
     * Tear down the store: abort any in-flight fetches and mark the
     * instance dead so a late-arriving response can't update the
     * cache. Called by `clearSessionStore()` on logout.
     */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.disposeController.abort();
    }

    /**
     * Return the current cached `(data, etag)`, awaiting any in-flight
     * GET (shared across parallel callers) and triggering one on-demand
     * if the cache is still empty.
     *
     * `data` is a **deep clone** — load-bearing for the retry-on-412
     * loops in `runIngest` and `GameRecordAnalysisPass` that mutate the
     * blob before saving: a 412 retry must start from a clean snapshot.
     *
     * We use `JSON.parse(JSON.stringify(...))` rather than
     * `structuredClone` because Vite's default build target supports
     * older browsers (Safari 14, Firefox 78, Chrome 87) that predate
     * the latter. RepertoireData is purely JSON-serializable so the
     * two are equivalent for our shapes.
     */
    public async getSnapshot(): Promise<{ data: RepertoireData; etag: string }> {
        // Swallow rejections — a transient failure shouldn't permanently
        // break the cache; the on-demand path below retries.
        if (this.inFlightFetchPromise) {
            try { await this.inFlightFetchPromise; } catch { /* fall through */ }
        }
        if (this.cachedData === null || this.cachedEtag === null) {
            if (!this.inFlightFetchPromise) {
                this.inFlightFetchPromise = this.fetchAndPopulate()
                    .finally(() => {
                        if (this.inFlightFetchPromise) this.inFlightFetchPromise = null;
                    });
                this.inFlightFetchPromise.catch(() => {});
            }
            await this.inFlightFetchPromise;
        }
        return {
            data: cloneRepertoireData(this.cachedData!),
            etag: this.cachedEtag!,
        };
    }

    /**
     * PUT `data` with `If-Match: <etag>`. Returns the new etag. On
     * success the cache is updated to `(data, newEtag)`; on 412 throws
     * `DataAccessError(412)` and the cache is left untouched.
     *
     * Optional `signal` is forwarded to the underlying `fetch` so a
     * page-level abort actually cancels the in-flight PUT — the
     * pre-PUT abort check in callers races against React cleanup's
     * deferred `setTimeout(0)` and isn't enough on its own.
     *
     * `data` is typically the result of `prepareDataForSave`, which
     * strips the top-level `fsrsCards` flat map (cards live in
     * `repertoires.positions[*].moves[*].card` in the wire form). We
     * re-derive the flat map on the cached clone so subsequent
     * `getSnapshot()` consumers see the same shape a fresh GET would
     * produce.
     */
    public async save(data: RepertoireData, etag: string, signal?: AbortSignal): Promise<string> {
        const persisted = encodePersistedBlob(data);
        // Compose the caller's signal with our internal dispose signal
        // so a logout mid-PUT aborts the in-flight request.
        const composedSignal = signal
            ? composeSignals(signal, this.disposeController.signal)
            : this.disposeController.signal;
        const response = await fetch(
            `${this.ApiEndpointUri}/${this.username}/variants`,
            {
                method: "PUT",
                headers: {
                    "Authorization": this.password,
                    "Content-Type": "application/json",
                    "If-Match": etag,
                },
                body: JSON.stringify(persisted),
                signal: composedSignal,
            },
        );

        if (!response.ok) {
            const msg = await response.text();
            throw new DataAccessError(msg, response.status);
        }

        const newEtagHeader = response.headers.get("ETag");
        if (!newEtagHeader) {
            throw new DataAccessError("Server did not return an ETag on save.");
        }

        if (this.disposed) {
            // User logged out mid-PUT and the response landed after
            // `clearSessionStore`. Don't poison the next user's session.
            throw new DataAccessError("SessionStore has been disposed.");
        }
        // Deep-clone before caching — helpers like `flushAnUpdates`
        // continue to mutate the saved `data` after the PUT returns
        // (optimistic in-memory `an` updates), and we don't want those
        // post-save mutations leaking into the cache.
        const cached = cloneRepertoireData(data);
        if (cached.fsrsCards === undefined) {
            cached.fsrsCards = extractFsrsCardsFromRepertoires(cached.repertoires ?? []);
        }
        this.cachedData = cached;
        this.cachedEtag = newEtagHeader;
        return newEtagHeader;
    }

    /**
     * Rescue path used by SettingsPage's file Import: replace the stored
     * blob with `data`, even if the existing blob is corrupt or a wire
     * format this client can't decode.
     *
     * The backend always enforces `If-Match`, so we still need to obtain
     * a fresh etag — via a GET whose body we deliberately do **not**
     * decode. Then PUT with that etag.
     *
     * Alternative implementations (PUT with `If-Match: *` or no
     * `If-Match`) are NOT validated against this backend and must not
     * be substituted.
     */
    public async importBlob(data: RepertoireData): Promise<void> {
        const getResponse = await fetch(
            `${this.ApiEndpointUri}/${this.username}/variants`,
            {
                method: "GET",
                headers: { "Authorization": this.password },
                signal: this.disposeController.signal,
            },
        );
        if (!getResponse.ok) {
            const msg = await getResponse.text();
            throw new DataAccessError(msg, getResponse.status);
        }
        const freshEtag = getResponse.headers.get("ETag");
        if (!freshEtag) {
            throw new DataAccessError("Server did not return an ETag on import GET.");
        }
        // `save` updates the cache as a side effect. Discard its etag
        // so callers can't accidentally rely on it (importBlob is `void`).
        await this.save(data, freshEtag);
    }

    /**
     * Resolves once the cache is populated. Throws on fetch failure;
     * callers can re-invoke to retry.
     *
     * Gate that lets {@link createDataAccessProxyLayer} assume
     * `cachedEtag !== null`. Wired into `ProtectedRoute`.
     */
    public async ready(): Promise<void> {
        await this.getSnapshot();
    }

    /**
     * Create a per-page proxy pre-populated with the current cached
     * `(data, etag)`.
     *
     * **Precondition:** `await ready()` first. `ProtectedRoute`
     * enforces this once per page mount, so pages can call this
     * synchronously inside `useMemo`.
     *
     * Throws if the cache is empty. We deliberately do not paper
     * over this with a null-etag fallback inside the proxy — a null
     * etag was a source of subtle "save uses wrong etag" bugs.
     */
    public createDataAccessProxyLayer(): DataAccessProxyLayer {
        if (this.cachedEtag === null) {
            throw new DataAccessError(
                "SessionStore is not ready — await ready() before creating a proxy.",
            );
        }
        return new DataAccessProxyLayer(this, this.cachedEtag);
    }

    /**
     * Force a fresh `GET /variants`, replacing the cached `(data, etag)`
     * with the server's current state. Used by recovery paths that need
     * to surface server-side changes — notably ExplorerPage's "Refresh"
     * button in the post-412 conflict modal, which would otherwise
     * return the same stale snapshot the user just 412'd against.
     *
     * Returns the freshly-fetched snapshot. Throws `DataAccessError`
     * if the GET fails; the cache is left in its prior state on
     * failure (callers can retry).
     *
     * In-flight reads share this fetch (no duplicate GETs).
     */
    public async refresh(): Promise<{ data: RepertoireData; etag: string }> {
        if (!this.inFlightFetchPromise) {
            this.inFlightFetchPromise = this.fetchAndPopulate()
                .finally(() => {
                    if (this.inFlightFetchPromise) this.inFlightFetchPromise = null;
                });
            this.inFlightFetchPromise.catch(() => {});
        }
        await this.inFlightFetchPromise;
        return {
            data: cloneRepertoireData(this.cachedData!),
            etag: this.cachedEtag!,
        };
    }

    // ── Internals ────────────────────────────────────────────────────

    private async fetchAndPopulate(): Promise<void> {
        const response = await fetch(
            `${this.ApiEndpointUri}/${this.username}/variants`,
            {
                method: "GET",
                headers: { "Authorization": this.password },
                signal: this.disposeController.signal,
            },
        );
        if (!response.ok) {
            const msg = await response.text();
            throw new DataAccessError(msg, response.status);
        }
        const etagHeader = response.headers.get("ETag");
        if (!etagHeader) {
            throw new DataAccessError("Server did not return an ETag on GET.");
        }
        const rawData: unknown = await response.json();
        // Bail BEFORE running `normalize` — its post-decode side
        // effects (FSRSService / TrainingEngine / LinkedAccountsService
        // module vars) would otherwise overwrite the next-logged-in
        // user's session with this disposed store's blob.
        if (this.disposed) {
            throw new DataAccessError("SessionStore was disposed during GET.");
        }
        const remoteData: RepertoireData = decodePersistedBlob(rawData);
        RepertoireDataUtils.normalize(remoteData);
        // Re-check after the synchronous decode+normalize in case
        // dispose fired during a yielding microtask — defensive,
        // but cheap.
        if (this.disposed) return;
        this.cachedData = remoteData;
        this.cachedEtag = etagHeader;
    }
}

// JSON round-trip rather than `structuredClone` for older browser
// targets (see `getSnapshot` doc). RepertoireData is purely JSON-
// serializable so the two are equivalent for our shapes.
function cloneRepertoireData(data: RepertoireData): RepertoireData {
    return JSON.parse(JSON.stringify(data));
}

// ── Module-level singleton plumbing ─────────────────────────────────

let currentSessionStore: SessionStore | null = null;

/** Install a new SessionStore as the process-wide singleton, replacing any prior instance. */
export function createSessionStore(username: string, password: string): SessionStore {
    currentSessionStore = new SessionStore(username, password);
    return currentSessionStore;
}

/**
 * Return the current SessionStore, lazily bootstrapping from
 * `localStorage` credentials if needed. Covers the brief window
 * between initial render and App.tsx's `useEffect` constructing
 * the store. Throws if no credentials are present.
 */
export function getSessionStore(): SessionStore {
    if (currentSessionStore) return currentSessionStore;
    const username = localStorage.getItem('username');
    const password = localStorage.getItem('hashedPassword');
    if (!username || !password) {
        throw new DataAccessError("No active session — log in first.");
    }
    currentSessionStore = new SessionStore(username, password);
    return currentSessionStore;
}

/** Return the current SessionStore or `null` if no user is logged in. */
export function tryGetSessionStore(): SessionStore | null {
    return currentSessionStore;
}

/**
 * Tear down the current SessionStore on logout. The `dispose()` call
 * aborts in-flight fetches and blocks their post-decode `normalize()`
 * side effects (FSRSService / TrainingEngine / LinkedAccountsService
 * module vars) from clobbering the next-logged-in user's session.
 */
export function clearSessionStore(): void {
    if (currentSessionStore) {
        currentSessionStore.dispose();
    }
    currentSessionStore = null;
}
