import { describe, it, expect } from 'vitest';
import { deriveEotPositions, annotateGame, type GameAnnotation } from '../services/GameAnnotationService';
import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { ExplorerEvals } from '../models/ExplorerEvals';

/**
 * Helper: build a Lichess-style game data object from a move string and player names.
 */
function makeGameData(
    moves: string,
    whiteId: string,
    blackId: string,
    analysis?: Array<Record<string, unknown>>
): Record<string, unknown> {
    return {
        id: 'testgame',
        moves,
        players: {
            white: { user: { id: whiteId } },
            black: { user: { id: blackId } },
        },
        ...(analysis ? { analysis } : {}),
    };
}

/**
 * Build repertoire FENs from move sequences.
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
 * Helper: replay a move sequence and return evals for each ply (from White's perspective).
 * Returns an analysis array compatible with Lichess embedded evals.
 */
function makeAnalysis(evalValues: number[]): Array<Record<string, unknown>> {
    return evalValues.map(v => ({ eval: v }));
}

describe('deriveEotPositions', () => {
    it('returns null when there is no out-of-repertoire-response with eval drop', () => {
        // Game: e4 e5 Nf3 Nc6 — fully in repertoire
        const moves = 'e4 e5 Nf3 Nc6';
        const gameData = makeGameData(moves, 'me', 'opp');
        const repertoire = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

        const annotation = annotateGame(gameData, 'me', repertoire, null, 30, 'lichess');
        expect(annotation).not.toBeNull();

        const result = deriveEotPositions(gameData, annotation!, 'me', 'lichess');
        expect(result).toBeNull();
    });

    it('returns correct FENs and SANs for a known blunder position', () => {
        // Repertoire: e4 e5 Nf3 Nc6. Opponent plays d6 instead of Nc6 (out of repertoire).
        // We need embedded evals to detect the eval drop on user's response.
        //
        // Game: 1.e4 e5 2.Nf3 d6 3.d4 Nf6 4.dxe5
        // Repertoire knows: e4 e5 Nf3 Nc6
        // At ply 3 (d6), opponent deviates from repertoire.
        // At ply 4 (d4), user responds — this is the "out-of-repertoire-response".
        //
        // We'll set embedded evals so d4 looks like a blunder (large drop).
        const moves = 'e4 e5 Nf3 d6 d4 Nf6 dxe5';
        const repertoire = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

        // Embedded evals (from White's perspective): eval AFTER each ply
        // ply 0 (e4): +30, ply 1 (e5): +30, ply 2 (Nf3): +35, ply 3 (d6): +35
        // ply 4 (d4): -40 (blunder!), ply 5 (Nf6): -40, ply 6 (dxe5): +50
        const analysis = makeAnalysis([30, 30, 35, 35, -40, -40, 50]);
        const gameData = makeGameData(moves, 'me', 'opp', analysis);

        const annotation = annotateGame(gameData, 'me', repertoire, null, 30, 'lichess');
        expect(annotation).not.toBeNull();

        // d4 at ply 4 should be out-of-repertoire-response with a blunder eval drop
        // eval before d4 (ply 3) = 35, eval after d4 (ply 4) = -40
        // drop for White = 35 - (-40) = 75 → blunder
        const eotMove = annotation!.moves.find(
            m => m.highlight === 'out-of-repertoire-response' && m.evalDrop && m.evalDrop.category !== 'ok'
        );
        expect(eotMove).toBeDefined();
        expect(eotMove!.san).toBe('d4');
        expect(eotMove!.evalDrop!.category).toBe('blunder');

        const result = deriveEotPositions(gameData, annotation!, 'me', 'lichess');
        expect(result).not.toBeNull();
        expect(result!.userSan).toBe('d4');
        expect(result!.opponentSan).toBe('d6');
        expect(result!.userMoveCategory).toBe('blunder');
        expect(result!.targetPly).toBe(4); // ply index of d4

        // Verify FENs are correct by replaying
        const chess = new Chess();
        chess.move('e4'); chess.move('e5'); chess.move('Nf3'); chess.move('d6');
        const expectedFenBefore = normalizeFenResetHalfmoveClock(chess.fen());
        chess.move('d4');
        const expectedFenAfter = normalizeFenResetHalfmoveClock(chess.fen());

        expect(result!.fenBefore).toBe(expectedFenBefore);
        expect(result!.fenAfter).toBe(expectedFenAfter);
    });

    it('returns correct result when playing as Black', () => {
        // User is Black. Repertoire: e4 c5 Nf3.
        // Opponent (White) plays d4 instead of Nf3 at ply 2.
        // User's response at ply 3: d5 with a large eval drop.
        const moves = 'e4 c5 d4 d5';
        const repertoire = buildRepertoireFens([['e4', 'c5', 'Nf3']]);

        // Embedded evals: ply 0 (e4): +30, ply 1 (c5): +30, ply 2 (d4): +30, ply 3 (d5): +90
        // For Black: drop = afterCp - beforeCp = 90 - 30 = 60 → mistake
        const analysis = makeAnalysis([30, 30, 30, 90]);
        const gameData = makeGameData(moves, 'opp', 'me', analysis);

        const annotation = annotateGame(gameData, 'me', repertoire, null, 30, 'lichess');
        expect(annotation).not.toBeNull();

        const result = deriveEotPositions(gameData, annotation!, 'me', 'lichess');
        expect(result).not.toBeNull();
        expect(result!.userSan).toBe('d5');
        expect(result!.opponentSan).toBe('d4');
        expect(result!.userMoveCategory).toBe('mistake');
        expect(result!.targetPly).toBe(3);
    });
});
