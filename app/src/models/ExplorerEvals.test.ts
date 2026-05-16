import { describe, it, expect } from 'vitest';
import { ExplorerEvals, toCompactFen } from './ExplorerEvals';

describe('toCompactFen', () => {
    it('strips a full 6-part FEN to 3 parts', () => {
        const full = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        expect(toCompactFen(full)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq');
    });

    it('strips a 4-part normalized FEN to 3 parts', () => {
        const normalized = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3';
        expect(toCompactFen(normalized)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq');
    });

    it('returns as-is when already 3 parts', () => {
        const compact = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
        expect(toCompactFen(compact)).toBe(compact);
    });
});

describe('ExplorerEvals', () => {
    const testData: Record<string, number[]> = {
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq': [19, 22],
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq': [18],
        'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': [35, 30],
    };

    it('creates from record and reports correct size', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.size).toBe(3);
    });

    it('looks up by compact FEN (returns deepest eval)', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.lookup('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq')).toBe(19);
    });

    it('looks up by full 6-part FEN (strips extra fields)', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        const full = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        expect(evals.lookup(full)).toBe(18);
    });

    it('returns null for unknown position', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.lookup('8/8/8/8/8/8/8/8 w -')).toBeNull();
    });

    it('handles empty dataset', () => {
        const evals = ExplorerEvals.fromRecord({});
        expect(evals.size).toBe(0);
        expect(evals.lookup('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq')).toBeNull();
    });

    it('lookupAll returns full array of evals', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.lookupAll('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq'))
            .toEqual([19, 22]);
    });

    it('lookupAll returns single-element array for positions with one eval', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.lookupAll('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq'))
            .toEqual([18]);
    });

    it('lookupAll returns null for unknown position', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.lookupAll('8/8/8/8/8/8/8/8 w -')).toBeNull();
    });

    it('handles legacy plain-number format (wrapped as single-element array)', () => {
        const legacyData: Record<string, number> = {
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq': 19,
        };
        const evals = ExplorerEvals.fromRecord(legacyData);
        expect(evals.lookup('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq')).toBe(19);
        expect(evals.lookupAll('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq'))
            .toEqual([19]);
    });
});
