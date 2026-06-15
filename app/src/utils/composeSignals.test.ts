import { describe, it, expect, vi } from 'vitest';
import { composeSignals } from './composeSignals';

describe('composeSignals', () => {
    it('returns a non-aborted signal when no inputs abort', () => {
        const a = new AbortController();
        const b = new AbortController();
        const s = composeSignals(a.signal, b.signal);
        expect(s.aborted).toBe(false);
    });

    it('starts aborted if any input is already aborted', () => {
        const a = new AbortController();
        const b = new AbortController();
        b.abort('precanceled');
        const s = composeSignals(a.signal, b.signal);
        expect(s.aborted).toBe(true);
        expect(s.reason).toBe('precanceled');
    });

    it('aborts when one of the inputs aborts later', () => {
        const a = new AbortController();
        const b = new AbortController();
        const s = composeSignals(a.signal, b.signal);
        expect(s.aborted).toBe(false);
        a.abort('first-fired');
        expect(s.aborted).toBe(true);
        expect(s.reason).toBe('first-fired');
    });

    it('ignores undefined entries', () => {
        const a = new AbortController();
        const s = composeSignals(undefined, a.signal, undefined);
        expect(s.aborted).toBe(false);
        a.abort();
        expect(s.aborted).toBe(true);
    });

    it('handles all-undefined inputs (returns a never-aborted signal)', () => {
        const s = composeSignals(undefined, undefined);
        expect(s.aborted).toBe(false);
    });

    it('removes listeners on sibling inputs when one input fires (no listener accumulation)', () => {
        const pageSignal = new AbortController();
        // Spy on addEventListener / removeEventListener counts.
        const addSpy = vi.spyOn(pageSignal.signal, 'addEventListener');
        const removeSpy = vi.spyOn(pageSignal.signal, 'removeEventListener');

        // Simulate many per-op signals composed against the same long-lived
        // page signal. Each per-op signal fires before the page signal,
        // so the page signal's listener should be cleaned up each time.
        for (let i = 0; i < 10; i++) {
            const opCtrl = new AbortController();
            composeSignals(opCtrl.signal, pageSignal.signal);
            opCtrl.abort();
        }

        // Without the cleanup, addSpy would have been called 10 times
        // and removeSpy 0 times — leaking 10 listeners. With cleanup,
        // every add has a matching remove.
        expect(addSpy).toHaveBeenCalledTimes(10);
        expect(removeSpy).toHaveBeenCalledTimes(10);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });
});
