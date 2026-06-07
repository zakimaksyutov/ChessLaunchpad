import { Annotation } from '../models/Annotation';
import { FSRSCardData } from '../models/FSRSCardData';
import { RepertoireEntry } from '../models/Repertoires';
import { FSRSService } from '../services/FSRSService';
import { isUserTurnForOrientation } from './FenUtils';

/**
 * Project the in-memory state back into the persistence shape — i.e. refresh
 * every `moves[san].card` from the current `fsrsCards` flat map, preserving
 * existing annotations and the shape's structure.
 *
 * The flat map is the in-memory authority for cards (FSRSService mutates it),
 * so on save we sync it back into `repertoires` before serializing.
 *
 * If a user-turn card key is present in `fsrsCards` but the corresponding
 * `moves[san]` entry is missing (shouldn't normally happen — graph and
 * repertoires are kept consistent), nothing is added — orphan cards are
 * silently dropped during projection.
 *
 * Opponent moves are left as `{}` (no card attached).
 */
export function projectFsrsCardsIntoRepertoires(
    repertoires: RepertoireEntry[],
    fsrsCards: Record<string, FSRSCardData>,
): void {
    for (const rep of repertoires) {
        for (const [fen, pos] of Object.entries(rep.positions)) {
            const isUserHere = isUserTurnForOrientation(fen, rep.orientation);
            for (const [san, move] of Object.entries(pos.moves)) {
                if (!isUserHere) {
                    delete move.card;
                    continue;
                }
                const key = FSRSService.makeCardKey(fen, san);
                const card = fsrsCards[key];
                if (card) {
                    move.card = card;
                } else {
                    delete move.card;
                }
            }
        }
    }
}

/**
 * Hydrate a flat `Record<cardKey, FSRSCardData>` view from the position dict.
 * The values are the same object references that live inside the dict, so
 * mutations through the flat map are visible to anyone holding the dict — but
 * `FSRSService.rateCard` REPLACES entries (it doesn't mutate in-place), so on
 * save we re-project the flat map back into the dict via
 * `projectFsrsCardsIntoRepertoires` to guarantee consistency.
 */
export function extractFsrsCardsFromRepertoires(
    repertoires: RepertoireEntry[],
): Record<string, FSRSCardData> {
    const out: Record<string, FSRSCardData> = {};
    for (const rep of repertoires) {
        for (const [fen, pos] of Object.entries(rep.positions)) {
            if (!isUserTurnForOrientation(fen, rep.orientation)) continue;
            for (const [san, move] of Object.entries(pos.moves)) {
                if (move.card) {
                    out[FSRSService.makeCardKey(fen, san)] = move.card;
                }
            }
        }
    }
    return out;
}

/** Per-orientation map of position-FEN → annotations (no cross-orientation merge). */
export function extractAnnotationsFromRepertoires(
    repertoires: RepertoireEntry[],
): Record<'white' | 'black', Map<string, Annotation[]>> {
    const result: Record<'white' | 'black', Map<string, Annotation[]>> = {
        white: new Map(),
        black: new Map(),
    };
    for (const rep of repertoires) {
        for (const [fen, pos] of Object.entries(rep.positions)) {
            if (pos.annotations && pos.annotations.length > 0) {
                result[rep.orientation].set(fen, pos.annotations);
            }
        }
    }
    return result;
}

/**
 * Strip empty-annotation arrays so they aren't sent over the wire and don't
 * inflate the persisted blob. Mutates in place.
 */
export function pruneEmptyAnnotations(repertoires: RepertoireEntry[]): void {
    for (const rep of repertoires) {
        for (const pos of Object.values(rep.positions)) {
            if (pos.annotations && pos.annotations.length === 0) {
                delete pos.annotations;
            }
        }
    }
}
