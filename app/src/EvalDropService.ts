import { Chess } from 'chess.js';
import { ExplorerEvals } from './ExplorerEvals';

export type EvalDropCategory = 'ok' | 'inaccuracy' | 'mistake' | 'blunder';

export interface EvalDrop {
    /** Eval drop in centipawns (positive = the mover lost eval). */
    evalDrop: number;
    category: EvalDropCategory;
}

/** Thresholds in centipawns. */
const INACCURACY_THRESHOLD = 30;
const MISTAKE_THRESHOLD = 50;
const BLUNDER_THRESHOLD = 70;

export function categorizeEvalDrop(drop: number): EvalDropCategory {
    if (drop >= BLUNDER_THRESHOLD) return 'blunder';
    if (drop >= MISTAKE_THRESHOLD) return 'mistake';
    if (drop >= INACCURACY_THRESHOLD) return 'inaccuracy';
    return 'ok';
}

/**
 * Compute eval drops for every half-move in a PGN.
 *
 * Returns a Map keyed by the full FEN *after* each move → EvalDrop.
 * Only moves where both the "before" and "after" positions have evals
 * are included. Moves with missing eval data are silently skipped.
 *
 * @param pgn       The PGN string (may include comments, which are stripped).
 * @param evals     The ExplorerEvals lookup instance.
 * @param orientation  'white' or 'black' — only the user's own moves are evaluated.
 */
export function computeEvalDrops(
    pgn: string,
    evals: ExplorerEvals,
    orientation: 'white' | 'black'
): Map<string, EvalDrop> {
    const result = new Map<string, EvalDrop>();

    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        return result;
    }
    chess.deleteComments();

    const moves = chess.history({ verbose: true });

    // Undo all moves to get the game's actual starting position.
    // This correctly handles PGNs with [FEN "..."] headers.
    while (chess.undo()) { /* undo all */ }
    let prevFen = chess.fen();

    for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        const isWhiteMove = i % 2 === 0;
        const isUserMove =
            (orientation === 'white' && isWhiteMove) ||
            (orientation === 'black' && !isWhiteMove);

        try {
            chess.move(move);
        } catch {
            break; // Shouldn't happen, but be safe
        }
        const afterFen = chess.fen();

        if (isUserMove) {
            const evalBefore = evals.lookup(prevFen);
            const evalAfter = evals.lookup(afterFen);

            if (evalBefore !== null && evalAfter !== null) {
                // Evals are from White's perspective.
                // For White: drop = evalBefore - evalAfter (positive = White lost eval)
                // For Black: drop = evalAfter - evalBefore (positive = Black lost eval,
                //            i.e. the position got better for White after Black's move)
                const drop = isWhiteMove
                    ? evalBefore - evalAfter
                    : evalAfter - evalBefore;

                result.set(afterFen, {
                    evalDrop: drop,
                    category: categorizeEvalDrop(drop),
                });
            }
        }

        prevFen = afterFen;
    }

    return result;
}
