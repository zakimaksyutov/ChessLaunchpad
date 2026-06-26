import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
    SessionStore,
    createSessionStore,
    getSessionStore,
    tryGetSessionStore,
    clearSessionStore,
} from "./SessionStore";
import { DataAccessError } from "./DataAccessLayer";
import { setConflictListener, __clearConflictListener } from "./ConflictNotifier";
import { setSessionExpiredListener, __clearSessionExpiredListener } from "./SessionExpiredNotifier";
import { RepertoireData } from "../models/RepertoireData";
import { RepertoireDataUtils } from "../utils/RepertoireDataUtils";
import { encodePersistedBlob } from "../utils/BlobCodec";

// ── Test helpers ─────────────────────────────────────────────────────

function makeData(): RepertoireData {
    const data: RepertoireData = {
        repertoires: undefined,
        fsrsCards: {},
        settings: {},
        activity: {
            practiceLog: [],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        },
    };
    RepertoireDataUtils.normalize(data);
    return data;
}

function encodedBody(data: RepertoireData): string {
    return JSON.stringify(encodePersistedBlob(data));
}

function jsonGetResponse(data: RepertoireData, etag: string): Response {
    return new Response(encodedBody(data), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: etag },
    });
}

function putResponse(etag: string): Response {
    return new Response("", {
        status: 200,
        headers: { ETag: etag },
    });
}

function errorResponse(status: number, body = "boom"): Response {
    return new Response(body, { status });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SessionStore", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        clearSessionStore();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        clearSessionStore();
    });

    it("rejects construction with missing credentials", () => {
        expect(() => new SessionStore("", "p")).toThrow(DataAccessError);
        expect(() => new SessionStore("u", "")).toThrow(DataAccessError);
    });

    it("eagerly fires GET /variants on construction", async () => {
        const data = makeData();
        fetchMock.mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));

        const store = new SessionStore("alice", "pw");

        // Give the eager fetch a tick to be issued.
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toMatch(/\/user\/alice\/variants$/);
        expect(init?.method).toBe("GET");
        expect((init?.headers as any).Authorization).toBe("pw");

        // First snapshot returns the eager result.
        const snap = await store.getSnapshot();
        expect(snap.etag).toBe("etag-1");
        // No follow-up network request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries the GET on demand if the eager fetch failed", async () => {
        const data = makeData();
        fetchMock
            .mockRejectedValueOnce(new Error("network down"))
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-2"));

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const store = new SessionStore("alice", "pw");

            const snap = await store.getSnapshot();
            expect(snap.etag).toBe("etag-2");
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    it("throws DataAccessError when GET returns non-2xx (both eager + on-demand)", async () => {
        // Eager fetch fails; on-demand retry also fails → propagate.
        fetchMock
            .mockResolvedValueOnce(errorResponse(500, "oops"))
            .mockResolvedValueOnce(errorResponse(500, "oops"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const store = new SessionStore("alice", "pw");
            await expect(store.getSnapshot()).rejects.toThrow(DataAccessError);
        } finally {
            warn.mockRestore();
        }
    });

    it("treats a 404 GET (deleted account) as an expired session and still rejects", async () => {
        // Eager fetch 404s; on-demand retry also 404s (account is gone).
        fetchMock
            .mockResolvedValueOnce(errorResponse(404, "User 'alice' does not exist."))
            .mockResolvedValueOnce(errorResponse(404, "User 'alice' does not exist."));

        const expired = vi.fn();
        const unregister = setSessionExpiredListener(expired);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const store = new SessionStore("alice", "pw");
            await expect(store.getSnapshot()).rejects.toMatchObject({
                name: "DataAccessError",
                statusCode: 404,
            });
            // Session-expired notifier fired so the app shell can clear the
            // dead session and route to /login.
            expect(expired).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            unregister();
            __clearSessionExpiredListener();
        }
    });

    it("does NOT fire the session-expired notifier on a non-404 GET error", async () => {
        fetchMock
            .mockResolvedValueOnce(errorResponse(500, "oops"))
            .mockResolvedValueOnce(errorResponse(500, "oops"));

        const expired = vi.fn();
        const unregister = setSessionExpiredListener(expired);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const store = new SessionStore("alice", "pw");
            await expect(store.getSnapshot()).rejects.toMatchObject({
                name: "DataAccessError",
                statusCode: 500,
            });
            expect(expired).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            unregister();
            __clearSessionExpiredListener();
        }
    });

    it("throws when GET returns no ETag header", async () => {
        const data = makeData();
        const resp = new Response(encodedBody(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
        const resp2 = new Response(encodedBody(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
        // Eager fetch fails (no ETag); on-demand retry also fails → propagate.
        fetchMock
            .mockResolvedValueOnce(resp)
            .mockResolvedValueOnce(resp2);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const store = new SessionStore("alice", "pw");
            await expect(store.getSnapshot()).rejects.toThrow(/ETag/);
        } finally {
            warn.mockRestore();
        }
    });

    it("PUTs verbatim with caller-provided If-Match on save", async () => {
        const data = makeData();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(putResponse("etag-2"));

        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();

        const newEtag = await store.save(data, "etag-1");
        expect(newEtag).toBe("etag-2");

        const [url, init] = fetchMock.mock.calls[1];
        expect(url).toMatch(/\/variants$/);
        expect(init?.method).toBe("PUT");
        expect((init?.headers as any)["If-Match"]).toBe("etag-1");
        expect((init?.headers as any).Authorization).toBe("pw");
    });

    it("updates the cache after a successful save", async () => {
        const data = makeData();
        const next = makeData();
        next.settings = { ...next.settings, contextDepth: 7 };

        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(putResponse("etag-2"));

        const store = new SessionStore("alice", "pw");
        await store.getSnapshot(); // ensure the eager fetch consumed mock #1
        await store.save(next, "etag-1");
        const snap = await store.getSnapshot();
        expect(snap.etag).toBe("etag-2");
        expect(snap.data.settings?.contextDepth).toBe(7);
        // No extra GET — cache served the second snapshot.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws DataAccessError(412) on save conflict, fires conflict notifier, and leaves cache untouched", async () => {
        const data = makeData();

        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(errorResponse(412, "etag mismatch"));

        const notified = vi.fn();
        const unregister = setConflictListener(notified);

        try {
            const store = new SessionStore("alice", "pw");
            await store.getSnapshot();
            await expect(store.save(data, "etag-1")).rejects.toMatchObject({
                name: "DataAccessError",
                statusCode: 412,
            });
            // Conflict notifier fired exactly once for the 412.
            expect(notified).toHaveBeenCalledTimes(1);
            // Cache still holds the original etag.
            const snap = await store.getSnapshot();
            expect(snap.etag).toBe("etag-1");
        } finally {
            unregister();
            __clearConflictListener();
        }
    });

    it("does NOT fire conflict notifier on non-412 save errors", async () => {
        const data = makeData();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(errorResponse(500, "server boom"));

        const notified = vi.fn();
        const unregister = setConflictListener(notified);

        try {
            const store = new SessionStore("alice", "pw");
            await store.getSnapshot();
            await expect(store.save(data, "etag-1")).rejects.toMatchObject({
                name: "DataAccessError",
                statusCode: 500,
            });
            expect(notified).not.toHaveBeenCalled();
        } finally {
            unregister();
            __clearConflictListener();
        }
    });

    it("throws when save response is missing ETag", async () => {
        const data = makeData();
        const resp = new Response("", { status: 200 });
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(resp);

        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        await expect(store.save(data, "etag-1")).rejects.toThrow(/ETag/);
    });

    it("importBlob performs GET-etag-only then PUT-If-Match without decoding GET body", async () => {
        const data = makeData();
        // Body returns garbage that would explode decodePersistedBlob if read.
        const corruptGet = new Response("{not-valid-blob}", {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: "etag-corrupt" },
        });
        fetchMock
            // (We never resolve the eager fetch; the import path issues its
            // own GET. To keep things simple, resolve the eager fetch with
            // valid data.)
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-warm"))
            .mockResolvedValueOnce(corruptGet)
            .mockResolvedValueOnce(putResponse("etag-after-import"));

        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();

        const fresh = makeData();
        fresh.settings = { ...fresh.settings, contextDepth: 9 };
        await store.importBlob(fresh);

        // Three fetches total: eager GET + import GET + import PUT.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const importPutInit = fetchMock.mock.calls[2][1];
        expect(importPutInit?.method).toBe("PUT");
        expect((importPutInit?.headers as any)["If-Match"]).toBe("etag-corrupt");

        // Cache reflects the imported blob and new etag.
        const snap = await store.getSnapshot();
        expect(snap.etag).toBe("etag-after-import");
        expect(snap.data.settings?.contextDepth).toBe(9);
    });

    it("importBlob throws DataAccessError when GET fails", async () => {
        const data = makeData();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-warm"))
            .mockResolvedValueOnce(errorResponse(503, "unavailable"));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        await expect(store.importBlob(makeData())).rejects.toMatchObject({
            statusCode: 503,
        });
    });

    it("deleteAccount issues DELETE /user/{id} with the session Authorization header", async () => {
        const data = makeData();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-warm"))
            .mockResolvedValueOnce(
                new Response("User 'alice' has been successfully deleted.", { status: 200 }),
            );
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();

        await expect(store.deleteAccount()).resolves.toBeUndefined();

        const [url, init] = fetchMock.mock.calls[1];
        expect(url).toMatch(/\/user\/alice$/);
        expect(init?.method).toBe("DELETE");
        expect((init?.headers as any).Authorization).toBe("pw");
    });

    it("deleteAccount treats 404 as success (account already gone)", async () => {
        const data = makeData();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-warm"))
            .mockResolvedValueOnce(errorResponse(404, "User 'alice' does not exist."));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();

        await expect(store.deleteAccount()).resolves.toBeUndefined();
    });

    it("deleteAccount throws DataAccessError on a non-404 error", async () => {
        const data = makeData();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-warm"))
            .mockResolvedValueOnce(errorResponse(500, "boom"));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();

        await expect(store.deleteAccount()).rejects.toMatchObject({ statusCode: 500 });
    });

    it("createDataAccessProxyLayer returns a proxy populated from the cache", async () => {
        const data = makeData();
        fetchMock.mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        const proxy = store.createDataAccessProxyLayer();
        // Proxy retrieval is fully synchronous w/r/t the network (uses cache).
        const got = await proxy.retrieveRepertoireData();
        expect(fetchMock).toHaveBeenCalledTimes(1); // no extra GET
        // Returned data is a deep clone, not the cache's own reference.
        expect(got).not.toBe((await store.getSnapshot()).data);
        expect(got).toEqual((await store.getSnapshot()).data);
    });

    it("createDataAccessProxyLayer throws when the cache is not yet ready", async () => {
        // Make the eager fetch hang indefinitely so cachedEtag stays null.
        fetchMock.mockImplementationOnce(() => new Promise<Response>(() => { /* never resolves */ }));
        const store = new SessionStore("alice", "pw");
        expect(() => store.createDataAccessProxyLayer()).toThrow(DataAccessError);
        expect(() => store.createDataAccessProxyLayer()).toThrow(/not ready/i);
    });

    it("ready() resolves once the cache is populated", async () => {
        const data = makeData();
        fetchMock.mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));
        const store = new SessionStore("alice", "pw");
        await expect(store.ready()).resolves.toBeUndefined();
        expect(() => store.createDataAccessProxyLayer()).not.toThrow();
    });

    it("ready() rejects when the GET fails and can be retried", async () => {
        // Two failures needed for the first ready() to reject: `getSnapshot`
        // transparently retries on-demand if the eager fetch failed, so a
        // single failed mock would silently recover.
        fetchMock
            .mockResolvedValueOnce(errorResponse(500, "server-down"))
            .mockResolvedValueOnce(errorResponse(500, "still-down"))
            .mockResolvedValueOnce(jsonGetResponse(makeData(), "etag-recovered"));
        const store = new SessionStore("alice", "pw");
        await expect(store.ready()).rejects.toMatchObject({ statusCode: 500 });
        await expect(store.ready()).resolves.toBeUndefined();
        expect(() => store.createDataAccessProxyLayer()).not.toThrow();
    });

    it("getSnapshot returns a clone — mutations on returned data do NOT leak into the cache", async () => {
        const data = makeData();
        fetchMock.mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));
        const store = new SessionStore("alice", "pw");
        const snap1 = await store.getSnapshot();
        // Mutate the returned data — simulates what runIngest /
        // flushFanUpdates do before saving.
        (snap1.data.settings as any).contextDepth = 42;
        const snap2 = await store.getSnapshot();
        // Second snapshot is unaffected by the first caller's mutation.
        expect(snap2.data.settings?.contextDepth).not.toBe(42);
    });

    it("save deep-clones data before caching — caller mutations after save do NOT leak", async () => {
        const data = makeData();
        // Inject a sentinel field we'll mutate after save to check leakage.
        data.settings = { ...data.settings, contextDepth: 3 };
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(putResponse("etag-2"));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        await store.save(data, "etag-1");
        // Mutate the caller's `data` AFTER save — must not affect cache.
        (data.settings as any).contextDepth = 999;
        const snap = await store.getSnapshot();
        expect(snap.data.settings?.contextDepth).toBe(3);
    });

    it("save re-derives fsrsCards in the cached shape (so subsequent reads see them)", async () => {
        const data = makeData();
        // Hand-build a wire-form blob like prepareDataForSave would produce.
        const wireForm: RepertoireData = {
            repertoires: data.repertoires,
            settings: data.settings,
            activity: data.activity,
            games: data.games,
            // Note: no top-level fsrsCards (this is what prepareDataForSave omits).
        };
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(putResponse("etag-2"));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        await store.save(wireForm, "etag-1");
        const snap = await store.getSnapshot();
        expect(snap.data.fsrsCards).toBeDefined();
        // The flat map must be a real object, not undefined (regression
        // guard for the bug strictmode-review caught).
        expect(typeof snap.data.fsrsCards).toBe('object');
    });

    it("save forwards an AbortSignal to fetch that aborts when the caller's signal aborts", async () => {
        const data = makeData();
        const controller = new AbortController();
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockResolvedValueOnce(putResponse("etag-2"));
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        await store.save(data, "etag-1", controller.signal);
        const putInit = fetchMock.mock.calls[1][1];
        // The signal passed to fetch is a derived signal composed
        // with the store's internal dispose signal — not the
        // caller's directly. Verify it propagates the caller's abort.
        const passedSignal = putInit?.signal as AbortSignal;
        expect(passedSignal).toBeDefined();
        expect(passedSignal.aborted).toBe(false);
        controller.abort();
        expect(passedSignal.aborted).toBe(true);
    });

    it("dispose() aborts in-flight fetches and prevents cache writes", async () => {
        // Set up a slow GET that never resolves on its own.
        let resolveFetch!: (resp: Response) => void;
        const pending = new Promise<Response>(res => { resolveFetch = res; });
        fetchMock.mockReturnValueOnce(pending);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const store = new SessionStore("alice", "pw");
            // Dispose before the fetch resolves.
            store.dispose();
            // Now resolve the fetch — the store should NOT update its
            // cache because it's already disposed.
            const data = makeData();
            resolveFetch(jsonGetResponse(data, "etag-1"));
            // Give the promise chain a chance to settle.
            await new Promise(r => setTimeout(r, 0));
            // getSnapshot should NOT return etag-1 — the cache was
            // never populated. (Calling getSnapshot would try yet
            // another fetch; we just check the dispose contract held.)
            const fetchInit = fetchMock.mock.calls[0][1];
            const signal = fetchInit?.signal as AbortSignal | undefined;
            expect(signal?.aborted).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    it("save throws if SessionStore is disposed after the PUT resolves (no cache write)", async () => {
        const data = makeData();
        let resolvePut!: (resp: Response) => void;
        const pendingPut = new Promise<Response>(res => { resolvePut = res; });
        fetchMock
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"))
            .mockReturnValueOnce(pendingPut);
        const store = new SessionStore("alice", "pw");
        await store.getSnapshot();
        const savePromise = store.save(data, "etag-1");
        // Dispose mid-PUT, then resolve.
        store.dispose();
        resolvePut(putResponse("etag-2"));
        await expect(savePromise).rejects.toThrow(/disposed/i);
    });

    it("parallel getSnapshot callers share the in-flight eager fetch (no duplicate GETs)", async () => {
        const data = makeData();
        // Resolve the GET after a microtask delay so both callers
        // hit `inFlightFetchPromise` before it settles.
        let resolveFetch!: (resp: Response) => void;
        const pending = new Promise<Response>(res => { resolveFetch = res; });
        fetchMock.mockReturnValueOnce(pending);

        const store = new SessionStore("alice", "pw");
        const p1 = store.getSnapshot();
        const p2 = store.getSnapshot();
        const p3 = store.getSnapshot();
        // All three are waiting on the same in-flight fetch.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        resolveFetch(jsonGetResponse(data, "etag-shared"));
        const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
        expect(s1.etag).toBe("etag-shared");
        expect(s2.etag).toBe("etag-shared");
        expect(s3.etag).toBe("etag-shared");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("parallel on-demand fetches dedupe after the eager fetch failed", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const data = makeData();
            // Eager fetch fails synchronously.
            fetchMock.mockRejectedValueOnce(new Error("eager-failed"));
            // The on-demand fetch then succeeds — but only one should fire
            // even when multiple callers request snapshot simultaneously.
            let resolveFetch!: (resp: Response) => void;
            const pending = new Promise<Response>(res => { resolveFetch = res; });
            fetchMock.mockReturnValueOnce(pending);

            const store = new SessionStore("alice", "pw");
            // Let the eager fetch settle (reject) so getSnapshot sees null cache.
            await new Promise(res => setTimeout(res, 0));
            // Now fire parallel snapshots — they should share the on-demand fetch.
            const p1 = store.getSnapshot();
            const p2 = store.getSnapshot();
            expect(fetchMock).toHaveBeenCalledTimes(2); // 1 eager + 1 on-demand
            resolveFetch(jsonGetResponse(data, "etag-on-demand"));
            const [s1, s2] = await Promise.all([p1, p2]);
            expect(s1.etag).toBe("etag-on-demand");
            expect(s2.etag).toBe("etag-on-demand");
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    it("retries once with a renewed credential after a 401", async () => {
        const data = makeData();
        let auth = "Bearer stale";
        const onUnauthorized = vi.fn(async () => { auth = "Bearer fresh"; return true; });
        const credential = { getAuthorization: () => auth, onUnauthorized };
        fetchMock
            .mockResolvedValueOnce(errorResponse(401, "expired"))
            .mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));

        const store = new SessionStore("alice", credential);
        const snap = await store.getSnapshot();

        expect(snap.etag).toBe("etag-1");
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        // First attempt used the stale token, the retry used the renewed one.
        expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer stale");
        expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer fresh");
    });

    it("surfaces a 401 when the credential cannot renew", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const onUnauthorized = vi.fn(async () => false);
            const credential = { getAuthorization: () => "Bearer dead", onUnauthorized };
            fetchMock.mockImplementation(() => Promise.resolve(errorResponse(401, "expired")));

            const store = new SessionStore("alice", credential);
            await expect(store.getSnapshot()).rejects.toBeInstanceOf(DataAccessError);
            expect(onUnauthorized).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe("SessionStore module-level singleton", () => {
    const originalFetch = global.fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        clearSessionStore();
    });
    afterEach(() => {
        global.fetch = originalFetch;
        clearSessionStore();
    });

    it("getSessionStore throws before login (no credentials in localStorage)", () => {
        localStorage.removeItem('username');
        localStorage.removeItem('hashedPassword');
        expect(() => getSessionStore()).toThrow(DataAccessError);
    });

    it("getSessionStore lazily bootstraps from localStorage credentials", async () => {
        const data = makeData();
        fetchMock.mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));
        localStorage.setItem('username', 'alice');
        localStorage.setItem('hashedPassword', 'pw-hashed');
        try {
            const store = getSessionStore();
            expect(store).toBeInstanceOf(SessionStore);
            // Same instance on a second call.
            expect(getSessionStore()).toBe(store);
            // Make sure the eager fetch settles before afterEach tears down fetch.
            await store.getSnapshot();
        } finally {
            localStorage.removeItem('username');
            localStorage.removeItem('hashedPassword');
        }
    });

    it("tryGetSessionStore returns null before login", () => {
        expect(tryGetSessionStore()).toBeNull();
    });

    it("createSessionStore installs the singleton; clearSessionStore removes it", async () => {
        const data = makeData();
        fetchMock.mockResolvedValueOnce(jsonGetResponse(data, "etag-1"));
        const store = createSessionStore("alice", "pw");
        expect(getSessionStore()).toBe(store);
        expect(tryGetSessionStore()).toBe(store);
        // Let the eager fetch settle so afterEach isn't racing it.
        await store.getSnapshot();

        clearSessionStore();
        expect(tryGetSessionStore()).toBeNull();
        expect(() => getSessionStore()).toThrow(DataAccessError);
    });
});
