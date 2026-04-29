import { LaunchpadLogic } from './LaunchpadLogic';
import { OpeningVariant } from './OpeningVariant';
import { Chess } from 'chess.js';
import { FSRSCardData } from './FSRSCardData';
import { FSRSService } from './FSRSService';
import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

function createOpeningVariant(pgn: string): OpeningVariant {
    return new OpeningVariant(pgn, 'white', []);
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
        const lastPosition = fenMap.get('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1');
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
        const position = fenMap.get('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1');
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
        const position = fenMap.get('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1');
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
        const position = fenMap.get('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1');
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
        const fen = 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1';

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

describe('LaunchpadLogic - FSRS Integration', () => {

    // Helper: build a Review-state card with high stability
    function buildReviewCardData(reviewDate: Date): FSRSCardData {
        const scheduler = fsrs({
            request_retention: 0.9,
            maximum_interval: 365,
            enable_fuzz: false,
            enable_short_term: true
        });
        let card = createEmptyCard(reviewDate);
        card = scheduler.next(card, reviewDate, Rating.Good).card;
        card = scheduler.next(card, new Date(card.due), Rating.Good).card;
        expect(card.state).toBe(State.Review);
        return FSRSService.serialize(card);
    }

    describe('shouldAutoplayUserMove', () => {
        it('should return false when no FSRS cards exist (backward compat)', () => {
            const variant = createOpeningVariant('1. e4 e5');
            const logic = new LaunchpadLogic([variant]);

            // Starting position — user's move is e4
            const chess = new Chess();
            expect(logic.shouldAutoplayUserMove(chess.fen())).toBe(false);
        });

        it('should return true when all user moves at position have well-known cards', () => {
            const variant = createOpeningVariant('1. e4 e5');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startingFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startingFen}::e4`]: cardData
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            const chess = new Chess();
            expect(logic.shouldAutoplayUserMove(chess.fen())).toBe(true);

            vi.useRealTimers();
        });

        it('should return false when card is not in Review state', () => {
            const variant = createOpeningVariant('1. e4 e5');

            const startingFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startingFen}::e4`]: {
                    d: '2026-05-01T00:00:00.000Z',
                    s: 2, di: 5, e: 0, sd: 0, ls: 1, r: 1, l: 0,
                    st: State.Learning,
                    lr: '2026-04-01T00:00:00.000Z'
                }
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-04-02T00:00:00Z'));
            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(false);
            vi.useRealTimers();
        });

        it('should return false when any card at a branch point fails', () => {
            const morphy = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const berlin = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6');

            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const goodCard = buildReviewCardData(reviewDate);

            // Position after 3. Bb5 — black to move
            const fenAfterBb5 = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1';

            // Only a6 has a card, Nf6 does not
            const fsrsCards: Record<string, FSRSCardData> = {
                [`${fenAfterBb5}::a6`]: goodCard
            };

            const logic = new LaunchpadLogic([morphy, berlin], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(goodCard.lr!).getTime() + 1000);

            const chess = new Chess();
            chess.move('e4'); chess.move('e5'); chess.move('Nf3'); chess.move('Nc6'); chess.move('Bb5');

            expect(logic.shouldAutoplayUserMove(chess.fen())).toBe(false);

            vi.useRealTimers();
        });
    });

    describe('rateUserMove', () => {
        it('should rate as Good when no error at position', () => {
            const variant = createOpeningVariant('1. e4 e5');
            const fsrsCards: Record<string, FSRSCardData> = {};
            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));

            const chess = new Chess();
            logic.rateUserMove(chess.fen(), 'e4');

            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
            expect(fsrsCards[key]).toBeDefined();
            expect(fsrsCards[key].r).toBe(1);
            expect(fsrsCards[key].l).toBe(0); // No lapse → rated Good

            vi.useRealTimers();
        });

        it('should rate as Again when error occurred at position', () => {
            const variant = createOpeningVariant('1. e4 e5');
            const fsrsCards: Record<string, FSRSCardData> = {};
            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));

            const chess = new Chess();
            logic.markError(chess.fen());
            logic.rateUserMove(chess.fen(), 'e4');

            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
            expect(fsrsCards[key]).toBeDefined();
            // Again on a New card → lower stability and higher difficulty than Good
            expect(fsrsCards[key].s).toBeLessThan(1);
            expect(fsrsCards[key].di).toBeGreaterThan(5);

            vi.useRealTimers();
        });

        it('should clear error state after rating so repeated FEN gets fresh assessment', () => {
            const variant = createOpeningVariant('1. e4 e5');
            const fsrsCards: Record<string, FSRSCardData> = {};
            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));

            const chess = new Chess();
            const key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';

            // First encounter: error then correct → Again
            logic.markError(chess.fen());
            logic.rateUserMove(chess.fen(), 'e4');
            const stabilityAfterAgain = fsrsCards[key].s;

            // Second encounter at same FEN: no error → should be rated Good (not Again)
            logic.rateUserMove(chess.fen(), 'e4');
            // Good produces higher stability than Again on a card that just had Again
            expect(fsrsCards[key].s).toBeGreaterThan(stabilityAfterAgain);

            vi.useRealTimers();
        });
    });

    describe('getFsrsCards', () => {
        it('should return the same cards object (shared reference)', () => {
            const fsrsCards: Record<string, FSRSCardData> = {};
            const logic = new LaunchpadLogic([createOpeningVariant('1. e4 e5')], fsrsCards);
            expect(logic.getFsrsCards()).toBe(fsrsCards);
        });
    });

    describe('shouldAutoplayUserMove — lookahead', () => {

        // Helper: compute normalized FEN after a sequence of moves
        function fenAfter(...moves: string[]): string {
            const chess = new Chess();
            for (const m of moves) chess.move(m);
            return normalizeFenResetHalfmoveClock(chess.fen());
        }

        // Helper: compute raw FEN after a sequence of moves (for passing to shouldAutoplayUserMove)
        function rawFenAfter(...moves: string[]): string {
            const chess = new Chess();
            for (const m of moves) chess.move(m);
            return chess.fen();
        }

        it('should autoplay when both user-turn depths have strong cards', () => {
            // Variant: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6
            // Depth 2 from starting position checks: e4 at start, Nf3 at position after e5
            const variant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter(); // starting position
            const fenAfterE5 = fenAfter('e4', 'e5');

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
                [`${fenAfterE5}::Nf3`]: { ...cardData },
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(true);

            vi.useRealTimers();
        });

        it('should NOT autoplay when card at next user-turn position is missing', () => {
            const variant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter();
            // No card for Nf3 at position after e5

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(false);

            vi.useRealTimers();
        });

        it('should autoplay when variant ends within lookahead window', () => {
            // Variant: 1. e4 e5 (only 2 half-moves, variant ends after e5)
            // After e4 e5, there's no next user-turn position → nothing weak ahead
            const variant = createOpeningVariant('1. e4 e5');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter();

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(true);

            vi.useRealTimers();
        });

        it('should NOT autoplay when opponent-response branching leads to a weak position', () => {
            // Two variants diverge at the opponent's response after e4:
            //   1. e4 e5 2. Nf3 Nc6 3. Bb5 a6
            //   1. e4 d5 2. exd5 Qxd5
            // After user plays e4, opponent can play e5 or d5.
            // Card at position-after-e5 for Nf3 is good, but card at position-after-d5 for exd5 is missing.
            const variant1 = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const variant2 = createOpeningVariant('1. e4 d5 2. exd5 Qxd5');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter();
            const fenAfterE5 = fenAfter('e4', 'e5');
            // No card for exd5 at position after d5

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
                [`${fenAfterE5}::Nf3`]: { ...cardData },
            };

            const logic = new LaunchpadLogic([variant1, variant2], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(false);

            vi.useRealTimers();
        });

        it('should NOT autoplay when card at next user-turn is in Learning state', () => {
            const variant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter();
            const fenAfterE5 = fenAfter('e4', 'e5');

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
                [`${fenAfterE5}::Nf3`]: {
                    d: '2026-05-01T00:00:00.000Z',
                    s: 2, di: 5, e: 0, sd: 0, ls: 1, r: 1, l: 0,
                    st: State.Learning,
                    lr: '2026-04-01T00:00:00.000Z'
                },
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(false);

            vi.useRealTimers();
        });

        it('should autoplay with skipLookahead even when next user-turn card is missing', () => {
            const variant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter();
            // No card for Nf3 at next user-turn position

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            // With skipLookahead=true, only the current position is checked (depth 1)
            expect(logic.shouldAutoplayUserMove(new Chess().fen(), true)).toBe(true);

            vi.useRealTimers();
        });

        it('should respect AUTOPLAY_LOOKAHEAD_DEPTH constant', () => {
            const variant = createOpeningVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCardData(reviewDate);

            const startFen = fenAfter();
            // No card for Nf3 — would fail at depth 2

            const fsrsCards: Record<string, FSRSCardData> = {
                [`${startFen}::e4`]: { ...cardData },
            };

            const logic = new LaunchpadLogic([variant], fsrsCards);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(cardData.lr!).getTime() + 1000);

            // Default depth 2 → should fail (missing card at depth 2)
            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(false);

            // Override depth to 1 → should pass (only checks current position)
            const originalDepth = LaunchpadLogic.AUTOPLAY_LOOKAHEAD_DEPTH;
            LaunchpadLogic.AUTOPLAY_LOOKAHEAD_DEPTH = 1;
            expect(logic.shouldAutoplayUserMove(new Chess().fen())).toBe(true);
            LaunchpadLogic.AUTOPLAY_LOOKAHEAD_DEPTH = originalDepth;

            vi.useRealTimers();
        });
    });
});