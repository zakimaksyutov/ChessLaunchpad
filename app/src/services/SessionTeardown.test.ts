import { describe, it, expect, beforeEach } from 'vitest';
import { clearClientSessionKeys } from './SessionTeardown';
import { persistLichessSession } from '../data/AuthSession';
import { getLastSyncAt, markSyncedNow } from './SyncThrottle';
import { getLinkedAccounts, setLinkedAccounts } from './LinkedAccountsService';

describe('clearClientSessionKeys', () => {
    beforeEach(() => {
        localStorage.clear();
        setLinkedAccounts([]);
    });

    it('clears the auto-sync throttle stamp so a re-login is not wrongly throttled', () => {
        persistLichessSession('zakima', 'ZakiMa', 'jwt-token');
        markSyncedNow(1_000_000);
        expect(getLastSyncAt()).toBe(1_000_000);

        const mode = clearClientSessionKeys();

        expect(mode).toBe('lichess');
        // Throttle key is derived from `username`; it must be gone after teardown.
        expect(localStorage.getItem('username')).toBeNull();
        expect(getLastSyncAt()).toBeNull();
    });

    it('resets the linked-accounts cache and persisted session keys', () => {
        persistLichessSession('zakima', 'ZakiMa', 'jwt-token');
        setLinkedAccounts([{ platform: 'lichess', username: 'ZakiMa' }]);

        clearClientSessionKeys();

        expect(getLinkedAccounts()).toEqual([]);
        expect(localStorage.getItem('lichessJwt')).toBeNull();
        expect(localStorage.getItem('authMode')).toBeNull();
    });
});
