import { describe, it, expect, beforeEach } from 'vitest';
import { setConflictListener, notifyConflict, __clearConflictListener } from './ConflictNotifier';

describe('ConflictNotifier', () => {
    beforeEach(() => {
        __clearConflictListener();
    });

    it('is a no-op when no listener is installed', () => {
        // Must not throw.
        notifyConflict();
    });

    it('fires the installed listener on notifyConflict', () => {
        let calls = 0;
        setConflictListener(() => { calls++; });
        notifyConflict();
        expect(calls).toBe(1);
        notifyConflict();
        expect(calls).toBe(2);
    });

    it('cleanup returned by setConflictListener clears the slot if same listener still installed', () => {
        let calls = 0;
        const fn = () => { calls++; };
        const cleanup = setConflictListener(fn);
        cleanup();
        notifyConflict();
        expect(calls).toBe(0);
    });

    it('cleanup does not clear the slot if a different listener took over (StrictMode safety)', () => {
        let aCalls = 0;
        let bCalls = 0;
        const a = () => { aCalls++; };
        const b = () => { bCalls++; };
        const cleanupA = setConflictListener(a);
        setConflictListener(b); // listener `b` now wins
        cleanupA(); // must NOT wipe `b`
        notifyConflict();
        expect(aCalls).toBe(0);
        expect(bCalls).toBe(1);
    });
});
