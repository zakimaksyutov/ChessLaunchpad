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
    const testData: Record<string, [number, number]> = {
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq': [19, 50],
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq': [18, 48],
        'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': [35, 42],
    };

    it('creates from record and reports correct size', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.size).toBe(3);
    });

    it('looks up by compact FEN', () => {
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

    it('lookupEntry returns cp and depth', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        const entry = evals.lookupEntry('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq');
        expect(entry).toEqual({ cp: 19, depth: 50 });
    });

    it('lookupEntry returns null for unknown position', () => {
        const evals = ExplorerEvals.fromRecord(testData);
        expect(evals.lookupEntry('8/8/8/8/8/8/8/8 w -')).toBeNull();
    });

    it('handles legacy plain-number format (depth defaults to 0)', () => {
        const legacyData: Record<string, number> = {
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq': 19,
        };
        const evals = ExplorerEvals.fromRecord(legacyData);
        expect(evals.lookup('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq')).toBe(19);
        expect(evals.lookupEntry('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq'))
            .toEqual({ cp: 19, depth: 0 });
    });
});
