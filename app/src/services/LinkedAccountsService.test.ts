import { describe, it, expect, beforeEach } from 'vitest';
import { advanceSyncWatermark, getSyncTimestampKey } from './LinkedAccountsService';

describe('advanceSyncWatermark', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('sets watermark when none exists', () => {
        advanceSyncWatermark('lichess', 'alice', 5000);
        const key = getSyncTimestampKey('lichess', 'alice');
        expect(localStorage.getItem(key)).toBe('5000');
    });

    it('advances watermark when new timestamp is higher', () => {
        const key = getSyncTimestampKey('chess.com', 'bob');
        localStorage.setItem(key, '3000');

        advanceSyncWatermark('chess.com', 'bob', 5000);
        expect(localStorage.getItem(key)).toBe('5000');
    });

    it('does not regress watermark when new timestamp is lower', () => {
        const key = getSyncTimestampKey('lichess', 'alice');
        localStorage.setItem(key, '5000');

        advanceSyncWatermark('lichess', 'alice', 3000);
        expect(localStorage.getItem(key)).toBe('5000');
    });

    it('does not change watermark when timestamps are equal', () => {
        const key = getSyncTimestampKey('lichess', 'alice');
        localStorage.setItem(key, '5000');

        advanceSyncWatermark('lichess', 'alice', 5000);
        expect(localStorage.getItem(key)).toBe('5000');
    });

    it('normalizes username to lowercase', () => {
        advanceSyncWatermark('lichess', 'Alice', 5000);
        const key = getSyncTimestampKey('lichess', 'alice');
        expect(localStorage.getItem(key)).toBe('5000');
    });
});
