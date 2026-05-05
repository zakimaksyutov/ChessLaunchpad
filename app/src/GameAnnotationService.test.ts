import { describe, it, expect } from 'vitest';
import { annotateGame, getUserColor } from './GameAnnotationService';
import { ExplorerEvals } from './ExplorerEvals';
import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

/**
 * Helper: build a Lichess-style game data object from a move string and player names.
 */
function makeGameData(
    moves: string,
    whiteId: string,
    blackId: string
): Record<string, unknown> {
    return {
        id: 'testgame',
        moves,
        players: {
            white: { user: { id: whiteId } },
            black: { user: { id: blackId } },
        },
    };
}

/**
 * Helper: build a repertoire FEN set from a list of PGN move sequences.
 * Each sequence is replayed and all resulting FENs (normalized) are added.
 */
function buildRepertoireFens(moveSequences: string[][]): Set<string> {
    const fens = new Set<string>();
    for (const seq of moveSequences) {
        const c = new Chess();
        fens.add(normalizeFenResetHalfmoveClock(c.fen()));
        for (const san of seq) {
            c.move(san);
            fens.add(normalizeFenResetHalfmoveClock(c.fen()));
        }
    }
    return fens;
}

/**
 * Helper: build an ExplorerEvals from full FENs mapped to centipawn values.
 * Converts full FENs to 3-field compact FENs internally.
 */
function makeEvals(entries: Record<string, number | number[]>): ExplorerEvals {
    return ExplorerEvals.fromRecord(entries);
}

/**
 * Helper: get compact 3-field FEN (pieces, side, castling) from a full FEN.
 */
function compact(fen: string): string {
    return fen.split(' ').slice(0, 3).join(' ');
}

/**
 * Helper: replay moves and return the full FEN after each move, plus the starting FEN.
 */
function replayFens(moves: string[]): string[] {
    const c = new Chess();
    const fens = [c.fen()];
    for (const m of moves) {
        c.move(m);
        fens.push(c.fen());
    }
    return fens;
}

describe('getUserColor', () => {
    it('returns white when username matches white player', () => {
        const data = makeGameData('e4 e5', 'alice', 'bob');
        expect(getUserColor(data, 'alice')).toBe('white');
    });

    it('returns black when username matches black player', () => {
        const data = makeGameData('e4 e5', 'alice', 'bob');
        expect(getUserColor(data, 'bob')).toBe('black');
    });

    it('is case-insensitive', () => {
        const data = makeGameData('e4 e5', 'Alice', 'Bob');
        expect(getUserColor(data, 'alice')).toBe('white');
        expect(getUserColor(data, 'BOB')).toBe('black');
    });

    it('returns null for unknown player', () => {
        const data = makeGameData('e4 e5', 'alice', 'bob');
        expect(getUserColor(data, 'charlie')).toBeNull();
    });
});

describe('annotateGame', () => {
    // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (Ruy Lopez)
    const ruyLopezMoves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
    const repertoireFens = buildRepertoireFens([ruyLopezMoves]);

    describe('all moves in repertoire', () => {
        it('highlights user moves as in-repertoire while in theory', () => {
            // Game follows the repertoire exactly: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bb5 a6', 'user', 'opp');
            const result = annotateGame(gameData, 'user', repertoireFens, null);

            expect(result).not.toBeNull();
            const moves = result!.moves;

            // User moves (white): e4, Nf3, Bb5 → all in-repertoire
            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[4].highlight).toBe('in-repertoire'); // Bb5

            // Opponent moves: e5, Nc6 → in-repertoire (positions are in set)
            expect(moves[1].highlight).toBe('in-repertoire'); // e5
            expect(moves[3].highlight).toBe('in-repertoire'); // Nc6
        });
    });

    describe('user deviation from repertoire', () => {
        it('highlights user deviation move', () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            // Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4 (user plays Bc4 instead of Bb5)
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6', 'user', 'opp');
            const result = annotateGame(gameData, 'user', repertoireFens, null);

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[4].highlight).toBe('deviation');     // Bc4 — user deviated
            expect(moves[4].isUserMove).toBe(true);
        });

        it('computes eval drop for user deviation when evals are available', () => {
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6', 'user', 'opp');

            // FEN before Bc4 (after Nc6) and FEN after Bc4
            const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
            const fenBefore = fens[4]; // after Nc6
            const fenAfter = fens[5];  // after Bc4

            const evals = makeEvals({
                [compact(fenBefore)]: [30],  // 30cp for White
                [compact(fenAfter)]: [-20],  // -20cp for White → drop = 30-(-20) = 50
            });

            const result = annotateGame(gameData, 'user', repertoireFens, evals);
            expect(result).not.toBeNull();
            const deviationMove = result!.moves[4]; // Bc4
            expect(deviationMove.highlight).toBe('deviation');
            expect(deviationMove.evalDrop).toBeDefined();
            expect(deviationMove.evalDrop!.evalDrop).toBe(50);
            expect(deviationMove.evalDrop!.category).toBe('mistake');
        });
    });

    describe('opponent deviation from repertoire', () => {
        it('evaluates user response after opponent deviation', () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            // Game: 1. e4 e5 2. Nf3 d6 ... (opponent plays d6 instead of Nc6)
            // User's next move (3. Bb5 or 3. d4, etc.) should be evaluated
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3', 'user', 'opp');
            const result = annotateGame(gameData, 'user', repertoireFens, null);

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[1].highlight).toBe('in-repertoire'); // e5
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[3].highlight).toBe('out-of-theory'); // d6 — opponent deviated
            expect(moves[3].isUserMove).toBe(false);
            expect(moves[4].highlight).toBe('deviation');     // d4 — user's first response
            expect(moves[4].isUserMove).toBe(true);
        });

        it('computes eval drop for user response after opponent deviation', () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6', 'user', 'opp');

            // FEN before d4 (after d6) and FEN after d4
            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4']);
            const fenBefore = fens[4]; // after d6
            const fenAfter = fens[5];  // after d4

            const evals = makeEvals({
                [compact(fenBefore)]: [50],  // 50cp for White
                [compact(fenAfter)]: [10],   // 10cp for White → drop = 50-10 = 40
            });

            const result = annotateGame(gameData, 'user', repertoireFens, evals);
            expect(result).not.toBeNull();
            const userResponse = result!.moves[4]; // d4
            expect(userResponse.highlight).toBe('deviation');
            expect(userResponse.evalDrop).toBeDefined();
            expect(userResponse.evalDrop!.evalDrop).toBe(40);
            expect(userResponse.evalDrop!.category).toBe('inaccuracy');
        });

        it('marks user response as deviation even without eval data', () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6', 'user', 'opp');
            const result = annotateGame(gameData, 'user', repertoireFens, null);

            expect(result).not.toBeNull();
            const userResponse = result!.moves[4]; // d4
            expect(userResponse.highlight).toBe('deviation');
            expect(userResponse.evalDrop).toBeUndefined();
        });

        it('sets mini board to user response position after opponent deviation', () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6', 'user', 'opp');
            const result = annotateGame(gameData, 'user', repertoireFens, null);

            expect(result).not.toBeNull();
            // Mini board should show position after d4 (first deviation fen)
            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4']);
            expect(result!.miniBoardFen).toBe(fens[5]);
        });

        it('subsequent moves after user response are out-of-theory', () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3 Be7', 'user', 'opp');
            const result = annotateGame(gameData, 'user', repertoireFens, null);

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[4].highlight).toBe('deviation');     // d4 — user response
            expect(moves[5].highlight).toBe('out-of-theory'); // Nf6
            expect(moves[6].highlight).toBe('out-of-theory'); // Nc3
        });
    });

    describe('no repertoire overlap', () => {
        it('marks all moves as out-of-theory when starting position is not in repertoire', () => {
            // Use an empty repertoire
            const emptyRep = new Set<string>();
            const gameData = makeGameData('e4 e5 Nf3 Nc6', 'user', 'opp');
            const result = annotateGame(gameData, 'user', emptyRep, null);

            expect(result).not.toBeNull();
            for (const move of result!.moves) {
                expect(move.highlight).toBe('out-of-theory');
            }
        });
    });

    describe('playing as black', () => {
        it('correctly identifies user moves for black player', () => {
            // Repertoire for black: 1. e4 e5
            const blackRepMoves = ['e4', 'e5'];
            const blackRepFens = buildRepertoireFens([blackRepMoves]);

            // Game: 1. e4 e5 2. Nf3 d6 (user as black deviates with d6 instead of Nc6, etc.)
            // But we need a rep that goes further. Let's use: 1. e4 e5 2. Nf3 Nc6
            const blackRepMoves2 = ['e4', 'e5', 'Nf3', 'Nc6'];
            const blackRepFens2 = buildRepertoireFens([blackRepMoves2]);

            // Game: 1. e4 e5 2. Nf3 d5 (user deviates from Nc6 to d5)
            const gameData = makeGameData('e4 e5 Nf3 d5', 'opp', 'user');
            const result = annotateGame(gameData, 'user', blackRepFens2, null);

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[1].isUserMove).toBe(true);  // e5 — black/user
            expect(moves[1].highlight).toBe('in-repertoire');
            expect(moves[3].isUserMove).toBe(true);  // d5 — black/user deviated
            expect(moves[3].highlight).toBe('deviation');
        });

        it('evaluates user response after opponent deviation when playing black', () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6
            const blackRepMoves = ['e4', 'e5', 'Nf3', 'Nc6'];
            const blackRepFens = buildRepertoireFens([blackRepMoves]);

            // Game: 1. e4 e5 2. d4 exd4 (opponent plays d4 instead of Nf3)
            const gameData = makeGameData('e4 e5 d4 exd4 Nf3', 'opp', 'user');
            const result = annotateGame(gameData, 'user', blackRepFens, null);

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[1].highlight).toBe('in-repertoire'); // e5
            expect(moves[2].highlight).toBe('out-of-theory'); // d4 — opponent deviated
            expect(moves[2].isUserMove).toBe(false);
            expect(moves[3].highlight).toBe('deviation');     // exd4 — user's response
            expect(moves[3].isUserMove).toBe(true);
        });
    });
});
