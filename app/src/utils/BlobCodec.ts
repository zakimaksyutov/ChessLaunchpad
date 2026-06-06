import { Chess } from 'chess.js';
import { Annotation } from '../models/Annotation';
import { FSRSCardData } from '../models/FSRSCardData';
import {
    RepertoireEntry,
    PositionEntry,
    MoveEntry,
} from '../models/Repertoires';
import { RepertoireData } from '../models/RepertoireData';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

/**
 * Persisted-blob version flag.
 *
 *   undefined → legacy v1 (full-FEN keys, FSRS cards as objects with ISO dates).
 *               Decode passes through unchanged; `normalize()` handles it.
 *   3         → v3 (this module). `positions` is an array; move keys carry the
 *               child's array index as `"<SAN>:<index>"` (or `"<SAN>:-1"` when
 *               the child position is not stored in the repertoire). FSRS cards
 *               are positional arrays with epoch-ms dates.
 *
 *   2 (skipped): an interim hashed-key shape lived on the `migration` branch
 *               but never shipped. Treated as a hard error on decode so any
 *               stale dev blobs surface loudly rather than being mis-parsed.
 */
export const PERSISTED_BLOB_VERSION = 3 as const;

/**
 * FSRS card serialized as a positional array.
 *
 *   [d, s, di, e, sd, ls, r, l, st]           — 9 elements, no last_review
 *   [d, s, di, e, sd, ls, r, l, st, lr]       — 10 elements, with last_review
 *
 * `d` and `lr` are epoch milliseconds (not seconds — `shouldApplyRating` in
 * GameIngestService compares `lr` in ms and we don't want to silently truncate
 * sub-second ordering).
 */
export type PackedCard =
    | [number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number];

export interface PersistedMoveEntryV3 {
    card?: PackedCard;
}

export interface PersistedPositionEntryV3 {
    annotations?: Annotation[];
    /**
     * Keyed by `"<SAN>:<childIndex>"`. `childIndex` is the index of the
     * follow-up position in the parent repertoire's `positions` array, or
     * `-1` if the child position is not stored in the repertoire (e.g., a
     * user-move whose continuation was never explored).
     *
     * Standard PGN SAN never contains `:`, so splitting on the last `:` is
     * unambiguous.
     */
    moves: Record<string, PersistedMoveEntryV3>;
}

export interface PersistedRepertoireEntryV3 {
    name: string;
    orientation: 'white' | 'black';
    /**
     * Positions in deterministic BFS-from-root order. Index 0 is the standard
     * initial position (normalized via `normalizeFenResetHalfmoveClock`) when
     * the repertoire is non-empty. Empty repertoires emit `[]`.
     */
    positions: PersistedPositionEntryV3[];
}

export interface PersistedBlobV3 {
    v: typeof PERSISTED_BLOB_VERSION;
    repertoires: PersistedRepertoireEntryV3[];
    lastPlayedDate: string;
    dailyPlayCount: number;
    settings?: RepertoireData['settings'];
    activity?: RepertoireData['activity'];
    games?: RepertoireData['games'];
}

// Sentinel meaning "this move's child position is not stored in the repertoire".
// Encode emits `"<SAN>:-1"`; decode validates the SAN replay but doesn't recurse.
const NO_CHILD_INDEX = -1;

/**
 * Wire-key regex: `"<SAN>:<signed-integer>"`. The SAN portion captures
 * greedily up to the LAST `:`, then the suffix is a signed integer (no
 * leading zeros required, `-1` allowed for the no-child sentinel).
 */
const MOVE_KEY_REGEX = /^(.+):(-?\d+)$/;

// ── Card pack/unpack ────────────────────────────────────────────────────

function packCard(card: FSRSCardData): PackedCard {
    const d = isoToEpochMs(card.d);
    if (card.lr !== undefined) {
        const lr = isoToEpochMs(card.lr);
        return [d, card.s, card.di, card.e, card.sd, card.ls, card.r, card.l, card.st, lr];
    }
    return [d, card.s, card.di, card.e, card.sd, card.ls, card.r, card.l, card.st];
}

function unpackCard(packed: unknown): FSRSCardData {
    if (!Array.isArray(packed) || (packed.length !== 9 && packed.length !== 10)) {
        throw new Error(`BlobCodec: malformed packed card (expected length 9 or 10, got ${
            Array.isArray(packed) ? packed.length : typeof packed
        })`);
    }
    for (let i = 0; i < packed.length; i++) {
        if (!Number.isFinite(packed[i])) {
            throw new Error(
                `BlobCodec: malformed packed card (element ${i} is not a finite number: ${
                    JSON.stringify(packed[i])
                })`
            );
        }
    }
    const [d, s, di, e, sd, ls, r, l, st, lr] = packed as number[];
    const out: FSRSCardData = {
        d: epochMsToISO(d),
        s, di, e, sd, ls, r, l, st,
    };
    if (packed.length === 10) {
        out.lr = epochMsToISO(lr);
    }
    return out;
}

function isoToEpochMs(iso: string): number {
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) {
        throw new Error(`BlobCodec: invalid ISO date "${iso}"`);
    }
    return ms;
}

function epochMsToISO(ms: number): string {
    return new Date(ms).toISOString();
}

function lastPlayedDateToString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date(0).toISOString();
}

// ── Encode ──────────────────────────────────────────────────────────────

/**
 * Encode the in-memory `RepertoireData` to the v3 wire shape.
 *
 * Per repertoire, performs a deterministic BFS from the standard initial FEN.
 * Each visited position is appended to the output `positions` array in
 * visitation order, giving it a stable numeric index. Each outgoing move is
 * emitted as `"<SAN>:<childIndex>"`, where `childIndex` is the BFS-assigned
 * index of the child position, or `-1` if the child position is not stored
 * in the repertoire.
 *
 * Determinism: BFS children are visited in `Array.prototype.sort()` order over
 * SAN keys. Combined with the ECMAScript guarantee (ES2015+) that string-keyed
 * object properties iterate in insertion order, the same in-memory model
 * always produces byte-identical JSON output across browsers and Node.
 *
 * Throws if:
 *   - any SAN in any position fails to replay on chess.js (corrupt move data),
 *   - any position in `rep.positions` is not reachable from the start FEN
 *     by replaying SANs (orphan check).
 *
 * The in-memory `data` is **not** mutated. Legacy `data` / `fsrsCards` fields
 * are dropped from the output.
 */
export function encodePersistedBlob(data: RepertoireData): PersistedBlobV3 {
    const reps = data.repertoires ?? [];
    const outReps: PersistedRepertoireEntryV3[] = reps.map(encodeRepertoireV3);

    return {
        v: PERSISTED_BLOB_VERSION,
        repertoires: outReps,
        lastPlayedDate: lastPlayedDateToString(data.lastPlayedDate),
        dailyPlayCount: data.dailyPlayCount ?? 0,
        settings: data.settings,
        activity: data.activity,
        games: data.games,
    };
}

function encodeRepertoireV3(rep: RepertoireEntry): PersistedRepertoireEntryV3 {
    const positions = rep.positions ?? {};
    const start = normalizeFenResetHalfmoveClock(new Chess().fen());

    const fenToIdx = new Map<string, number>();
    const outArr: PersistedPositionEntryV3[] = [];
    const queue: string[] = [];

    if (positions[start]) {
        fenToIdx.set(start, 0);
        outArr.push(/* placeholder */ { moves: {} });
        queue.push(start);
    }

    while (queue.length > 0) {
        const fen = queue.shift()!;
        const idx = fenToIdx.get(fen)!;
        const pos = positions[fen];

        const outMoves: Record<string, PersistedMoveEntryV3> = {};
        // Sorted SAN iteration → deterministic child-index assignment.
        for (const san of Object.keys(pos.moves).sort()) {
            const move = pos.moves[san];
            const chess = new Chess(fen);
            let moved;
            try {
                moved = chess.move(san);
            } catch {
                moved = null;
            }
            if (!moved) {
                throw new Error(
                    `BlobCodec.encode: illegal move in repertoire "${rep.name}" — ` +
                    `SAN "${san}" is not a legal move from FEN "${fen}". Refusing to persist.`
                );
            }
            const childFen = normalizeFenResetHalfmoveClock(chess.fen());

            let childIdx: number;
            if (positions[childFen]) {
                const existing = fenToIdx.get(childFen);
                if (existing !== undefined) {
                    childIdx = existing;
                } else {
                    childIdx = outArr.length;
                    fenToIdx.set(childFen, childIdx);
                    outArr.push(/* placeholder */ { moves: {} });
                    queue.push(childFen);
                }
            } else {
                childIdx = NO_CHILD_INDEX;
            }

            const outMove: PersistedMoveEntryV3 = move.card ? { card: packCard(move.card) } : {};
            outMoves[`${san}:${childIdx}`] = outMove;
        }

        const outPos: PersistedPositionEntryV3 = { moves: outMoves };
        if (pos.annotations && pos.annotations.length > 0) {
            outPos.annotations = pos.annotations;
        }
        outArr[idx] = outPos;
    }

    // Orphan check: any FEN in rep.positions that BFS didn't reach is orphaned.
    for (const fen of Object.keys(positions)) {
        if (!fenToIdx.has(fen)) {
            throw new Error(
                `BlobCodec.encode: orphan position in repertoire "${rep.name}" — ` +
                `FEN "${fen}" is not reachable from the standard initial position ` +
                `by replaying SANs. Refusing to persist (would silently drop the entry on round-trip).`
            );
        }
    }

    return { name: rep.name, orientation: rep.orientation, positions: outArr };
}

// ── Decode ──────────────────────────────────────────────────────────────

/**
 * Decode a persisted blob (v1 or v3) into the in-memory `RepertoireData`
 * shape that `normalize()` expects.
 *
 *   v1 (or absent `v`) → pass-through (returned object IS the input).
 *   v2                  → hard error (interim hashed-key shape never shipped).
 *   v3                  → rebuild `repertoires` with full FEN keys and
 *                         unpacked cards by walking the `positions` array
 *                         starting at index 0 (= standard initial FEN).
 *
 * Validates aggressively:
 *   - SAN is replayed via chess.js for every move (including `-1` edges),
 *     so illegal moves are caught even when they don't lead to a recursion.
 *   - Each child index is verified against an `indexToFen` map: if two paths
 *     point at the same array index, their computed child FENs must match.
 *   - Every persisted index must be reached by the walk (orphan check).
 */
export function decodePersistedBlob(raw: unknown): RepertoireData {
    if (!raw || typeof raw !== 'object') {
        return raw as RepertoireData;
    }

    const v = (raw as { v?: unknown }).v;
    if (v === undefined) {
        return raw as RepertoireData;
    }
    if (v === 2) {
        throw new Error(
            `BlobCodec.decode: unsupported repertoire blob version: 2 ` +
            `(interim hashed-key format never shipped). Re-export from a ` +
            `client that produced v1 or v3.`
        );
    }
    if (v !== PERSISTED_BLOB_VERSION) {
        throw new Error(`BlobCodec.decode: unsupported repertoire blob version: ${String(v)}`);
    }

    const persisted = raw as PersistedBlobV3;
    const outReps: RepertoireEntry[] = (persisted.repertoires ?? []).map(decodeRepertoireV3);

    return {
        repertoires: outReps,
        lastPlayedDate: persisted.lastPlayedDate as unknown as Date, // normalize() re-hydrates
        dailyPlayCount: persisted.dailyPlayCount ?? 0,
        settings: persisted.settings,
        activity: persisted.activity,
        games: persisted.games,
    };
}

function decodeRepertoireV3(rep: PersistedRepertoireEntryV3): RepertoireEntry {
    if (!rep || typeof rep !== 'object') {
        throw new Error(`BlobCodec.decode: repertoire entry is not an object`);
    }
    const positions = rep.positions;
    if (!Array.isArray(positions)) {
        throw new Error(
            `BlobCodec.decode: repertoire "${rep.name}" has non-array \`positions\`.`
        );
    }

    const outPositions: Record<string, PositionEntry> = {};
    if (positions.length === 0) {
        return { name: rep.name, orientation: rep.orientation, positions: outPositions };
    }

    const start = normalizeFenResetHalfmoveClock(new Chess().fen());
    const indexToFen = new Map<number, string>();
    const queue: { idx: number; fen: string }[] = [];

    indexToFen.set(0, start);
    queue.push({ idx: 0, fen: start });

    while (queue.length > 0) {
        const { idx, fen } = queue.shift()!;
        const entry = positions[idx];
        if (!entry || typeof entry !== 'object') {
            throw new Error(
                `BlobCodec.decode: repertoire "${rep.name}" index ${idx} is not an object.`
            );
        }
        const movesIn = (entry as PersistedPositionEntryV3).moves;
        if (!movesIn || typeof movesIn !== 'object') {
            throw new Error(
                `BlobCodec.decode: repertoire "${rep.name}" index ${idx} has missing/invalid \`moves\`.`
            );
        }

        const outMoves: Record<string, MoveEntry> = {};
        for (const key of Object.keys(movesIn)) {
            const parsed = parseMoveKey(key);
            if (!parsed) {
                throw new Error(
                    `BlobCodec.decode: repertoire "${rep.name}" index ${idx} ` +
                    `has malformed move key "${key}" (expected "<SAN>:<integer>").`
                );
            }
            const { san, childIdx } = parsed;
            if (childIdx < -1) {
                throw new Error(
                    `BlobCodec.decode: repertoire "${rep.name}" index ${idx} move "${key}" ` +
                    `has invalid child index ${childIdx} (must be >= -1).`
                );
            }
            if (childIdx >= 0 && childIdx >= positions.length) {
                throw new Error(
                    `BlobCodec.decode: repertoire "${rep.name}" index ${idx} move "${key}" ` +
                    `references out-of-bounds child index ${childIdx} ` +
                    `(positions.length = ${positions.length}).`
                );
            }

            const move = movesIn[key];
            outMoves[san] = move && move.card !== undefined
                ? { card: unpackCard(move.card) }
                : {};

            // Replay SAN even for -1 — invalid SAN is data corruption either way.
            const chess = new Chess(fen);
            let moved;
            try {
                moved = chess.move(san);
            } catch {
                moved = null;
            }
            if (!moved) {
                throw new Error(
                    `BlobCodec.decode: repertoire "${rep.name}" index ${idx} ` +
                    `has illegal move "${san}" from FEN "${fen}".`
                );
            }
            const childFen = normalizeFenResetHalfmoveClock(chess.fen());

            if (childIdx === NO_CHILD_INDEX) {
                // Validated SAN; child not stored, don't recurse.
                continue;
            }

            // Consistency cross-check: if we've reached this child via another
            // path, both paths must compute the same FEN. Catches corrupt blobs
            // that re-point one edge at the wrong array entry.
            const prior = indexToFen.get(childIdx);
            if (prior !== undefined) {
                if (prior !== childFen) {
                    throw new Error(
                        `BlobCodec.decode: repertoire "${rep.name}" index ${idx} move "${key}" ` +
                        `expects child index ${childIdx} to map to FEN "${childFen}", ` +
                        `but it was already reached as "${prior}".`
                    );
                }
                // Already visited via earlier path — don't re-enqueue.
            } else {
                indexToFen.set(childIdx, childFen);
                queue.push({ idx: childIdx, fen: childFen });
            }
        }

        const outPos: PositionEntry = { moves: outMoves };
        if ((entry as PersistedPositionEntryV3).annotations
            && (entry as PersistedPositionEntryV3).annotations!.length > 0) {
            outPos.annotations = (entry as PersistedPositionEntryV3).annotations;
        }
        outPositions[fen] = outPos;
    }

    // Orphan check: every persisted index must have been reached by the walk.
    if (indexToFen.size !== positions.length) {
        const missing: number[] = [];
        for (let i = 0; i < positions.length; i++) {
            if (!indexToFen.has(i)) missing.push(i);
        }
        throw new Error(
            `BlobCodec.decode: orphan persisted entries in repertoire "${rep.name}" — ` +
            `indices [${missing.join(', ')}] are not reachable from index 0 ` +
            `by replaying SANs. The blob is inconsistent.`
        );
    }

    return { name: rep.name, orientation: rep.orientation, positions: outPositions };
}

/** Parse a `"<SAN>:<index>"` wire key. Returns null on malformed input. */
function parseMoveKey(key: string): { san: string; childIdx: number } | null {
    const m = MOVE_KEY_REGEX.exec(key);
    if (!m) return null;
    const childIdx = Number(m[2]);
    if (!Number.isInteger(childIdx)) return null;
    return { san: m[1], childIdx };
}
