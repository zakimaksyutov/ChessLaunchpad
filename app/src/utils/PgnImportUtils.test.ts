import { Chess } from 'chess.js';
import { parsePgnWithVariations, tokenizePgn } from './PgnImportUtils';

describe('PgnImportUtils', () => {
    describe('tokenizePgn', () => {
        it('tokenizes a simple PGN', () => {
            const tokens = tokenizePgn('1. e4 e5 2. Nf3');
            expect(tokens).toEqual(['1.', 'e4', 'e5', '2.', 'Nf3']);
        });

        it('tokenizes PGN with parenthesized variations', () => {
            const tokens = tokenizePgn('1. e4 (1. d4 d5) 1... e5');
            expect(tokens).toEqual([
                '1.', 'e4', '(', '1.', 'd4', 'd5', ')', '1...', 'e5',
            ]);
        });

        it('strips brace comments', () => {
            const tokens = tokenizePgn('1. e4 {best move} e5');
            expect(tokens).toEqual(['1.', 'e4', 'e5']);
        });

        it('strips NAGs', () => {
            const tokens = tokenizePgn('1. e4 $1 e5 $2');
            expect(tokens).toEqual(['1.', 'e4', 'e5']);
        });

        it('strips semicolon comments', () => {
            const tokens = tokenizePgn('1. e4 e5 ; this is a comment\n2. Nf3');
            expect(tokens).toEqual(['1.', 'e4', 'e5', '2.', 'Nf3']);
        });
    });

    describe('parsePgnWithVariations', () => {
        it('parses a simple PGN without variations', () => {
            const result = parsePgnWithVariations('1. e4 e5 2. Nf3 Nc6');

            const chess = new Chess();
            chess.loadPgn('1. e4 e5 2. Nf3 Nc6');
            expect(result.mainLinePgn).toBe(chess.pgn());
            expect(result.subvariantArrows.size).toBe(0);
        });

        it('parses the user example PGN with one variation', () => {
            const pgn =
                '1. c4 Nf6 2. Nc3 g6 3. g3 Bg7 4. Bg2 O-O 5. e4 d6 6. Nge2 c5 ' +
                '7. O-O Nc6 8. d3 Rb8 9. h3 a6 10. a4 Ne8 11. Be3 b5 12. cxb5 axb5 ' +
                '13. axb5 (13. Nxb5 Nc7 14. Nxc7 Qxc7) 13... Nd4';

            const result = parsePgnWithVariations(pgn);

            // Main line should end with Nd4 and NOT contain Nxb5
            expect(result.mainLinePgn).toContain('Nd4');
            expect(result.mainLinePgn).not.toContain('Nxb5');

            // Should have exactly one branch point
            expect(result.subvariantArrows.size).toBe(1);

            // Compute the branch FEN (after 12...axb5)
            const chess = new Chess();
            chess.loadPgn(
                '1. c4 Nf6 2. Nc3 g6 3. g3 Bg7 4. Bg2 O-O 5. e4 d6 6. Nge2 c5 ' +
                '7. O-O Nc6 8. d3 Rb8 9. h3 a6 10. a4 Ne8 11. Be3 b5 12. cxb5 axb5'
            );
            const branchFen = chess.fen();

            const arrows = result.subvariantArrows.get(branchFen)!;
            expect(arrows).toBeDefined();
            expect(arrows).toHaveLength(4);

            // Pair 1 (green): Nxb5 (c3→b5), Nc7 (e8→c7)
            expect(arrows[0]).toEqual({ brush: 'G', orig: 'c3', dest: 'b5' });
            expect(arrows[1]).toEqual({ brush: 'G', orig: 'e8', dest: 'c7' });

            // Pair 2 (red): Nxc7 (b5→c7), Qxc7 (d8→c7)
            expect(arrows[2]).toEqual({ brush: 'R', orig: 'b5', dest: 'c7' });
            expect(arrows[3]).toEqual({ brush: 'R', orig: 'd8', dest: 'c7' });
        });

        it('ignores sub-sub-variants (depth >= 2)', () => {
            const pgn = '1. e4 e5 (1... d5 (1... c5 2. Nf3) 2. exd5) 2. Nf3';
            const result = parsePgnWithVariations(pgn);

            expect(result.subvariantArrows.size).toBe(1);
            const branchFen = new Chess('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').fen();
            const arrows = result.subvariantArrows.get(branchFen)!;
            expect(arrows).toBeDefined();

            // Only d5 and exd5 from the first-level variation (1...d5 2. exd5)
            // 1...c5 2. Nf3 is depth 2, ignored
            expect(arrows[0]).toEqual({ brush: 'G', orig: 'd7', dest: 'd5' });
            expect(arrows[1]).toEqual({ brush: 'G', orig: 'e4', dest: 'd5' });
        });

        it('uses only the first variation per branch position', () => {
            const pgn = '1. e4 (1. d4) (1. c4) 1... e5';
            const result = parsePgnWithVariations(pgn);

            expect(result.subvariantArrows.size).toBe(1);
            const startFen = new Chess().fen();
            const arrows = result.subvariantArrows.get(startFen)!;
            expect(arrows).toBeDefined();
            expect(arrows).toHaveLength(1);

            // Should be d4, not c4
            expect(arrows[0]).toEqual({ brush: 'G', orig: 'd2', dest: 'd4' });
        });

        it('handles variations at different positions', () => {
            const pgn = '1. e4 (1. d4) 1... e5 (1... c5) 2. Nf3';
            const result = parsePgnWithVariations(pgn);

            expect(result.subvariantArrows.size).toBe(2);

            // Variation after starting position: 1. d4
            const startFen = new Chess().fen();
            const arrows1 = result.subvariantArrows.get(startFen)!;
            expect(arrows1).toHaveLength(1);
            expect(arrows1[0]).toEqual({ brush: 'G', orig: 'd2', dest: 'd4' });

            // Variation after 1. e4: 1...c5
            const afterE4 = new Chess('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').fen();
            const arrows2 = result.subvariantArrows.get(afterE4)!;
            expect(arrows2).toHaveLength(1);
            expect(arrows2[0]).toEqual({ brush: 'G', orig: 'c7', dest: 'c5' });
        });

        it('caps arrows at 4 pairs (8 half-moves)', () => {
            // A variation with more than 8 half-moves
            const pgn = '1. e4 (1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3) 1... e5';
            const result = parsePgnWithVariations(pgn);

            const startFen = new Chess().fen();
            const arrows = result.subvariantArrows.get(startFen)!;
            // Max 8 half-moves = 4 pairs
            expect(arrows).toHaveLength(8);

            // Pair 1: green
            expect(arrows[0].brush).toBe('G');
            expect(arrows[1].brush).toBe('G');
            // Pair 2: red
            expect(arrows[2].brush).toBe('R');
            expect(arrows[3].brush).toBe('R');
            // Pair 3: blue
            expect(arrows[4].brush).toBe('B');
            expect(arrows[5].brush).toBe('B');
            // Pair 4: yellow
            expect(arrows[6].brush).toBe('Y');
            expect(arrows[7].brush).toBe('Y');
        });

        it('strips PGN headers', () => {
            const pgn = `[Event "Test"]
[Site "?"]
[Date "2024.01.01"]

1. e4 e5 (1... d5) 2. Nf3`;
            const result = parsePgnWithVariations(pgn);

            expect(result.mainLinePgn).toContain('Nf3');
            expect(result.subvariantArrows.size).toBe(1);
        });

        it('handles empty PGN', () => {
            const result = parsePgnWithVariations('');
            expect(result.mainLinePgn).toBe('');
            expect(result.subvariantArrows.size).toBe(0);
        });

        it('handles PGN with result marker', () => {
            const result = parsePgnWithVariations('1. e4 e5 1-0');
            expect(result.mainLinePgn).toContain('e4');
            expect(result.mainLinePgn).toContain('e5');
        });

        it('handles variation with a single move', () => {
            const pgn = '1. e4 (1. d4) 1... e5';
            const result = parsePgnWithVariations(pgn);

            const startFen = new Chess().fen();
            const arrows = result.subvariantArrows.get(startFen)!;
            expect(arrows).toHaveLength(1);
            expect(arrows[0]).toEqual({ brush: 'G', orig: 'd2', dest: 'd4' });
        });

        it('handles castling in variations', () => {
            const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Be7 5. O-O (5. Bg5) 5... O-O';
            const result = parsePgnWithVariations(pgn);

            expect(result.subvariantArrows.size).toBe(1);
            // The variation move is 5. Bg5
            const arrows = [...result.subvariantArrows.values()][0];
            expect(arrows).toHaveLength(1);
            expect(arrows[0]).toEqual({ brush: 'G', orig: 'c1', dest: 'g5' });
        });

        it('handles unmatched closing parentheses gracefully', () => {
            const pgn = '1. e4 e5) 2. Nf3';
            const result = parsePgnWithVariations(pgn);
            // Should not throw; parses what it can
            expect(result.mainLinePgn).toContain('e4');
        });

        it('returns empty main line for completely invalid moves', () => {
            const result = parsePgnWithVariations('1. Zz9 Qq0');
            expect(result.mainLinePgn).toBe('');
            expect(result.subvariantArrows.size).toBe(0);
        });
    });
});
