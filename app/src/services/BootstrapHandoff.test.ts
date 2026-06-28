import { describe, it, expect, beforeEach } from 'vitest';
import { setBootstrapHandoff, takeBootstrapHandoff } from './BootstrapHandoff';
import { BootstrapSelection } from './RepertoireBootstrapService';

const sel = (): BootstrapSelection => ({
    white: [{ orientation: 'white', from: 'fen-w', san: 'e4' }],
    black: [{ orientation: 'black', from: 'fen-b', san: 'c5' }],
});

describe('BootstrapHandoff', () => {
    beforeEach(() => {
        // Drain any value a prior test may have left staged.
        takeBootstrapHandoff();
    });

    it('returns null when nothing is staged', () => {
        expect(takeBootstrapHandoff()).toBeNull();
    });

    it('hands the staged selection to a single reader', () => {
        const selection = sel();
        setBootstrapHandoff(selection);
        expect(takeBootstrapHandoff()).toBe(selection);
    });

    it('consumes once — a second read returns null', () => {
        setBootstrapHandoff(sel());
        takeBootstrapHandoff();
        expect(takeBootstrapHandoff()).toBeNull();
    });

    it('keeps only the latest staged selection', () => {
        setBootstrapHandoff(sel());
        const latest = sel();
        setBootstrapHandoff(latest);
        expect(takeBootstrapHandoff()).toBe(latest);
    });
});
