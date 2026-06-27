import { Chess } from 'chess.js';
import { PendingDelta, EditChain } from '../services/PendingEditModel';
import { Annotation } from '../models/Annotation';

/**
 * True iff the pending delta is exactly one added line and nothing else —
 * one added chain, no removed chains, no annotation edits. This is the
 * common "new user adds a single suggested line" case the Review view
 * optimizes for with an animated big-board preview. Any other shape
 * (multiple added chains, deletions, annotation edits) falls back to the
 * standard chain-tile experience.
 */
export function isSingleAddedLine(delta: PendingDelta): boolean {
    return (
        delta.addedChains.length === 1 &&
        delta.removedChains.length === 0 &&
        delta.editedAnnotations.length === 0
    );
}

/** A precomputed animation of an added line, ready for the looping board. */
export interface AddedLineFrames {
    /**
     * Real chess.js FENs, one per board state, starting at the anchor
     * (`head.from`, already in the repertoire) and ending at the final added
     * position. `frames[i]` and `frames[i+1]` are exactly one legal move
     * apart, so `ChessboardControl` glides between them.
     */
    frames: string[];
    /**
     * Green arrow for the move that produced each frame. `arrows[0]` is null
     * (the anchor has no incoming move); `arrows[i]` (i ≥ 1) highlights the
     * ply that led to `frames[i]`.
     */
    arrows: (Annotation | null)[];
}

/**
 * Build the animation frames for an added chain by replaying its SANs through
 * a single chess.js instance from the chain's anchor position.
 *
 * Why replay instead of using the chain's stored `from`/`to` FENs: those FENs
 * have their halfmove clock zeroed (`normalizeFenResetHalfmoveClock`), so
 * `ChessboardControl.detectMove` — which compares against a freshly-played
 * `chess.fen()` carrying real clocks — would fail to match them and skip the
 * glide. Frames produced here carry real clocks and are guaranteed to be the
 * exact strings `detectMove` reconstructs, so every ply animates.
 *
 * Returns null if the chain's parent PGN or any SAN fails to replay (the
 * caller then falls back to the non-animated experience).
 */
export function buildAddedLineFrames(chain: EditChain): AddedLineFrames | null {
    const sans = [chain.head.san, ...chain.tail.map(e => e.san)];
    if (sans.length === 0) return null;

    const chess = new Chess();
    if (chain.parentPgn) {
        try {
            chess.loadPgn(chain.parentPgn);
        } catch {
            return null;
        }
    }

    const frames: string[] = [chess.fen()];
    const arrows: (Annotation | null)[] = [null];

    for (const san of sans) {
        let move;
        try {
            move = chess.move(san);
        } catch {
            return null;
        }
        if (!move) return null;
        frames.push(chess.fen());
        arrows.push({ brush: 'G', orig: move.from, dest: move.to });
    }

    return { frames, arrows };
}
