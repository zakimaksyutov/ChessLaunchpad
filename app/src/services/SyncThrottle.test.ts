import { describe, it, expect, beforeEach } from 'vitest';
import {
    SYNC_THROTTLE_MS,
    getLastSyncAt,
    markSyncedNow,
    isSyncThrottled,
} from './SyncThrottle';

describe('SyncThrottle', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('username', 'alice');
    });

    it('returns null / not-throttled when nothing has been stored', () => {
        expect(getLastSyncAt()).toBeNull();
        expect(isSyncThrottled()).toBe(false);
    });

    it('marks and reads back the last sync time', () => {
        const now = 1_000_000;
        markSyncedNow(now);
        expect(getLastSyncAt()).toBe(now);
    });

    it('throttles within the window and releases after it', () => {
        const now = 10_000_000;
        markSyncedNow(now);
        expect(isSyncThrottled(now)).toBe(true);
        expect(isSyncThrottled(now + SYNC_THROTTLE_MS - 1)).toBe(true);
        // Exactly at the window boundary is no longer throttled.
        expect(isSyncThrottled(now + SYNC_THROTTLE_MS)).toBe(false);
        expect(isSyncThrottled(now + SYNC_THROTTLE_MS + 1)).toBe(false);
    });

    it('keys the timestamp per app username (isolated across users)', () => {
        const now = 5_000_000;
        markSyncedNow(now);
        expect(getLastSyncAt()).toBe(now);

        // A different app user logging in on the same browser starts fresh.
        localStorage.setItem('username', 'bob');
        expect(getLastSyncAt()).toBeNull();
        expect(isSyncThrottled(now)).toBe(false);

        // Switching back restores alice's clock.
        localStorage.setItem('username', 'alice');
        expect(getLastSyncAt()).toBe(now);
    });

    it('treats a malformed stored value as never-synced', () => {
        localStorage.setItem('sync:lastAt:alice', 'not-a-number');
        expect(getLastSyncAt()).toBeNull();
        expect(isSyncThrottled()).toBe(false);
    });
});
