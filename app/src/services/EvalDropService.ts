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
