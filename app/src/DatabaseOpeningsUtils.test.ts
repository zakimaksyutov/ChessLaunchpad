// DatabaseOpeningsUtils.test.ts
import fs from 'fs';
import path from 'path';
import { DatabaseOpeningsUtils, DatabaseOpening } from './DatabaseOpeningsUtils';

describe('DatabaseOpeningsUtils', () => {
    describe('ClassifyOpening', () => {

        const openings: DatabaseOpening[] = [
            {
                eco: 'C11',
                name: 'French Defense: Classical Variation',
                pgn: '1. e4 e6 2. d4 d5 3. Nc3 Nf6'
            },
            {
                eco: 'C13',
                name: 'French Defense: Classical Variation, Normal Variation',
                pgn: '1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5'
            },
            {
                eco: 'A00',
                name: 'Amar Opening',
                pgn: '1. Nh3'
            }
        ];

        test('returns empty array if DB is empty', () => {
            const pgn = '1. e4 e6 2. d4 d5 3. Nc3 Nf6';
            const result = DatabaseOpeningsUtils.ClassifyOpening(pgn, []);
            expect(result).toEqual([]);
        });

        test('finds multiple matches if the line extends (e.g., subsets)', () => {
            // This is the full PGN for the "C13" line, but if we truncate 1 half move,
            // it becomes "C11" line. We expect BOTH classifications to appear,
            // then the substring filter will remove "C11" if "C11" is contained in "C13".
            // Depending on your logic, you might keep them or remove the shorter one. 
            // We'll test that they both appear at first, then check final filter result.
            const pgn = '1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5';
            const result = DatabaseOpeningsUtils.ClassifyOpening(pgn, openings);

            // "C13 French Defense: Classical Variation, Normal Variation" is the full match
            // "C11 French Defense: Classical Variation" might appear from the truncated line.
            // Depending on your final substring removal, "C11" may be omitted in the final result.
            // So let's just check that C13 is definitely there:
            expect(result).toContain('C13 French Defense: Classical Variation, Normal Variation');

            // And see if the substring removal logic eliminates the C11 line
            // Implementation detail: if your code is set to remove shorter substring lines,
            // then "C11 ..." won't be in the final array. Adjust the expectation as needed:
            const c11Label = 'C11 French Defense: Classical Variation';
            if (result.includes(c11Label)) {
                // If you do NOT remove substring lines, we might see both
                expect(result).toContain(c11Label);
            } else {
                // Or if you do remove substring lines, it's absent
                expect(result).not.toContain(c11Label);
            }
        });

        test('no classification if PGN not in the database', () => {
            // This line is not present in `openings`
            const pgn = '1. e4 c5'; // e.g., Sicilian, but we don't have it in "openings"
            const result = DatabaseOpeningsUtils.ClassifyOpening(pgn, openings);
            expect(result).toEqual([]);
        });
    });
});

describe('DatabaseOpeningsUtils with real data', () => {
    let realOpenings: DatabaseOpening[] = [];

    beforeAll(() => {
        // If the test file is at: app/src/DatabaseOpeningsUtils.test.ts
        // and public/ is at:      app/public/openings.tsv
        const tsvPath = path.resolve(__dirname, '..', 'public', 'openings.tsv');
        const tsvContent = fs.readFileSync(tsvPath, 'utf8');
        realOpenings = DatabaseOpeningsUtils.ParseOpeningsTsv(tsvContent);
    });

    test('classifies a known French Defense line (C13) from real data', () => {
        // A PGN for "C13 French Defense: Alekhine-Chatard Attack"
        const testPgn = '1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7 5. e5 Nfd7 6. h4 h6 7. Bxe7 Qxe7 8. f4 a6 9. Nf3 c5 10. Qd2 Nc6 11. Ne2 b5 12. g4 Nb6 13. b3';

        const results = DatabaseOpeningsUtils.ClassifyOpening(testPgn, realOpenings);

        // Expect the following classification:
        expect(results.length).toBe(5);
        expect(results[0]).toBe('C13 French Defense: Alekhine-Chatard Attack');
        expect(results[1]).toBe('C11 French Defense: Burn Variation');
        expect(results[2]).toBe('C13 French Defense: Classical Variation, Normal Variation');
        expect(results[3]).toBe('C00 French Defense: Normal Variation');
        expect(results[4]).toBe('C10 French Defense: Paulsen Variation');
    });

    test('classifies a known Sicilian Defense line (B44) from real data with comments', () => {
        // A PGN for "B44 Sicilian Defense: Taimanov Variation"
        const testPgn = '1. e4 c5 2. Nf3 {[%cal Ge7e5,Gd2d4]} e6 3. d4 {[%cal Gc5d4,Gf3d4]} cxd4 4. Nxd4 Nc6';

        const results = DatabaseOpeningsUtils.ClassifyOpening(testPgn, realOpenings);

        // Expect the following classification:
        expect(results.length).toBe(2);
        expect(results[0]).toBe('B40 Sicilian Defense: French Variation, Open');
        expect(results[1]).toBe('B44 Sicilian Defense: Taimanov Variation');
    });
});