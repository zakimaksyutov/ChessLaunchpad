import { RepertoireEntry } from './Repertoires';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';

/**
 * Builds two Set<string> of normalized FENs from the in-memory `repertoires`
 * shape: one for the white orientation, one for the black orientation.
 *
 * The position keys in each repertoire's dict are already normalized FENs
 * (halfmove=0, fullmove=1) — no extra walking required.
 */
export interface RepertoireFenSets {
    whiteFens: Set<string>;
    blackFens: Set<string>;
}

/**
 * The standard starting position, normalized the same way the annotation walk
 * normalizes the FENs it compares against (halfmove=0, fullmove=1).
 */
export const INITIAL_POSITION_FEN = normalizeFenResetHalfmoveClock(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
);

/**
 * @param seedInitialPosition When true, treat the starting position as "book"
 *   by adding it to both orientation sets. The /games annotation walk uses this
 *   so a game can be graded from move 1 even when the user's repertoire doesn't
 *   cover (or hasn't yet been built for) that opening — the start position
 *   anchors the walk, letting move 1 be classified as a deviation / post-theory
 *   response instead of an immediate out-of-theory stop. Ingest does NOT seed it
 *   (it would mis-count an empty-repertoire move 1 as a deviation/mistake).
 */
export function buildRepertoireFenSets(
    repertoires: RepertoireEntry[] | undefined,
    options?: { seedInitialPosition?: boolean },
): RepertoireFenSets {
    const whiteFens = new Set<string>();
    const blackFens = new Set<string>();

    if (options?.seedInitialPosition) {
        whiteFens.add(INITIAL_POSITION_FEN);
        blackFens.add(INITIAL_POSITION_FEN);
    }

    for (const rep of repertoires ?? []) {
        const target = rep.orientation === 'white' ? whiteFens : blackFens;
        for (const fen of Object.keys(rep.positions)) {
            target.add(fen);
        }
    }

    return { whiteFens, blackFens };
}
