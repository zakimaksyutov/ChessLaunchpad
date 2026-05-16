import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { OpeningVariantData } from './RepertoireData';

/**
 * Builds two Set<string> of normalized FENs from repertoire data:
 * one for white variants, one for black variants.
 *
 * Each variant's PGN is replayed with chess.js and every resulting
 * position is normalized (halfmove=0, fullmove=1) so transpositions
 * match.
 */
export interface RepertoireFenSets {
    whiteFens: Set<string>;
    blackFens: Set<string>;
}

export function buildRepertoireFenSets(variants: OpeningVariantData[]): RepertoireFenSets {
    const whiteFens = new Set<string>();
    const blackFens = new Set<string>();

    for (const variant of variants) {
        const chess = new Chess();
        try {
            chess.loadPgn(variant.pgn);
        } catch {
            continue;
        }
        chess.deleteComments();

        const moves = chess.history({ verbose: true });
        const temp = new Chess();
        const target = variant.orientation === 'white' ? whiteFens : blackFens;
        target.add(normalizeFenResetHalfmoveClock(temp.fen()));

        for (const move of moves) {
            temp.move(move);
            target.add(normalizeFenResetHalfmoveClock(temp.fen()));
        }
    }

    return { whiteFens, blackFens };
}
