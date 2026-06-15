import { describe, it, expect, vi } from "vitest";
import { DataAccessProxyLayer } from "./DataAccessProxyLayer";
import { SessionStore } from "./SessionStore";
import { DataAccessError } from "./DataAccessLayer";
import { RepertoireData } from "../models/RepertoireData";

function makeSnapshot(etag: string, label?: string) {
    const data: RepertoireData = {
        repertoires: [],
        fsrsCards: {},
        settings: label !== undefined ? { contextDepth: label.length } : undefined,
        activity: {
            practiceLog: [],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        },
    };
    return { data, etag };
}

/** Fake SessionStore with just the surface DataAccessProxyLayer touches. */
function makeFakeStore(initialEtag: string) {
    let currentSnap = makeSnapshot(initialEtag, "v0");
    const getSnapshot = vi.fn(async () => currentSnap);
    const save = vi.fn(async (data: RepertoireData, etag: string, _signal?: AbortSignal) => {
        if (etag !== currentSnap.etag) {
            throw new DataAccessError("etag mismatch", 412);
        }
        const newEtag = `${etag}-bumped`;
        currentSnap = { data, etag: newEtag };
        return newEtag;
    });
    const fakeStore = {
        getSnapshot,
        save,
        importBlob: vi.fn(),
        createDataAccessProxyLayer: vi.fn(),
        // Inject server-side updates so we can simulate a sibling write.
        __setSnapshot: (snap: { data: RepertoireData; etag: string }) => {
            currentSnap = snap;
        },
    } as unknown as SessionStore & {
        __setSnapshot: (snap: { data: RepertoireData; etag: string }) => void;
    };
    return fakeStore;
}

describe("DataAccessProxyLayer", () => {
    it("returns cached data from the store on retrieve", async () => {
        const store = makeFakeStore("etag-1");
        const proxy = new DataAccessProxyLayer(store, "etag-1");
        const data = await proxy.retrieveRepertoireData();
        expect(data).toBe((await store.getSnapshot()).data);
    });

    it("refreshes its own etag from the cache on every retrieve", async () => {
        const store = makeFakeStore("etag-1");
        const proxy = new DataAccessProxyLayer(store, "etag-stale");
        // Inject newer snapshot (as if a sibling write landed).
        (store as any).__setSnapshot(makeSnapshot("etag-fresh", "v1"));
        await proxy.retrieveRepertoireData();
        // Now a store call should succeed against the freshened etag.
        await proxy.storeRepertoireData((await store.getSnapshot()).data);
        // First save call was made with the fresh etag picked up on retrieve.
        const [, etag] = (store.save as any).mock.calls[0];
        expect(etag).toBe("etag-fresh");
    });

    it("storeRepertoireData passes its etag and updates from the response", async () => {
        const store = makeFakeStore("etag-1");
        const proxy = new DataAccessProxyLayer(store, "etag-1");
        const newData = (await store.getSnapshot()).data;
        await proxy.storeRepertoireData(newData);
        // Subsequent save should use the bumped etag.
        await proxy.storeRepertoireData(newData);
        const [, e1] = (store.save as any).mock.calls[0];
        const [, e2] = (store.save as any).mock.calls[1];
        expect(e1).toBe("etag-1");
        expect(e2).toBe("etag-1-bumped");
    });

    it("storeRepertoireData forwards the AbortSignal to SessionStore.save", async () => {
        const store = makeFakeStore("etag-1");
        const proxy = new DataAccessProxyLayer(store, "etag-1");
        const data = (await store.getSnapshot()).data;
        const controller = new AbortController();
        await proxy.storeRepertoireData(data, controller.signal);
        const [, etag, signal] = (store.save as any).mock.calls[0];
        expect(etag).toBe("etag-1");
        expect(signal).toBe(controller.signal);
    });

    it("throws DataAccessError(412) verbatim from the store and leaves its own etag unchanged", async () => {
        const store = makeFakeStore("etag-1");
        const proxy = new DataAccessProxyLayer(store, "etag-stale-from-other-tab");
        const data = (await store.getSnapshot()).data;
        await expect(proxy.storeRepertoireData(data)).rejects.toMatchObject({
            name: "DataAccessError",
            statusCode: 412,
        });
        // Retrying after a retrieve should now succeed (etag refreshed
        // from the cache).
        await proxy.retrieveRepertoireData();
        await proxy.storeRepertoireData(data);
        expect((store.save as any).mock.calls.length).toBe(2);
    });
});
