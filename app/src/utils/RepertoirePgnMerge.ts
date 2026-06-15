import { Chess } from 'chess.js';
import { createEmptyCard } from 'ts-fsrs';
import {
    RepertoireEntry,
    MoveEntry,
    createEmptyRepertoires,
    findRepertoire,
} from '../models/Repertoires';
import { Annotation } from '../models/Annotation';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService } from '../services/FSRSService';
import {
    normalizeFenResetHalfmoveClock,
    isUserTurnForOrientation,
} from './FenUtils';
import {
    DecodedRepertoirePgn,
    DecodedEdge,
} from './RepertoirePgn';

/**
 * Imported-PGN merge into a working `RepertoireEntry[]`.
 *
 *   * Edges are unioned: existing edges + cards untouched, new edges get a
 *     fresh New-state card via `createEmptyCard()` on user-turn moves.
 *   * Annotations REPLACE the existing set at a FEN only when the import
 *     supplies one (i.e. the parsed PGN comment carried at least one
 *     `[%cal …]` / `[%csl …]` token). Other positions are untouched. This
 *     is the intentional asymmetry in `docs/product-specs/REPERTOIRE-PGN.md`
 *     — import can add or replace annotations but cannot clear them.
 *
 * Returns a summary used by the UI to show "Imported N moves" feedback.
 * `addedEdges` includes only edges that weren't already in the repertoire;
 * idempotent re-imports report 0.
 */
export interface PgnMergeSummary {
    orientation: 'white' | 'black';
    addedEdges: number;
    /** Positions newly created by the merge (didn't exist before). */
    addedPositions: number;
    /** Annotation sets replaced (== entries in `annotationsByFen`). */
    annotationsReplaced: number;
}

/**
 * Merge a decoded PGN into `repertoires` in place. Caller is responsible
 * for cloning beforehand if Read-mode semantics require immutability.
 *
 * Side effects:
 *   * Adds positions and edges into the orientation-matching repertoire.
 *   * Attaches a fresh `FSRSCardData` (New state) to every user-turn edge
 *     that didn't already have a card. The same card object is also
 *     written into `fsrsCardsOut` so callers can include it in the flat
 *     in-memory card map used by `prepareDataForSave`.
 *   * Replaces annotations only for positions appearing in
 *     `decoded.annotationsByFen`.
 *
 * Throws if the orientation-matching repertoire is missing (caller must
 * have run `normalize()` on the blob — invariant: both repertoires
 * always present).
 */
export function applyImportedPgnToRepertoires(
    repertoires: RepertoireEntry[],
    decoded: DecodedRepertoirePgn,
    fsrsCardsOut: Record<string, FSRSCardData>,
): PgnMergeSummary {
    const rep = findRepertoire(repertoires, decoded.orientation);
    if (!rep) {
        // Defensive: callers run `normalize()` before this, which seeds
        // both repertoires. Surface a clear error if that invariant fails.
        throw new Error(
            `applyImportedPgnToRepertoires: missing ${decoded.orientation} repertoire ` +
            `(invariant: both White and Black should be present after normalize()).`,
        );
    }

    let addedEdges = 0;
    let addedPositions = 0;
    let annotationsReplaced = 0;

    // Ensure root exists so even an empty import can attach root annotations.
    const root = normalizeFenResetHalfmoveClock(new Chess().fen());
    if (!rep.positions[root]) {
        rep.positions[root] = { moves: {} };
        addedPositions++;
    }

    // Apply edges. Decoder yields edges in encounter order (parent before
    // child within each branch), so every edge's `from` is either the
    // root or already present from an earlier edge.
    for (const edge of decoded.edges) {
        const created = applyOneEdge(rep, edge, fsrsCardsOut);
        if (created.addedEdge) addedEdges++;
        addedPositions += created.addedPositions;
    }

    // Replace annotations only for the positions the decoder emitted in
    // `annotationsByFen` (those are exactly the positions whose imported
    // comment carried a valid `[%cal …]` / `[%csl …]` annotation set).
    //
    // Invariant: `decodeRepertoirePgn` only emits entries with non-empty
    // annotation arrays (empty/garbage structured tokens parse to `null`
    // and aren't recorded — see `parseAnnotationsFromComment`). The
    // `anns.length === 0` branch below is therefore unreachable from the
    // import flow today; kept as defense-in-depth so a future caller that
    // hand-builds a `DecodedRepertoirePgn` cannot inadvertently bypass
    // the spec's "import cannot CLEAR annotations" rule.
    for (const [fen, anns] of decoded.annotationsByFen) {
        // Defense-in-depth: the spec is explicit that import "can add or
        // replace annotations but cannot CLEAR them." Skip empty arrays
        // even though the decoder guarantees only non-empty entries
        // reach us — this way a future caller that hand-builds a
        // `DecodedRepertoirePgn` cannot inadvertently bypass the rule.
        if (anns.length === 0) continue;
        const pos = rep.positions[fen];
        if (!pos) {
            // The annotated FEN isn't in the repertoire — skip rather than
            // creating an orphan position. This can happen if the comment
            // attaches to root in a file with no edges (rare).
            if (fen === root) {
                rep.positions[root] = { moves: {}, annotations: anns.map(a => ({ ...a })) };
                addedPositions++;
                annotationsReplaced++;
            }
            continue;
        }
        pos.annotations = anns.map(a => ({ ...a }));
        annotationsReplaced++;
    }

    return {
        orientation: decoded.orientation,
        addedEdges,
        addedPositions,
        annotationsReplaced,
    };
}

function applyOneEdge(
    rep: RepertoireEntry,
    edge: DecodedEdge,
    fsrsCardsOut: Record<string, FSRSCardData>,
): { addedEdge: boolean; addedPositions: number } {
    let addedPositions = 0;
    if (!rep.positions[edge.from]) {
        rep.positions[edge.from] = { moves: {} };
        addedPositions++;
    }
    if (!rep.positions[edge.to]) {
        rep.positions[edge.to] = { moves: {} };
        addedPositions++;
    }
    const fromPos = rep.positions[edge.from];
    if (fromPos.moves[edge.san]) {
        // Edge already present — leave card untouched.
        return { addedEdge: false, addedPositions };
    }
    const move: MoveEntry = { to: edge.to };
    fromPos.moves[edge.san] = move;

    if (isUserTurnForOrientation(edge.from, rep.orientation)) {
        const key = FSRSService.makeCardKey(edge.from, edge.san);
        // If a card for this key was projected from a deleted-and-restored
        // edge earlier in the session (e.g., the user imported the same
        // edge twice), prefer the existing card.
        const existing = fsrsCardsOut[key];
        if (existing) {
            move.card = existing;
        } else {
            const fresh = FSRSService.serialize(createEmptyCard());
            move.card = fresh;
            fsrsCardsOut[key] = fresh;
        }
    }
    return { addedEdge: true, addedPositions };
}

/**
 * Convenience wrapper used by the Read-mode import path. Clones the
 * full `repertoires` array, applies the merge, and returns the fresh
 * structure plus the updated flat card map. The caller then runs the
 * normal `prepareDataForSave` → `dal.storeRepertoireData` pipeline.
 *
 * Cloning here (vs. mutating `repertoires` in place) keeps the merge
 * pure with respect to the in-memory state held by the page; the
 * page's `data` ref is only swapped when the PUT succeeds.
 */
export function mergeImportedPgnReadMode(
    repertoires: RepertoireEntry[],
    fsrsCards: Record<string, FSRSCardData>,
    decoded: DecodedRepertoirePgn,
): {
    repertoires: RepertoireEntry[];
    fsrsCards: Record<string, FSRSCardData>;
    summary: PgnMergeSummary;
} {
    // Ensure both repertoires exist on the clone so the merge can pick
    // the correct one even if the source blob is missing the orientation
    // (defensive — `normalize()` should have populated it).
    const cloned = cloneRepertoires(repertoires);
    for (const need of createEmptyRepertoires()) {
        if (!findRepertoire(cloned, need.orientation)) {
            cloned.push({ ...need, positions: {} });
        }
    }
    const liveCards: Record<string, FSRSCardData> = { ...fsrsCards };
    const summary = applyImportedPgnToRepertoires(cloned, decoded, liveCards);
    return { repertoires: cloned, fsrsCards: liveCards, summary };
}

function cloneRepertoires(reps: RepertoireEntry[]): RepertoireEntry[] {
    return reps.map(r => ({
        name: r.name,
        orientation: r.orientation,
        positions: Object.fromEntries(
            Object.entries(r.positions).map(([fen, pos]) => [
                fen,
                {
                    annotations: pos.annotations
                        ? pos.annotations.map(a => ({ ...a }))
                        : undefined,
                    moves: Object.fromEntries(
                        Object.entries(pos.moves).map(([san, m]) => {
                            const out: MoveEntry = {};
                            if (m.card) out.card = { ...m.card };
                            if (m.to !== undefined) out.to = m.to;
                            return [san, out];
                        }),
                    ),
                },
            ]),
        ),
    }));
}
