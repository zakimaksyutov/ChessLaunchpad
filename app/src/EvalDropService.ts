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
 * Compute the conservative (user-favoring) eval drop from two arrays of
 * centipawn values. When multiple stored evals exist for a position, the
 * values may disagree due to Stockfish depth/version differences. Rather
 * than picking one arbitrarily, we evaluate all before×after pairings and
 * return the **minimum** mover-perspective drop — i.e., the pairing that
 * is most favorable to the user.
 *
 * All evals are from White's perspective:
 * - White move: drop = before − after  (positive = White lost eval)
 * - Black move: drop = after − before  (positive = Black lost eval)
 */
export function computeConservativeDrop(
    beforeVals: number[],
    afterVals: number[],
    isWhiteMove: boolean
): number {
    let minDrop = Infinity;
    for (const b of beforeVals) {
        for (const a of afterVals) {
            const drop = isWhiteMove ? b - a : a - b;
            if (drop < minDrop) minDrop = drop;
        }
    }
    return minDrop;
}

/**
 * Compute eval drops for every half-move in a PGN.
 *
 * Returns a Map keyed by the full FEN *after* each move → EvalDrop.
 * Only moves where both the "before" and "after" positions have evals
 * are included. Moves with missing eval data are silently skipped.
 *
 * When multiple eval values are stored per position, the conservative
 * (minimum) drop across all pairings is used to avoid false-positive
 * highlights from eval instability.
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
            const beforeVals = evals.lookupAll(prevFen);
            const afterVals = evals.lookupAll(afterFen);

            if (beforeVals !== null && afterVals !== null
                && beforeVals.length > 0 && afterVals.length > 0) {
                const drop = computeConservativeDrop(beforeVals, afterVals, isWhiteMove);

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
