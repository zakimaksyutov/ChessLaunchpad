import { LaunchpadLogic } from './LaunchpadLogic';
import { OpeningVariant } from './OpeningVariant';
import { Chess } from 'chess.js';

function createOpeningVariant(pgn: string): OpeningVariant {
    return new OpeningVariant('Test Opening', pgn, 'white');
}

describe('LaunchpadLogic - FEN to Variant Map', () => {
    it('populates fenToVariantMap correctly', () => {
        const ruyLopezVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');

        const logic = new LaunchpadLogic([ruyLopezVariant]);

        // Access the private property - fenToVariantMap
        const fenMap = (logic as any).fenToVariantMap as Map<string, OpeningVariant[]>;

        // Initial position + position after every move = 7 positions
        expect(fenMap.size).toBe(7);

        // Check the initial position (copied from Lichess)
        const firstPosition = fenMap.get('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        expect(firstPosition).toBeDefined();
        expect(firstPosition!.length).toBe(1);
        expect(firstPosition![0].pgn).toBe('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');

        // Check the last position (copied from Lichess)
        const lastPosition = fenMap.get('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4');
        expect(lastPosition).toBeDefined();
        expect(lastPosition!.length).toBe(1);
        expect(lastPosition![0].pgn).toBe('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
    });

    it('FEN points to two variants with shared first moves', () => {
        const ruyLopezMorphyVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
        const ruyLopezBerlinVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6');

        const logic = new LaunchpadLogic([ruyLopezMorphyVariant, ruyLopezBerlinVariant]);

        // Access the private property - fenToVariantMap
        const fenMap = (logic as any).fenToVariantMap as Map<string, OpeningVariant[]>;

        // PGN after 1. e4 e5 2. Nf3 Nc6 3. Bb5 should return two variants. Note that halfmove clock is reset to 0.
        const position = fenMap.get('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 3');
        expect(position).toBeDefined();
        expect(position!.length).toBe(2);
        expect(position![0].pgn).toBe(ruyLopezMorphyVariant.pgn);
        expect(position![1].pgn).toBe(ruyLopezBerlinVariant.pgn);
    });

    it('FEN points to two variants with flipped first moves', () => {
        const ruyLopezMorphyVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
        const ruyLopezCustomVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Bb5 Nc6 3. Nf3 Nf6');

        const logic = new LaunchpadLogic([ruyLopezMorphyVariant, ruyLopezCustomVariant]);

        // Access the private property - fenToVariantMap
        const fenMap = (logic as any).fenToVariantMap as Map<string, OpeningVariant[]>;

        // PGN after 1. e4 e5 2. Nf3 Nc6 3. Bb5 should return two variants. Note that halfmove clock is reset to 0.
        const position = fenMap.get('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 3');
        expect(position).toBeDefined();
        expect(position!.length).toBe(2);
        expect(position![0].pgn).toBe(ruyLopezMorphyVariant.pgn);
        expect(position![1].pgn).toBe(ruyLopezCustomVariant.pgn);
    });

    it('FEN points to correct variant', () => {
        const ruyLopezMorphyVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
        const ruyLopezBerlinVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6');

        const logic = new LaunchpadLogic([ruyLopezMorphyVariant, ruyLopezBerlinVariant]);

        // Access the private property - fenToVariantMap
        const fenMap = (logic as any).fenToVariantMap as Map<string, OpeningVariant[]>;

        // PGN after 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 should return two variants
        const position = fenMap.get('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4');
        expect(position).toBeDefined();
        expect(position!.length).toBe(1);
        expect(position![0].pgn).toBe(ruyLopezMorphyVariant.pgn);
    });
});

describe('LaunchpadLogic - Get Next Move', () => {
    it('getNextMove returns the expected moves', () => {
        const ruyLopezVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');

        const chess = new Chess();
        chess.loadPgn(ruyLopezVariant.pgn);

        const moves = chess.history({ verbose: true });
        var moveIndex = 0;

        const chessNewGame = new Chess();

        do {
            const logic = new LaunchpadLogic([ruyLopezVariant]);
            const nextMove = logic.getNextMove(chessNewGame.fen(), moveIndex);
            expect(nextMove).toEqual(moves[moveIndex]);
            chessNewGame.move(nextMove);
            ++moveIndex;
        } while (moveIndex < moves.length);
    });

    it('getNextMove throws an error if a move is not available', () => {
        const ruyLopezVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');

        // Above position (copied from Lichess.org)
        const fen = 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';

        const logic = new LaunchpadLogic([ruyLopezVariant]);

        expect(() => {
            logic.getNextMove(fen, 6);
        }).toThrow('No next move available for the given FEN and move index.');
    });

    it('getNextMove randomly returns one of two moves', () => {
        const ruyLopezMorphyVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
        const ruyLopezBerlinVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6');

        // Above position after 3. Bb5 (copied from Lichess.org)
        const fen = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

        var numberOfTests = 500;
        var numberOfTimesMorphyMoveWasReturned = 0;
        var numberOfTimesBerlinMoveWasReturned = 0;
        for (var i = 0; i < numberOfTests; ++i) {
            const logic = new LaunchpadLogic([ruyLopezMorphyVariant, ruyLopezBerlinVariant]);
            const nextMove = logic.getNextMove(fen, 5);

            if (nextMove.from === 'a7' && nextMove.to === 'a6') {
                ++numberOfTimesMorphyMoveWasReturned;
            } else if (nextMove.from === 'g8' && nextMove.to === 'f6') {
                ++numberOfTimesBerlinMoveWasReturned;
            } else {
                throw new Error(`Unexpected move returned: ${nextMove.from}-${nextMove.to}`);
            }
        }

        // With 50% chance between two moves, we expect each move to be returned at least 400 times with extremely high probability.
        expect(numberOfTimesMorphyMoveWasReturned).toBeGreaterThan(200);
        expect(numberOfTimesBerlinMoveWasReturned).toBeGreaterThan(200);
    });

    it('getNextMove randomly returns one of two moves with different probability', () => {
        const ruyLopezMorphyVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
        ruyLopezMorphyVariant.errorEMA = 10;
        ruyLopezMorphyVariant.currentEpoch = 10;
        ruyLopezMorphyVariant.lastSucceededEpoch = 9;
        const ruyLopezBerlinVariant: OpeningVariant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6');
        ruyLopezBerlinVariant.errorEMA = 0.5;
        ruyLopezBerlinVariant.currentEpoch = 10;
        ruyLopezBerlinVariant.lastSucceededEpoch = 1;

        // Above position after 3. Bb5 (copied from Lichess.org)
        const fen = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

        var numberOfTests = 500;
        var numberOfTimesMorphyMoveWasReturned = 0;
        var numberOfTimesBerlinMoveWasReturned = 0;
        for (var i = 0; i < numberOfTests; ++i) {
            const logic = new LaunchpadLogic([ruyLopezMorphyVariant, ruyLopezBerlinVariant]);
            const nextMove = logic.getNextMove(fen, 5);

            if (nextMove.from === 'a7' && nextMove.to === 'a6') {
                ++numberOfTimesMorphyMoveWasReturned;
            } else if (nextMove.from === 'g8' && nextMove.to === 'f6') {
                ++numberOfTimesBerlinMoveWasReturned;
            } else {
                throw new Error(`Unexpected move returned: ${nextMove.from}-${nextMove.to}`);
            }
        }

        // With 50% chance between two moves, we expect each move to be returned at least 400 times with extremely high probability.
        expect(numberOfTimesMorphyMoveWasReturned).toBeGreaterThan(425);
        expect(numberOfTimesBerlinMoveWasReturned).toBeGreaterThan(25);
    });

    it('A move can be played if it leads to another known position', () => {
        // Below are two variations from Sicilian Defense.
        // At no point they have the same position. But in the Kan variation, after 4. Nxd4, black can play e6 and reach the Taimanov variation. 
        const sicilianDefenseKanVariation = createOpeningVariant('1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6');
        const sicilianDefenseTaimanovVariation = createOpeningVariant('1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6');

        // Position in variation1 after 4. Nxd4
        const fen = 'rnbqkbnr/pp1p1ppp/4p3/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 4'

        var numberOfTests = 100;
        var numberOfKanVariantionReturned = 0;
        var numberOfTaimanovVariationReturned = 0;

        for (var i = 0; i < numberOfTests; ++i) {
            const logic = new LaunchpadLogic([sicilianDefenseKanVariation, sicilianDefenseTaimanovVariation]);
            const nextMove = logic.getNextMove(fen, 7);

            if (nextMove.from === 'a7' && nextMove.to === 'a6') {
                ++numberOfKanVariantionReturned;
            } else if (nextMove.from === 'b8' && nextMove.to === 'c6') {
                ++numberOfTaimanovVariationReturned;
            } else {
                throw new Error(`Unexpected move returned: ${nextMove.from}-${nextMove.to}`);
            }
        }

        expect(numberOfKanVariantionReturned + numberOfTaimanovVariationReturned).toBe(numberOfTests);
        expect(numberOfKanVariantionReturned).toBeGreaterThan(30);
        expect(numberOfTaimanovVariationReturned).toBeGreaterThan(30);
    });
});