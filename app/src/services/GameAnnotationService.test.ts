import { describe, it, expect } from 'vitest';
import { annotateGame, getUserColor, extractEmbeddedEvals } from './GameAnnotationService';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { MastersLookup } from './MastersExplorerService';

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
function makeEvals(entries: Record<string, number[]>): ExplorerEvals {
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
    it('returns white when username matches white player', async () => {
        const data = makeGameData('e4 e5', 'alice', 'bob');
        expect(getUserColor(data, 'alice', 'lichess')).toBe('white');
    });

    it('returns black when username matches black player', async () => {
        const data = makeGameData('e4 e5', 'alice', 'bob');
        expect(getUserColor(data, 'bob', 'lichess')).toBe('black');
    });

    it('is case-insensitive', async () => {
        const data = makeGameData('e4 e5', 'Alice', 'Bob');
        expect(getUserColor(data, 'alice', 'lichess')).toBe('white');
        expect(getUserColor(data, 'BOB', 'lichess')).toBe('black');
    });

    it('returns null for unknown player', async () => {
        const data = makeGameData('e4 e5', 'alice', 'bob');
        expect(getUserColor(data, 'charlie', 'lichess')).toBeNull();
    });
});

describe('annotateGame', () => {
    // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (Ruy Lopez)
    const ruyLopezMoves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
    const repertoireFens = buildRepertoireFens([ruyLopezMoves]);

    describe('all moves in repertoire', () => {
        it('highlights user moves as in-repertoire while in theory', async () => {
            // Game follows the repertoire exactly: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bb5 a6', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repertoireFens, null, 30, 'lichess');

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
        it('highlights user deviation move', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            // Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4 (user plays Bc4 instead of Bb5)
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repertoireFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[4].highlight).toBe('deviation');     // Bc4 — user deviated
            expect(moves[4].isUserMove).toBe(true);
        });

        it('computes eval drop for user deviation when evals are available', async () => {
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6', 'user', 'opp');

            // FEN before Bc4 (after Nc6) and FEN after Bc4
            const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
            const fenBefore = fens[4]; // after Nc6
            const fenAfter = fens[5];  // after Bc4

            const evals = makeEvals({
                [compact(fenBefore)]: [30],  // 30cp for White
                [compact(fenAfter)]: [-20],  // -20cp for White → drop = 30-(-20) = 50
            });

            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');
            expect(result).not.toBeNull();
            const deviationMove = result!.moves[4]; // Bc4
            expect(deviationMove.highlight).toBe('deviation');
            expect(deviationMove.evalDrop).toBeDefined();
            expect(deviationMove.evalDrop!.evalDrop).toBe(50);
            expect(deviationMove.evalDrop!.category).toBe('mistake');
        });
    });

    describe('opponent deviation from repertoire', () => {
        it('evaluates user response after opponent deviation (opponent stays in theory)', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            // Game: 1. e4 e5 2. Nf3 d6 ... (opponent plays d6 instead of Nc6)
            // d6 is a small drop (in theory) so the user's response is analysed.
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3', 'user', 'opp');

            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4']);
            const evals = makeEvals({
                [compact(fens[3])]: [30],  // after Nf3 (before d6)
                [compact(fens[4])]: [30],  // after d6 → opponent drop 0 (in theory)
                [compact(fens[5])]: [25],  // after d4 → user drop 5 (ok)
            });

            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[1].highlight).toBe('in-repertoire'); // e5
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[3].highlight).toBe('out-of-repertoire'); // d6 — opponent deviated but in theory
            expect(moves[3].isUserMove).toBe(false);
            expect(moves[4].highlight).toBe('out-of-repertoire-response');     // d4 — user's first response
            expect(moves[4].isUserMove).toBe(true);
        });

        it('computes eval drop for user response after opponent deviation', async () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6', 'user', 'opp');

            // FEN before d4 (after d6) and FEN after d4
            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4']);
            const fenBefore = fens[4]; // after d6
            const fenAfter = fens[5];  // after d4

            const evals = makeEvals({
                [compact(fens[3])]: [50],    // after Nf3 (before d6) → opponent drop 0 (in theory)
                [compact(fenBefore)]: [50],  // 50cp for White
                [compact(fenAfter)]: [10],   // 10cp for White → drop = 50-10 = 40
            });

            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');
            expect(result).not.toBeNull();
            const userResponse = result!.moves[4]; // d4
            expect(userResponse.highlight).toBe('out-of-repertoire-response');
            expect(userResponse.evalDrop).toBeDefined();
            expect(userResponse.evalDrop!.evalDrop).toBe(40);
            expect(userResponse.evalDrop!.category).toBe('inaccuracy');
        });

        it('treats opponent deviation as out-of-theory when no source has an eval', async () => {
            // With no eval anywhere (explorer/embedded/cloud all miss), the
            // opponent's departure is treated as too rare to be theory: it and
            // the user's subsequent moves are out-of-theory, not graded.
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repertoireFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            expect(result!.moves[3].highlight).toBe('out-of-theory'); // d6 — opponent, no eval
            const userResponse = result!.moves[4]; // d4
            expect(userResponse.highlight).toBe('out-of-theory');
            expect(userResponse.evalDrop).toBeUndefined();
        });

        it('sets mini board to user response position after opponent deviation', async () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6', 'user', 'opp');
            // d6 in theory (small drop) so the user's response opens post-theory.
            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4']);
            const evals = makeEvals({
                [compact(fens[3])]: [30],  // after Nf3 (before d6)
                [compact(fens[4])]: [30],  // after d6 → opponent drop 0 (in theory)
                [compact(fens[5])]: [25],  // after d4 → user drop 5 (ok)
            });
            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');

            expect(result).not.toBeNull();
            // Mini board should show position after d4 (first post-theory fen)
            expect(result!.miniBoardFen).toBe(fens[5]);
        });

        it('continues analysis across subsequent moves while opponent stays in theory', async () => {
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3 Be7', 'user', 'opp');
            // Small (in-theory) drops for both opponent moves so the post-theory
            // walk keeps grading the user's responses across multiple plies.
            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3', 'Be7']);
            const evals = makeEvals({
                [compact(fens[3])]: [30],  // after Nf3 (before d6)
                [compact(fens[4])]: [30],  // after d6 → opponent drop 0 (in theory)
                [compact(fens[5])]: [25],  // after d4 → user drop 5 (ok)
                [compact(fens[6])]: [25],  // after Nf6 → opponent drop 0 (in theory)
                [compact(fens[7])]: [20],  // after Nc3 → user drop 5 (ok)
                [compact(fens[8])]: [20],  // after Be7 → opponent drop 0 (in theory)
            });
            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[4].highlight).toBe('out-of-repertoire-response');     // d4 — user response
            expect(moves[5].highlight).toBe('out-of-repertoire'); // Nf6 — opponent, still in theory
            expect(moves[6].highlight).toBe('out-of-repertoire-response'); // Nc3 — user still analyzed
            expect(moves[7].highlight).toBe('out-of-repertoire'); // Be7 — opponent, still in theory
        });
    });

    describe('extended post-theory analysis', () => {
        it('detects user inaccuracy on 2nd+ move after opponent leaves repertoire', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            // Game: 1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 (user plays Nc3 with a 70cp drop)
            // Opponent's d6 and Nf6 are small drops (in theory) so user moves are analysed.
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3 Be7', 'user', 'opp');

            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3']);
            const fenBeforeD4 = fens[4];   // after d6
            const fenAfterD4 = fens[5];    // after d4
            const fenBeforeNc3 = fens[6];  // after Nf6
            const fenAfterNc3 = fens[7];   // after Nc3

            // Opponent move Nf6: small drop (under 45 threshold) so analysis continues
            const fenBeforeNf6 = fens[5];  // after d4
            const fenAfterNf6 = fens[6];   // after Nf6

            const evals = makeEvals({
                [compact(fens[3])]: [50],       // after Nf3 (before d6) → opponent drop 0 (in theory)
                [compact(fenBeforeD4)]: [50],   // after d6: +0.50
                [compact(fenAfterD4)]: [45],    // after d4: +0.45 → user drop = 5cp (ok)
                [compact(fenBeforeNf6)]: [45],  // after d4: +0.45
                [compact(fenAfterNf6)]: [40],   // after Nf6: +0.40 → opponent drop = 5cp (< 45, still in theory)
                [compact(fenBeforeNc3)]: [40],  // after Nf6: +0.40
                [compact(fenAfterNc3)]: [-30],  // after Nc3: -0.30 → user drop = 70cp (blunder!)
            });

            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');
            expect(result).not.toBeNull();
            const moves = result!.moves;

            // d4: first response, ok drop
            expect(moves[4].highlight).toBe('out-of-repertoire-response');
            expect(moves[4].evalDrop?.category).toBe('ok');

            // Nf6: opponent move, still in theory
            expect(moves[5].highlight).toBe('out-of-repertoire');

            // Nc3: 2nd user move, blunder detected (opponent stayed in theory)
            expect(moves[6].highlight).toBe('out-of-repertoire-response');
            expect(moves[6].evalDrop).toBeDefined();
            expect(moves[6].evalDrop!.evalDrop).toBe(70);
            expect(moves[6].evalDrop!.category).toBe('blunder');
        });

        it('stops analysis when opponent plays out of theory (>= 45cp drop)', async () => {
            // Game: 1. e4 e5 2. Nf3 d6 3. d4 Nf6?? 4. Nc3
            // Nf6 has a large opponent drop → out of theory, Nc3 is plain out-of-theory
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3 Be7', 'user', 'opp');

            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3']);
            const fenBeforeD4 = fens[4];
            const fenAfterD4 = fens[5];
            const fenBeforeNf6 = fens[5];
            const fenAfterNf6 = fens[6];

            const evals = makeEvals({
                [compact(fens[3])]: [50],        // after Nf3 (before d6) → opponent drop 0 (in theory)
                [compact(fenBeforeD4)]: [50],
                [compact(fenAfterD4)]: [45],     // user drop = 5cp (ok)
                [compact(fenBeforeNf6)]: [45],
                [compact(fenAfterNf6)]: [120],   // after Nf6: +1.20 → opp drop = 120-45 = 75cp (>= 45, out of theory!)
            });

            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');
            expect(result).not.toBeNull();
            const moves = result!.moves;

            // d4: first response
            expect(moves[4].highlight).toBe('out-of-repertoire-response');

            // Nf6: opponent out of theory → analysis stops
            expect(moves[5].highlight).toBe('out-of-theory');

            // Nc3: should be plain out-of-theory (NOT out-of-repertoire-response)
            expect(moves[6].highlight).toBe('out-of-theory');
        });

        it('stops analysis after first notable user eval drop', async () => {
            // d6 is in theory (small drop); the user's d4 inaccuracy then stops analysis.
            const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3 Be7', 'user', 'opp');

            const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3']);
            const fenBeforeD4 = fens[4];
            const fenAfterD4 = fens[5];
            const fenBeforeNc3 = fens[6];
            const fenAfterNc3 = fens[7];

            const evals = makeEvals({
                [compact(fens[3])]: [50],       // after Nf3 (before d6) → opponent drop 0 (in theory)
                [compact(fenBeforeD4)]: [50],
                [compact(fenAfterD4)]: [20],    // user drop = 30cp (inaccuracy)
                [compact(fenBeforeNc3)]: [10],
                [compact(fenAfterNc3)]: [-40],  // would be mistake, but analysis already stopped
            });

            const result = await annotateGame(gameData, 'user', repertoireFens, evals, 30, 'lichess');
            expect(result).not.toBeNull();
            const moves = result!.moves;

            // d4: first response, inaccuracy → triggers stop
            expect(moves[4].highlight).toBe('out-of-repertoire-response');
            expect(moves[4].evalDrop?.category).toBe('inaccuracy');

            // Nc3: analysis stopped after first notable drop, plain out-of-theory
            expect(moves[6].highlight).toBe('out-of-theory');
        });

        it('transposition back to repertoire resets post-theory analysis', async () => {
            // Repertoire: 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3
            const repFens = buildRepertoireFens([
                ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3'],
            ]);

            // Game: 1. d4 e6 (opp deviation) 2. c4 d5 (transposes back) 3. Nc3 Nf6 4. Bg5 Be7 5. e3
            // After transposition, we're back in theory; if user later deviates,
            // a new post-theory phase should start
            const gameData = makeGameData('d4 e6 c4 d5 Nc3 Nf6 Bg5 Be7 Bf4 a6', 'user', 'opp');
            // e6 is a small drop (in theory) so c4 opens a post-theory phase that
            // the transposition at d5 then resets.
            const fens = replayFens(['d4', 'e6', 'c4', 'd5']);
            const evals = makeEvals({
                [compact(fens[1])]: [20],  // after d4 (before e6)
                [compact(fens[2])]: [20],  // after e6 → opponent drop 0 (in theory)
                [compact(fens[3])]: [15],  // after c4 → user drop 5 (ok)
            });
            const result = await annotateGame(gameData, 'user', repFens, evals, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            // e6: opponent deviates but stays in theory
            expect(moves[1].highlight).toBe('out-of-repertoire');
            // c4: user response in post-theory
            expect(moves[2].highlight).toBe('out-of-repertoire-response');
            // d5: transposes back → post-theory resets
            expect(moves[3].highlight).toBe('in-repertoire');
            // Nc3, Nf6: in repertoire
            expect(moves[4].highlight).toBe('in-repertoire');
            expect(moves[5].highlight).toBe('in-repertoire');
            // Bg5, Be7: in repertoire
            expect(moves[6].highlight).toBe('in-repertoire');
            expect(moves[7].highlight).toBe('in-repertoire');
            // Bf4: user deviation (not in repertoire for position after Be7)
            expect(moves[8].highlight).toBe('deviation');
        });
    });

    describe('no repertoire overlap', () => {
        it('marks all moves as out-of-theory when starting position is not in repertoire', async () => {
            // Use an empty repertoire
            const emptyRep = new Set<string>();
            const gameData = makeGameData('e4 e5 Nf3 Nc6', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', emptyRep, null, 30, 'lichess');

            expect(result).not.toBeNull();
            for (const move of result!.moves) {
                expect(move.highlight).toBe('out-of-theory');
            }
        });
    });

    describe('playing as black', () => {
        it('correctly identifies user moves for black player', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6
            const blackRepMoves2 = ['e4', 'e5', 'Nf3', 'Nc6'];
            const blackRepFens2 = buildRepertoireFens([blackRepMoves2]);

            // Game: 1. e4 e5 2. Nf3 d5 (user deviates from Nc6 to d5)
            const gameData = makeGameData('e4 e5 Nf3 d5', 'opp', 'user');
            const result = await annotateGame(gameData, 'user', blackRepFens2, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[1].isUserMove).toBe(true);  // e5 — black/user
            expect(moves[1].highlight).toBe('in-repertoire');
            expect(moves[3].isUserMove).toBe(true);  // d5 — black/user deviated
            expect(moves[3].highlight).toBe('deviation');
        });

        it('evaluates user response after opponent deviation when playing black', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6
            const blackRepMoves = ['e4', 'e5', 'Nf3', 'Nc6'];
            const blackRepFens = buildRepertoireFens([blackRepMoves]);

            // Game: 1. e4 e5 2. d4 exd4 (opponent plays d4 instead of Nf3)
            const gameData = makeGameData('e4 e5 d4 exd4 Nf3', 'opp', 'user');
            // d4 is a small drop (in theory) so the user's recapture is analysed.
            const fens = replayFens(['e4', 'e5', 'd4', 'exd4']);
            const evals = makeEvals({
                [compact(fens[2])]: [20],  // after e5 (before d4)
                [compact(fens[3])]: [20],  // after d4 → opponent drop 0 (in theory)
                [compact(fens[4])]: [15],  // after exd4 → user drop 5 (ok)
            });
            const result = await annotateGame(gameData, 'user', blackRepFens, evals, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[1].highlight).toBe('in-repertoire'); // e5
            expect(moves[2].highlight).toBe('out-of-repertoire'); // d4 — opponent deviated but in theory
            expect(moves[2].isUserMove).toBe(false);
            expect(moves[3].highlight).toBe('out-of-repertoire-response');     // exd4 — user's response
            expect(moves[3].isUserMove).toBe(true);
        });
    });

    describe('transposition back to theory', () => {
        it('marks moves as in-repertoire when game transposes back to known position (QGD)', async () => {
            // QGD transposition:
            // Repertoire: 1. d4 d5 2. c4 e6 3. Nc3 Nf6
            // Game: 1. d4 e6 (opponent plays e6 instead of d5) 2. c4 d5 3. Nc3 Nf6
            // After 2...d5, the position equals repertoire after 2...e6 (chess.js doesn't
            // set en passant when no capture is possible), so transposition happens at d5.
            const repFens = buildRepertoireFens([
                ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'],
            ]);

            const gameData = makeGameData('d4 e6 c4 d5 Nc3 Nf6 Bg5', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // d4
            expect(moves[1].highlight).toBe('out-of-theory'); // e6 — opponent deviated, no eval → out of theory
            expect(moves[2].highlight).toBe('out-of-theory');     // c4 — post-theory stopped (no eval)
            // d5 reaches same position as repertoire after e6 (transposition!)
            expect(moves[3].highlight).toBe('in-repertoire'); // d5 — back in theory!
            expect(moves[4].highlight).toBe('in-repertoire'); // Nc3 — still in theory
            expect(moves[5].highlight).toBe('in-repertoire'); // Nf6 — still in theory
        });

        it('Sicilian transposition: opponent move transposes back to theory', async () => {
            // Repertoire: 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6
            // Game: 1. e4 c5 2. Nf3 e6 (opp deviation) 3. d4 cxd4 4. Nxd4 Nc6
            // After 4...Nc6 the position transposes to repertoire after 4...e6
            // (both have: Nd4+e4 for white, Nc6+e6 for black, no en passant)
            const repFens = buildRepertoireFens([
                ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'e6'],
            ]);

            const gameData = makeGameData('e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[1].highlight).toBe('in-repertoire'); // c5
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[3].highlight).toBe('out-of-theory'); // e6 — opponent deviated, no eval → out of theory
            expect(moves[4].highlight).toBe('out-of-theory');     // d4 — post-theory stopped (no eval)
            expect(moves[5].highlight).toBe('out-of-theory'); // cxd4 — opponent, out of theory
            expect(moves[6].highlight).toBe('out-of-theory'); // Nxd4 — user, out of theory
            // Nc6 transposes back! Same position as after 4...e6 in repertoire
            expect(moves[7].highlight).toBe('in-repertoire'); // Nc6 — transposition!
        });

        it('marks new deviation after transposition back to theory', async () => {
            // Repertoire: 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5
            // Game: 1. d4 e6 2. c4 d5 3. Nc3 Nf6 4. Bf4 (user plays Bf4 instead of Bg5)
            // Transposition happens at d5 (same position as rep after e6)
            const repFens = buildRepertoireFens([
                ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'],
            ]);

            const gameData = makeGameData('d4 e6 c4 d5 Nc3 Nf6 Bf4 Be7', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // d4
            expect(moves[1].highlight).toBe('out-of-theory'); // e6 — opponent deviated, no eval → out of theory
            expect(moves[2].highlight).toBe('out-of-theory');     // c4 — post-theory stopped (no eval)
            expect(moves[3].highlight).toBe('in-repertoire'); // d5 — transposition back!
            expect(moves[4].highlight).toBe('in-repertoire'); // Nc3 — in theory
            expect(moves[5].highlight).toBe('in-repertoire'); // Nf6 — in theory
            expect(moves[6].highlight).toBe('deviation');     // Bf4 — NEW deviation (Bg5 in rep)
            expect(moves[6].isUserMove).toBe(true);
        });

        it('user move that transposes back to theory is in-repertoire not deviation', async () => {
            // If after opponent deviation, user's response results in a repertoire position,
            // it should be in-repertoire (not deviation). Use synthetic FEN injection.
            const chess = new Chess();
            chess.move('e4'); chess.move('c5'); chess.move('Nf3');
            chess.move('a6'); // opponent deviation
            chess.move('d4'); // user response
            const fenAfterD4 = normalizeFenResetHalfmoveClock(chess.fen());

            // Build repertoire that includes positions up to Nf3
            const repFensCustom = buildRepertoireFens([['e4', 'c5', 'Nf3', 'd6', 'd4']]);
            // Manually add the FEN after d4 (simulating a transposition from another line)
            repFensCustom.add(fenAfterD4);

            const gameData = makeGameData('e4 c5 Nf3 a6 d4 cxd4', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repFensCustom, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[0].highlight).toBe('in-repertoire'); // e4
            expect(moves[1].highlight).toBe('in-repertoire'); // c5
            expect(moves[2].highlight).toBe('in-repertoire'); // Nf3
            expect(moves[3].highlight).toBe('out-of-theory'); // a6 — opponent deviated, no eval → out of theory
            // User's response (d4) lands in repertoire → in-repertoire, NOT deviation
            expect(moves[4].highlight).toBe('in-repertoire'); // d4 — transposed back!
            expect(moves[4].evalDrop).toBeUndefined();
        });

        it('consecutive out-of-theory moves are not marked as deviation', async () => {
            // After a deviation, subsequent moves out of theory are just out-of-theory
            const gameData = makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6 d3 d5 c3', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repertoireFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const moves = result!.moves;

            expect(moves[4].highlight).toBe('deviation');     // Bc4 — user deviated
            expect(moves[5].highlight).toBe('out-of-theory'); // Nf6 — NOT a new deviation
            expect(moves[6].highlight).toBe('out-of-theory'); // d3
            expect(moves[7].highlight).toBe('out-of-theory'); // d5
            expect(moves[8].highlight).toBe('out-of-theory'); // c3
        });

        it('mini board shows first deviation even when there are multiple', async () => {
            // Repertoire: 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5
            const repFens = buildRepertoireFens([
                ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'],
            ]);

            // Game: 1. d4 e6 2. c4 d5 3. Nc3 Nf6 4. Bf4 (deviation after transposition back)
            const gameData = makeGameData('d4 e6 c4 d5 Nc3 Nf6 Bf4 Be7', 'user', 'opp');
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            // Mini board should show position before first real deviation (Bf4),
            // which ranks higher than the earlier out-of-repertoire-response (c4)
            const fens = replayFens(['d4', 'e6', 'c4', 'd5', 'Nc3', 'Nf6']);
            expect(result!.miniBoardFen).toBe(fens[6]); // FEN before Bf4 (deviation.fen)
        });
    });

    describe('extractEmbeddedEvals', () => {
        it('returns null when gameData has no analysis array', async () => {
            const gameData = makeGameData('e4 e5', 'alice', 'bob');
            expect(extractEmbeddedEvals(gameData)).toBeNull();
        });

        it('returns null when analysis is empty', async () => {
            const gameData = { ...makeGameData('e4 e5', 'alice', 'bob'), analysis: [] };
            expect(extractEmbeddedEvals(gameData)).toBeNull();
        });

        it('extracts centipawn evals from analysis array', async () => {
            const gameData = {
                ...makeGameData('e4 e5', 'alice', 'bob'),
                analysis: [
                    { eval: 20 },
                    { eval: 15 },
                    { eval: -5 },
                ],
            };
            const lookup = extractEmbeddedEvals(gameData);
            expect(lookup).not.toBeNull();
            expect(lookup!(0)).toBe(20);
            expect(lookup!(1)).toBe(15);
            expect(lookup!(2)).toBe(-5);
            expect(lookup!(3)).toBeNull(); // out of bounds
        });

        it('converts mate entries to large cp values', async () => {
            const gameData = {
                ...makeGameData('e4 e5', 'alice', 'bob'),
                analysis: [
                    { mate: 3 },
                    { mate: -2 },
                ],
            };
            const lookup = extractEmbeddedEvals(gameData);
            expect(lookup).not.toBeNull();
            expect(lookup!(0)).toBe(10_000);
            expect(lookup!(1)).toBe(-10_000);
        });

        it('returns null for entries without eval or mate', async () => {
            const gameData = {
                ...makeGameData('e4 e5', 'alice', 'bob'),
                analysis: [
                    {},
                    { eval: 42 },
                ],
            };
            const lookup = extractEmbeddedEvals(gameData);
            expect(lookup).not.toBeNull();
            expect(lookup!(0)).toBeNull();
            expect(lookup!(1)).toBe(42);
        });
    });

    describe('embedded eval fallback in annotation', () => {
        it('uses embedded evals when ExplorerEvals has no data for the position', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6
            const repFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

            // Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4 (user deviation at ply 4)
            // Lichess analysis[i] = eval of position AFTER ply i.
            // For Bc4 at ply 4: before = analysis[3], after = analysis[4]
            const analysis = [
                { eval: 20 },   // ply 0: after e4
                { eval: 15 },   // ply 1: after e5
                { eval: 30 },   // ply 2: after Nf3
                { eval: 25 },   // ply 3: after Nc6 (= before Bc4)
                { eval: -10 },  // ply 4: after Bc4
                { eval: 5 },    // ply 5: after Nf6
            ];

            const gameData = {
                ...makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6', 'user', 'opp'),
                analysis,
            };

            // No ExplorerEvals → forces fallback to embedded
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            // Bc4 is at index 4 (ply 4), which is a user deviation
            const bc4Move = result!.moves[4];
            expect(bc4Move.san).toBe('Bc4');
            expect(bc4Move.highlight).toBe('deviation');
            expect(bc4Move.evalDrop).toBeDefined();
            expect(bc4Move.evalSource).toBe('embedded');
            // White move: drop = before - after = 25 - (-10) = 35
            expect(bc4Move.evalDrop!.evalDrop).toBe(35);
            expect(bc4Move.evalDrop!.category).toBe('inaccuracy');
        });

        it('prefers ExplorerEvals over embedded evals', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6
            const repFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

            const fens = replayFens(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);

            // Build ExplorerEvals with data for positions before/after Bc4
            const evalsData: Record<string, number[]> = {};
            evalsData[compact(fens[4])] = [30, 28]; // before Bc4
            evalsData[compact(fens[5])] = [15, 12]; // after Bc4
            const explorerEvals = makeEvals(evalsData);

            // Also provide embedded evals (should be ignored since explorer has data)
            // Lichess analysis[i] = eval after ply i
            const analysis = [
                { eval: 20 },
                { eval: 25 },
                { eval: 20 },
                { eval: 99 },   // Different from explorer — should NOT be used
                { eval: -99 },
                { eval: 10 },
            ];

            const gameData = {
                ...makeGameData('e4 e5 Nf3 Nc6 Bc4 Nf6', 'user', 'opp'),
                analysis,
            };

            const result = await annotateGame(gameData, 'user', repFens, explorerEvals, 30, 'lichess');

            expect(result).not.toBeNull();
            const bc4Move = result!.moves[4];
            expect(bc4Move.san).toBe('Bc4');
            expect(bc4Move.evalSource).toBe('explorer');
            // Explorer vals: before [30, 28], after [15, 12]
            // Conservative (min) drop: min(30-15, 30-12, 28-15, 28-12) = min(15, 18, 13, 16) = 13
            expect(bc4Move.evalDrop!.evalDrop).toBe(13);
        });

        it('uses embedded evals for out-of-repertoire-response moves', async () => {
            // Repertoire: 1. e4 e5 2. Nf3 Nc6
            const repFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

            // Game: 1. e4 e5 2. Nf3 Nc6 3. d4 (opponent deviation) 3... d5 (user response)
            // User is Black here. d5 is at ply 5.
            // Lichess analysis[i] = eval after ply i.
            // For d5 at ply 5: before = analysis[4], after = analysis[5]
            const analysis = [
                { eval: 20 },   // ply 0: after e4
                { eval: 15 },   // ply 1: after e5
                { eval: 30 },   // ply 2: after Nf3
                { eval: 25 },   // ply 3: after Nc6
                { eval: 40 },   // ply 4: after d4 (= before d5)
                { eval: 35 },   // ply 5: after d5
            ];

            const gameData = {
                ...makeGameData('e4 e5 Nf3 Nc6 d4 d5', 'opp', 'user'),
                analysis,
            };

            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            // d5 is ply 5 (index 5), user is Black
            const d5Move = result!.moves[5];
            expect(d5Move.san).toBe('d5');
            expect(d5Move.highlight).toBe('out-of-repertoire-response');
            expect(d5Move.evalDrop).toBeDefined();
            expect(d5Move.evalSource).toBe('embedded');
            // Black move: drop = after - before = 35 - 40 = -5 (negative = gained eval)
            expect(d5Move.evalDrop!.evalDrop).toBe(-5);
            expect(d5Move.evalDrop!.category).toBe('ok');
        });
    });

    describe('ambiguous theory zone (masters lookup)', () => {
        // Repertoire: 1. e4 e5 2. Nf3 Nc6
        // User is White. Opponent is Black.
        // Opponent plays 2... d6 instead of 2... Nc6 — leaving repertoire.
        // The embedded evals will give different drops to test the three zones.
        const repFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

        function makeGameWithOppDrop(oppDropCp: number) {
            // Game: 1. e4 e5 2. Nf3 d6 (opponent deviation) 3. d4 d5 (user continues)
            // User is White. Opponent deviates at ply 3 (d6).
            // Embedded evals: analysis[i] = eval after ply i (White's perspective).
            // For d6 at ply 3: before = analysis[2], after = analysis[3]
            // White move ply 3 → drop = before - after  ... wait, ply 3 is Black's move
            // Black move: drop = after - before (from mover's perspective)
            // But computeConservativeDrop for opponent's perspective:
            //   isWhiteMove = false → drop = after - before
            // We want oppDrop (positive = opponent lost eval = bad for opponent = good for user)
            // For a Black move: drop = after - before. If after > before, drop is positive = Black lost eval.
            // So: set before = 30, after = 30 + oppDropCp
            const beforeCp = 30;
            const afterCp = beforeCp + oppDropCp;

            const analysis = [
                { eval: 20 },       // ply 0: after e4
                { eval: 15 },       // ply 1: after e5
                { eval: beforeCp }, // ply 2: after Nf3 (= before d6)
                { eval: afterCp },  // ply 3: after d6 (= after d6)
                { eval: afterCp },  // ply 4: after d4
                { eval: afterCp },  // ply 5: after d5
            ];

            return {
                ...makeGameData('e4 e5 Nf3 d6 d4 d5', 'user', 'opp'),
                analysis,
            };
        }

        it('drop < 15 → opponent move is out-of-repertoire (in theory)', async () => {
            const gameData = makeGameWithOppDrop(10); // 10cp < 15cp threshold
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const d6Move = result!.moves[3]; // ply 3
            expect(d6Move.san).toBe('d6');
            expect(d6Move.highlight).toBe('out-of-repertoire');
        });

        it('drop >= 45 → opponent move is out-of-theory', async () => {
            const gameData = makeGameWithOppDrop(50); // 50cp >= 45cp threshold
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const d6Move = result!.moves[3];
            expect(d6Move.san).toBe('d6');
            expect(d6Move.highlight).toBe('out-of-theory');
        });

        it('drop 15-44 without masters data → out-of-repertoire (optimistic default)', async () => {
            const gameData = makeGameWithOppDrop(30); // 30cp, in ambiguous zone
            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess');

            expect(result).not.toBeNull();
            const d6Move = result!.moves[3];
            expect(d6Move.san).toBe('d6');
            expect(d6Move.highlight).toBe('out-of-repertoire'); // optimistic default
        });

        it('drop 15-44 with masters data showing rare move → out-of-theory', async () => {
            const gameData = makeGameWithOppDrop(30);

            // Masters data: d6 has only 2 games (< 5 threshold)
            const lookup = new MastersLookup();
            const fens = replayFens(['e4', 'e5', 'Nf3']);
            const fenBeforeD6 = fens[fens.length - 1]; // after Nf3, before d6
            lookup.add(fenBeforeD6, {
                fen: fenBeforeD6,
                totalGames: 200,
                moves: [
                    { san: 'Nc6', white: 100, draws: 50, black: 48, total: 198 },
                    { san: 'd6', white: 1, draws: 0, black: 1, total: 2 }, // < 5 games
                ],
            });

            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess', lookup);

            expect(result).not.toBeNull();
            const d6Move = result!.moves[3];
            expect(d6Move.highlight).toBe('out-of-theory');
        });

        it('drop 15-44 with masters data showing low percentage → out-of-theory', async () => {
            const gameData = makeGameWithOppDrop(25);

            const lookup = new MastersLookup();
            const fens = replayFens(['e4', 'e5', 'Nf3']);
            const fenBeforeD6 = fens[fens.length - 1];
            lookup.add(fenBeforeD6, {
                fen: fenBeforeD6,
                totalGames: 200,
                moves: [
                    { san: 'Nc6', white: 100, draws: 50, black: 42, total: 192 },
                    { san: 'd6', white: 3, draws: 2, black: 3, total: 8 }, // 8/200 = 4% < 5%
                ],
            });

            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess', lookup);

            expect(result).not.toBeNull();
            const d6Move = result!.moves[3];
            expect(d6Move.highlight).toBe('out-of-theory');
        });

        it('drop 15-44 with masters data showing common move → out-of-repertoire (in theory)', async () => {
            const gameData = makeGameWithOppDrop(25);

            const lookup = new MastersLookup();
            const fens = replayFens(['e4', 'e5', 'Nf3']);
            const fenBeforeD6 = fens[fens.length - 1];
            lookup.add(fenBeforeD6, {
                fen: fenBeforeD6,
                totalGames: 200,
                moves: [
                    { san: 'Nc6', white: 80, draws: 40, black: 30, total: 150 },
                    { san: 'd6', white: 20, draws: 15, black: 15, total: 50 }, // 50/200 = 25% > 5%
                ],
            });

            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess', lookup);

            expect(result).not.toBeNull();
            const d6Move = result!.moves[3];
            expect(d6Move.highlight).toBe('out-of-repertoire');
        });

        it('out-of-theory from masters stops post-theory analysis', async () => {
            // Game: 1. e4 e5 2. Nf3 d6 3. d4 d5
            // If d6 is out-of-theory via masters, then d4 and d5 should also be out-of-theory
            const gameData = makeGameWithOppDrop(30);

            const lookup = new MastersLookup();
            const fens = replayFens(['e4', 'e5', 'Nf3']);
            const fenBeforeD6 = fens[fens.length - 1];
            lookup.add(fenBeforeD6, {
                fen: fenBeforeD6,
                totalGames: 100,
                moves: [
                    { san: 'Nc6', white: 50, draws: 30, black: 20, total: 100 },
                    // d6 not in masters at all → 0 games
                ],
            });

            const result = await annotateGame(gameData, 'user', repFens, null, 30, 'lichess', lookup);

            expect(result).not.toBeNull();
            // d6 → out-of-theory (masters)
            expect(result!.moves[3].highlight).toBe('out-of-theory');
            // d4 → out-of-theory (analysis stopped)
            expect(result!.moves[4].highlight).toBe('out-of-theory');
            // d5 → out-of-theory (analysis stopped)
            expect(result!.moves[5].highlight).toBe('out-of-theory');
        });
    });
});

describe('annotateGame — on-demand cloud-eval resolution', () => {
    // Repertoire: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (Ruy Lopez), user is white.
    const repertoireFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']]);
    // Game: opponent deviates with 3...d6, user plays on and blunders 4. Nc3.
    const gameData = makeGameData('e4 e5 Nf3 d6 d4 Nf6 Nc3', 'user', 'opp');
    const fens = replayFens(['e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3']);
    const fenAfterNc3 = fens[7]; // the gap — eval present nowhere but cloud

    // Every position the engine wants EXCEPT the user's blunder after-FEN.
    const partialEvals = makeEvals({
        [compact(fens[3])]: [50],  // after Nf3
        [compact(fens[4])]: [50],  // after d6  → d6 opp drop 0 (in theory)
        [compact(fens[5])]: [45],  // after d4  → d4 user drop 5 (ok)
        [compact(fens[6])]: [40],  // after Nf6 → Nf6 opp drop -5 (in theory)
        // fens[7] (after Nc3) intentionally absent
    });

    it('leaves the user move uncolored when no source (incl. cloud) has the after-FEN', async () => {
        // No cloud provider — the engine's optimistic in-theory default, as
        // before cloud existed: the blunder can't be categorized without an eval.
        const result = await annotateGame(gameData, 'user', repertoireFens, partialEvals, 30, 'lichess');
        expect(result).not.toBeNull();
        expect(result!.moves[6].highlight).toBe('out-of-repertoire-response');
        expect(result!.moves[6].evalDrop).toBeUndefined();
    });

    it('resolves the gap from the cloud provider on demand and colors the user move a blunder (mixed explorer/cloud source)', async () => {
        // The engine awaits this only for the one side the static sources miss.
        const queried: string[] = [];
        const cloudEval = async (fen: string): Promise<number[] | null> => {
            queried.push(fen);
            return fen === fenAfterNc3 ? [-30] : null;
        };
        const result = await annotateGame(
            gameData, 'user', repertoireFens, partialEvals, 30, 'lichess',
            undefined, undefined, cloudEval,
        );
        expect(result).not.toBeNull();
        // before=explorer (+0.40), after=cloud (-0.30) → white drop 70 → blunder.
        expect(result!.moves[6].highlight).toBe('out-of-repertoire-response');
        expect(result!.moves[6].evalDrop!.evalDrop).toBe(70);
        expect(result!.moves[6].evalDrop!.category).toBe('blunder');
        expect(result!.moves[6].evalSource).toBe('cloud');
        // The provider was consulted only for the missing after-FEN, never for
        // the settled tail (the walk stops at the user's first notable drop).
        expect(queried).toEqual([fenAfterNc3]);
    });
});
