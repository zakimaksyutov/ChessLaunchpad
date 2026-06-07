import { Chess } from 'chess.js';
import { Annotation } from '../models/Annotation';
import { FSRSCardData } from '../models/FSRSCardData';
import {
    RepertoireEntry,
    createEmptyRepertoires,
    findRepertoire,
} from '../models/Repertoires';
import { FSRSService } from '../services/FSRSService';
import {
    normalizeFenResetHalfmoveClock,
    isUserTurnForOrientation,
} from '../utils/FenUtils';
import { extractAnnotations } from '../utils/AnnotationUtils';

/**
 * Test-only PGN → position-centric repertoire builder. Test fixtures still
 * write linear opening lines as PGN strings because that's the natural
 * notation for an opening repertoire; this helper materializes them into the
 * v3 in-memory shape (`{name, orientation, positions: Record<fen, ...>}`).
 *
 * Lives under `src/test-utils/` because production code no longer needs PGN
 * → positions conversion (the legacy v1 wire format is gone). Do not import
 * this from non-test code.
 *
 * Returned shape matches `createEmptyRepertoires()`: always two entries
 * (White and Black) so callers can `findRepertoire` either way.
 */
export interface PgnVariantInput {
    pgn: string;
    orientation: 'white' | 'black';
}

export function pgnToRepertoires(
    variants: PgnVariantInput[],
    seedCards: Record<string, FSRSCardData> = {},
): RepertoireEntry[] {
    const repertoires = createEmptyRepertoires();

    for (const variant of variants) {
        const rep = findRepertoire(repertoires, variant.orientation);
        if (!rep) continue;

        let chess: Chess;
        try {
            chess = new Chess();
            chess.loadPgn(variant.pgn);
        } catch {
            continue;
        }

        const commentByFen = new Map<string, Annotation[]>();
        for (const c of chess.getComments()) {
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

        const replay = new Chess();
        for (const move of chess.history({ verbose: true })) {
            const beforeFen = normalizeFenResetHalfmoveClock(replay.fen());
            ensurePosition(rep, beforeFen);
            replay.move({ from: move.from, to: move.to, promotion: move.promotion });
            const afterFen = normalizeFenResetHalfmoveClock(replay.fen());
            ensurePosition(rep, afterFen);

            const pos = rep.positions[beforeFen];
            if (!pos.moves[move.san]) {
                pos.moves[move.san] = { to: afterFen };
            }
            if (isUserTurnForOrientation(beforeFen, variant.orientation)) {
                const key = FSRSService.makeCardKey(beforeFen, move.san);
                const card = seedCards[key];
                if (card) {
                    pos.moves[move.san].card = card;
                }
            }
        }

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
