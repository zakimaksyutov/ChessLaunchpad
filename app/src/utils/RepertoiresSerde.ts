import { Chess } from 'chess.js';
import { Annotation } from '../models/Annotation';
import { FSRSCardData } from '../models/FSRSCardData';
import {
    RepertoireEntry,
    createEmptyRepertoires,
    findRepertoire,
} from '../models/Repertoires';
import { OpeningVariantData } from '../models/RepertoireData';
import { FSRSService } from '../services/FSRSService';
import {
    normalizeFenResetHalfmoveClock,
    isUserTurnForOrientation,
} from './FenUtils';
import { extractAnnotations } from './AnnotationUtils';

/**
 * One-time migration. Walks every legacy variant PGN, builds the position
 * dict per orientation, places FSRS cards on user-turn moves and `{}` on
 * opponent moves, and preserves PGN-comment annotations (arrows AND squares).
 *
 * v1 invariant: always returns exactly two entries (White, Black), both
 * always present, even when one has zero positions.
 *
 * Note: this never mutates the inputs and never overwrites a card key with a
 * fresh empty card — if the same edge appears in both repertoires (a shared
 * line), its card lives only on the orientation whose user turn it is.
 */
export function bootstrapRepertoiresFromLegacy(
    legacyVariants: OpeningVariantData[],
    legacyFsrsCards: Record<string, FSRSCardData>,
): RepertoireEntry[] {
    const repertoires = createEmptyRepertoires();

    for (const variant of legacyVariants) {
        const rep = findRepertoire(repertoires, variant.orientation);
        if (!rep) continue;

        let chess: Chess;
        try {
            chess = new Chess();
            chess.loadPgn(variant.pgn);
        } catch {
            continue;
        }

        // Capture annotations BEFORE deleting comments — chess.js' history
        // is move-based and unaffected, but comments are stored separately.
        const commentByFen = new Map<string, Annotation[]>();
        for (const c of chess.getComments()) {
            // Keep both arrows and squares — squares were dropped by the
            // Explorer's collectAnnotations (which is read-only) but they are
            // legitimate position-level annotations per the spec.
            const anns = extractAnnotations(c.comment);
            if (anns.length === 0) continue;
            const normFen = normalizeFenResetHalfmoveClock(c.fen);
            const existing = commentByFen.get(normFen) ?? [];
            for (const ann of anns) {
                const dup = existing.find(
                    e => e.brush === ann.brush && e.orig === ann.orig && e.dest === ann.dest,
                );
                if (!dup) existing.push(ann);
            }
            commentByFen.set(normFen, existing);
        }

        chess.deleteComments();

        // Walk each ply, materializing nodes and edges in `rep.positions`.
        const replay = new Chess();
        for (const move of chess.history({ verbose: true })) {
            const beforeFen = normalizeFenResetHalfmoveClock(replay.fen());
            ensurePosition(rep, beforeFen);
            replay.move({ from: move.from, to: move.to, promotion: move.promotion });
            const afterFen = normalizeFenResetHalfmoveClock(replay.fen());
            ensurePosition(rep, afterFen);

            const pos = rep.positions[beforeFen];
            if (!pos.moves[move.san]) {
                // Wrap with empty entry on first sighting; the user-turn
                // branch below attaches the card if appropriate. We
                // denormalize `to` so reachability / canonical-path readers
                // (PendingEditModel etc.) can skip chess.js on this edge.
                pos.moves[move.san] = { to: afterFen };
            }
            if (isUserTurnForOrientation(beforeFen, variant.orientation)) {
                const key = FSRSService.makeCardKey(beforeFen, move.san);
                const card = legacyFsrsCards[key];
                if (card) {
                    pos.moves[move.san].card = card;
                }
                // If no legacy card exists, leave `card` undefined so the
                // graph-card reconciliation downstream creates a fresh one.
            }
        }

        // Merge PGN-comment annotations onto matching positions.
        for (const [fen, anns] of commentByFen) {
            ensurePosition(rep, fen);
            const pos = rep.positions[fen];
            const list = pos.annotations ?? [];
            for (const ann of anns) {
                const dup = list.find(
                    e => e.brush === ann.brush && e.orig === ann.orig && e.dest === ann.dest,
                );
                if (!dup) list.push(ann);
            }
            if (list.length > 0) pos.annotations = list;
        }
    }

    return repertoires;
}

function ensurePosition(rep: RepertoireEntry, fen: string): void {
    if (!rep.positions[fen]) {
        rep.positions[fen] = { moves: {} };
    }
}

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
