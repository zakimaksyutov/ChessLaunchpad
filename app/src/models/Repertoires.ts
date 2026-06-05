import { Annotation } from './Annotation';
import { FSRSCardData } from './FSRSCardData';

/**
 * Per-edge metadata. `card` is present iff the position's side-to-move matches
 * the repertoire's orientation (i.e. the move is a user move). Opponent moves
 * are stored as `{}` so the symmetric wrapper leaves room for future per-edge
 * metadata on both sides without a schema migration.
 */
export interface MoveEntry {
    card?: FSRSCardData;
}

/**
 * Position-level entry in a repertoire's `positions` dict.
 *
 * `annotations` is omitted when empty. Each annotation is either an arrow
 * (`{brush, orig, dest}`) or a square highlight (`{brush, orig}`) — matches
 * the in-app `Annotation` model.
 *
 * `moves` is keyed by SAN. The `to`-FEN of an edge is intentionally not stored
 * — recomputed by replaying the SAN.
 */
export interface PositionEntry {
    annotations?: Annotation[];
    moves: Record<string, MoveEntry>;
}

/**
 * A named repertoire. v1 hardcodes two entries — "White" and "Black" — both
 * always present, even if one's `positions` is `{}`.
 */
export interface RepertoireEntry {
    name: string;
    orientation: 'white' | 'black';
    positions: Record<string, PositionEntry>;
}

export const REPERTOIRE_NAME_WHITE = 'White';
export const REPERTOIRE_NAME_BLACK = 'Black';

/** Construct two empty named repertoires (v1 invariant: both always present). */
export function createEmptyRepertoires(): RepertoireEntry[] {
    return [
        { name: REPERTOIRE_NAME_WHITE, orientation: 'white', positions: {} },
        { name: REPERTOIRE_NAME_BLACK, orientation: 'black', positions: {} },
    ];
}

/** Locate a repertoire by orientation. Returns undefined if absent. */
export function findRepertoire(
    repertoires: RepertoireEntry[] | undefined,
    orientation: 'white' | 'black',
): RepertoireEntry | undefined {
    return repertoires?.find(r => r.orientation === orientation);
}
