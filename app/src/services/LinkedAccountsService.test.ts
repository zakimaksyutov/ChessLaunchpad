import { describe, it, expect, beforeEach } from 'vitest';
import {
    getAccountKey,
    getLinkedAccounts,
    setLinkedAccounts,
    LinkedAccount,
} from './LinkedAccountsService';

describe('LinkedAccountsService', () => {
    beforeEach(() => {
        setLinkedAccounts([]);
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    describe('getAccountKey', () => {
        it('lowercases the username and joins with the platform', () => {
            expect(getAccountKey('lichess', 'Alice')).toBe('lichess:alice');
            expect(getAccountKey('chess.com', 'BobBoB')).toBe('chess.com:bobbob');
        });
    });

    describe('setLinkedAccounts / getLinkedAccounts', () => {
        it('normalizes usernames to lowercase and defaults missing platform to lichess', () => {
            const input: LinkedAccount[] = [
                { platform: 'lichess', username: 'Alice' },
                // @ts-expect-error — exercise the legacy missing-platform path
                { username: 'Bob' },
                { platform: 'chess.com', username: 'CHARLIE' },
            ];
            setLinkedAccounts(input);
            const out = getLinkedAccounts();
            expect(out).toEqual([
                { platform: 'lichess', username: 'alice' },
                { platform: 'lichess', username: 'bob' },
                { platform: 'chess.com', username: 'charlie' },
            ]);
        });

        it('replaces the entire list on each set', () => {
            setLinkedAccounts([{ platform: 'lichess', username: 'alice' }]);
            setLinkedAccounts([{ platform: 'chess.com', username: 'bob' }]);
            expect(getLinkedAccounts()).toEqual([
                { platform: 'chess.com', username: 'bob' },
            ]);
        });

        it('returns an empty array when no accounts are set', () => {
            expect(getLinkedAccounts()).toEqual([]);
        });
    });
});
