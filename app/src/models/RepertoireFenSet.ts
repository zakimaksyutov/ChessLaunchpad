import { RepertoireEntry } from './Repertoires';

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

export function buildRepertoireFenSets(repertoires: RepertoireEntry[] | undefined): RepertoireFenSets {
    const whiteFens = new Set<string>();
    const blackFens = new Set<string>();

    for (const rep of repertoires ?? []) {
        const target = rep.orientation === 'white' ? whiteFens : blackFens;
        for (const fen of Object.keys(rep.positions)) {
            target.add(fen);
        }
    }

    return { whiteFens, blackFens };
}
