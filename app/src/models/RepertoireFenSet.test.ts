import { describe, it, expect } from 'vitest';
import { buildRepertoireFenSets, INITIAL_POSITION_FEN } from './RepertoireFenSet';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';

describe('buildRepertoireFenSets', () => {
    it('does not include the initial position by default', () => {
        const sets = buildRepertoireFenSets([]);
        expect(sets.whiteFens.has(INITIAL_POSITION_FEN)).toBe(false);
        expect(sets.blackFens.has(INITIAL_POSITION_FEN)).toBe(false);
        expect(sets.whiteFens.size).toBe(0);
        expect(sets.blackFens.size).toBe(0);
    });

    it('seeds the initial position into both orientation sets when requested', () => {
        const sets = buildRepertoireFenSets([], { seedInitialPosition: true });
        expect(sets.whiteFens.has(INITIAL_POSITION_FEN)).toBe(true);
        expect(sets.blackFens.has(INITIAL_POSITION_FEN)).toBe(true);
    });

    it('still collects repertoire positions alongside a seeded start', () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const sets = buildRepertoireFenSets(reps, { seedInitialPosition: true });
        expect(sets.whiteFens.has(INITIAL_POSITION_FEN)).toBe(true);
        expect(sets.whiteFens.size).toBeGreaterThan(1);
    });
});
