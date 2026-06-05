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
 *   2         → v2 (this module). Hashed FEN keys, FSRS cards as positional
 *               arrays, due/last-review as epoch milliseconds.
 */
export const PERSISTED_BLOB_VERSION = 2 as const;

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

export interface PersistedMoveEntryV2 {
    card?: PackedCard;
}

export interface PersistedPositionEntryV2 {
    annotations?: Annotation[];
    moves: Record<string, PersistedMoveEntryV2>;
}

export interface PersistedRepertoireEntryV2 {
    name: string;
    orientation: 'white' | 'black';
    /** Keyed by 12-char base64url MurmurHash3-x86-128 of the normalized FEN. */
    positions: Record<string, PersistedPositionEntryV2>;
}

export interface PersistedBlobV2 {
    v: typeof PERSISTED_BLOB_VERSION;
    repertoires: PersistedRepertoireEntryV2[];
    currentEpoch: number;
    lastPlayedDate: string;
    dailyPlayCount: number;
    settings?: RepertoireData['settings'];
    activity?: RepertoireData['activity'];
    games?: RepertoireData['games'];
}

/** Hash a FEN to a stable 12-char base64url string (72 bits of entropy). */
export function hashFen(fen: string): string {
    const bytes = new TextEncoder().encode(fen);
    const [h1, h2, h3] = murmur3_x86_128(bytes);
    // First 9 bytes of the 128-bit digest in little-endian order (canonical
    // MurmurHash3_x86_128 byte layout). 9 bytes → 12 base64 chars (no padding).
    const out = new Uint8Array(9);
    out[0] = h1 & 0xff;
    out[1] = (h1 >>> 8) & 0xff;
    out[2] = (h1 >>> 16) & 0xff;
    out[3] = (h1 >>> 24) & 0xff;
    out[4] = h2 & 0xff;
    out[5] = (h2 >>> 8) & 0xff;
    out[6] = (h2 >>> 16) & 0xff;
    out[7] = (h2 >>> 24) & 0xff;
    out[8] = h3 & 0xff;
    return base64urlBytes(out);
}

function base64urlBytes(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = typeof btoa === 'function'
        ? btoa(bin)
        : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── MurmurHash3 x86_128 (inline reference implementation) ───────────────
//
// Why MurmurHash3 instead of SHA-1 / Web Crypto:
//   - synchronous (no Promise<>)
//   - zero crypto.subtle dependency
//   - tiny (well under 100 lines), well-known stable algorithm
//
// Why x86_128 specifically (not x64_128):
//   - JS only has reliable 32-bit integer multiplication via Math.imul.
//     The x64 variant requires emulated 64-bit ops, larger and slower.
//   - 128 bits is plenty of headroom for the 72-bit truncation we use.
//
// Verified against `murmurhash3js@3.0.1` (`x86.hash128`) — see BlobCodec.test.ts.

function rotl32(x: number, r: number): number {
    return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function fmix32(h: number): number {
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
}

function murmur3_x86_128(bytes: Uint8Array, seed = 0): [number, number, number, number] {
    const len = bytes.length;
    const nBlocks = Math.floor(len / 16);

    let h1 = seed >>> 0, h2 = seed >>> 0, h3 = seed >>> 0, h4 = seed >>> 0;
    const c1 = 0x239b961b, c2 = 0xab0e9789, c3 = 0x38b34ae5, c4 = 0xa1e38b93;

    for (let i = 0; i < nBlocks; i++) {
        const b = i * 16;
        let k1 = (bytes[b]     | (bytes[b + 1] << 8) | (bytes[b + 2] << 16) | (bytes[b + 3] << 24)) >>> 0;
        let k2 = (bytes[b + 4] | (bytes[b + 5] << 8) | (bytes[b + 6] << 16) | (bytes[b + 7] << 24)) >>> 0;
        let k3 = (bytes[b + 8] | (bytes[b + 9] << 8) | (bytes[b + 10] << 16) | (bytes[b + 11] << 24)) >>> 0;
        let k4 = (bytes[b + 12] | (bytes[b + 13] << 8) | (bytes[b + 14] << 16) | (bytes[b + 15] << 24)) >>> 0;

        k1 = Math.imul(k1, c1) >>> 0; k1 = rotl32(k1, 15); k1 = Math.imul(k1, c2) >>> 0; h1 = (h1 ^ k1) >>> 0;
        h1 = rotl32(h1, 19); h1 = (h1 + h2) >>> 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) >>> 0;

        k2 = Math.imul(k2, c2) >>> 0; k2 = rotl32(k2, 16); k2 = Math.imul(k2, c3) >>> 0; h2 = (h2 ^ k2) >>> 0;
        h2 = rotl32(h2, 17); h2 = (h2 + h3) >>> 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) >>> 0;

        k3 = Math.imul(k3, c3) >>> 0; k3 = rotl32(k3, 17); k3 = Math.imul(k3, c4) >>> 0; h3 = (h3 ^ k3) >>> 0;
        h3 = rotl32(h3, 15); h3 = (h3 + h4) >>> 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) >>> 0;

        k4 = Math.imul(k4, c4) >>> 0; k4 = rotl32(k4, 18); k4 = Math.imul(k4, c1) >>> 0; h4 = (h4 ^ k4) >>> 0;
        h4 = rotl32(h4, 13); h4 = (h4 + h1) >>> 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) >>> 0;
    }

    const t = nBlocks * 16;
    const tailLen = len - t;
    let k1 = 0, k2 = 0, k3 = 0, k4 = 0;

    if (tailLen >= 15) k4 = (k4 ^ (bytes[t + 14] << 16)) >>> 0;
    if (tailLen >= 14) k4 = (k4 ^ (bytes[t + 13] << 8)) >>> 0;
    if (tailLen >= 13) {
        k4 = (k4 ^ bytes[t + 12]) >>> 0;
        k4 = Math.imul(k4, c4) >>> 0; k4 = rotl32(k4, 18); k4 = Math.imul(k4, c1) >>> 0;
        h4 = (h4 ^ k4) >>> 0;
    }
    if (tailLen >= 12) k3 = (k3 ^ (bytes[t + 11] << 24)) >>> 0;
    if (tailLen >= 11) k3 = (k3 ^ (bytes[t + 10] << 16)) >>> 0;
    if (tailLen >= 10) k3 = (k3 ^ (bytes[t + 9] << 8)) >>> 0;
    if (tailLen >= 9) {
        k3 = (k3 ^ bytes[t + 8]) >>> 0;
        k3 = Math.imul(k3, c3) >>> 0; k3 = rotl32(k3, 17); k3 = Math.imul(k3, c4) >>> 0;
        h3 = (h3 ^ k3) >>> 0;
    }
    if (tailLen >= 8) k2 = (k2 ^ (bytes[t + 7] << 24)) >>> 0;
    if (tailLen >= 7) k2 = (k2 ^ (bytes[t + 6] << 16)) >>> 0;
    if (tailLen >= 6) k2 = (k2 ^ (bytes[t + 5] << 8)) >>> 0;
    if (tailLen >= 5) {
        k2 = (k2 ^ bytes[t + 4]) >>> 0;
        k2 = Math.imul(k2, c2) >>> 0; k2 = rotl32(k2, 16); k2 = Math.imul(k2, c3) >>> 0;
        h2 = (h2 ^ k2) >>> 0;
    }
    if (tailLen >= 4) k1 = (k1 ^ (bytes[t + 3] << 24)) >>> 0;
    if (tailLen >= 3) k1 = (k1 ^ (bytes[t + 2] << 16)) >>> 0;
    if (tailLen >= 2) k1 = (k1 ^ (bytes[t + 1] << 8)) >>> 0;
    if (tailLen >= 1) {
        k1 = (k1 ^ bytes[t]) >>> 0;
        k1 = Math.imul(k1, c1) >>> 0; k1 = rotl32(k1, 15); k1 = Math.imul(k1, c2) >>> 0;
        h1 = (h1 ^ k1) >>> 0;
    }

    h1 = (h1 ^ len) >>> 0; h2 = (h2 ^ len) >>> 0; h3 = (h3 ^ len) >>> 0; h4 = (h4 ^ len) >>> 0;
    h1 = (h1 + h2) >>> 0; h1 = (h1 + h3) >>> 0; h1 = (h1 + h4) >>> 0;
    h2 = (h2 + h1) >>> 0; h3 = (h3 + h1) >>> 0; h4 = (h4 + h1) >>> 0;
    h1 = fmix32(h1); h2 = fmix32(h2); h3 = fmix32(h3); h4 = fmix32(h4);
    h1 = (h1 + h2) >>> 0; h1 = (h1 + h3) >>> 0; h1 = (h1 + h4) >>> 0;
    h2 = (h2 + h1) >>> 0; h3 = (h3 + h1) >>> 0; h4 = (h4 + h1) >>> 0;

    return [h1, h2, h3, h4];
}

/** Internal: 128-bit hash as a 32-char big-endian hex string. Used only by tests. */
export function _murmur3_x86_128_hex(input: string): string {
    const [h1, h2, h3, h4] = murmur3_x86_128(new TextEncoder().encode(input));
    const hex = (x: number): string => x.toString(16).padStart(8, '0');
    return hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

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

// ── Encode ──────────────────────────────────────────────────────────────

/**
 * Encode the in-memory `RepertoireData` to the v2 wire shape.
 *
 * Asserts:
 *   1. Every position in each repertoire's `positions` dict is reachable from
 *      the standard initial FEN by replaying its `moves` SANs (orphan check).
 *   2. No two FENs in the same repertoire collide under the hash.
 *
 * The in-memory `data` is **not** mutated. `data` and `fsrsCards` legacy
 * fields are dropped from the output (mirrors `prepareDataForSave`).
 */
export function encodePersistedBlob(data: RepertoireData): PersistedBlobV2 {
    const reps = data.repertoires ?? [];
    const outReps: PersistedRepertoireEntryV2[] = [];

    for (const rep of reps) {
        const reachable = computeReachableFens(rep.positions);
        for (const fen of Object.keys(rep.positions)) {
            if (!reachable.has(fen)) {
                throw new Error(
                    `BlobCodec.encode: orphan position in repertoire "${rep.name}" — ` +
                    `FEN "${fen}" is not reachable from the standard initial position ` +
                    `by replaying SANs. Refusing to persist (would silently drop the entry on round-trip).`
                );
            }
        }

        const seen = new Map<string, string>();
        const outPositions: Record<string, PersistedPositionEntryV2> = {};
        for (const [fen, pos] of Object.entries(rep.positions)) {
            const hash = hashFen(fen);
            const prior = seen.get(hash);
            if (prior !== undefined && prior !== fen) {
                throw new Error(
                    `BlobCodec.encode: hash collision in repertoire "${rep.name}" — ` +
                    `FENs "${prior}" and "${fen}" map to the same hash "${hash}".`
                );
            }
            seen.set(hash, fen);

            const outMoves: Record<string, PersistedMoveEntryV2> = {};
            for (const [san, move] of Object.entries(pos.moves)) {
                outMoves[san] = move.card ? { card: packCard(move.card) } : {};
            }
            const outPos: PersistedPositionEntryV2 = { moves: outMoves };
            if (pos.annotations && pos.annotations.length > 0) {
                outPos.annotations = pos.annotations;
            }
            outPositions[hash] = outPos;
        }

        outReps.push({ name: rep.name, orientation: rep.orientation, positions: outPositions });
    }

    return {
        v: PERSISTED_BLOB_VERSION,
        repertoires: outReps,
        currentEpoch: data.currentEpoch ?? 0,
        lastPlayedDate: lastPlayedDateToString(data.lastPlayedDate),
        dailyPlayCount: data.dailyPlayCount ?? 0,
        settings: data.settings,
        activity: data.activity,
        games: data.games,
    };
}

function lastPlayedDateToString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date(0).toISOString();
}

/**
 * Walk the position graph from the standard initial FEN and return the set
 * of FENs we can reach by replaying the SANs in each position's `moves`
 * dict. Cycle-safe (visited set); a SAN that fails to replay (e.g. corrupted
 * key) is skipped, so a single bad SAN does not invalidate its siblings.
 */
function computeReachableFens(positions: Record<string, PositionEntry>): Set<string> {
    const reachable = new Set<string>();
    const start = normalizeFenResetHalfmoveClock(new Chess().fen());

    const queue: string[] = [];
    if (positions[start]) {
        reachable.add(start);
        queue.push(start);
    }

    while (queue.length > 0) {
        const fen = queue.shift()!;
        const pos = positions[fen];
        if (!pos) continue;

        for (const san of Object.keys(pos.moves)) {
            const chess = new Chess(fen);
            let moved;
            try {
                moved = chess.move(san);
            } catch {
                moved = null;
            }
            if (!moved) continue;
            const child = normalizeFenResetHalfmoveClock(chess.fen());
            if (!reachable.has(child) && positions[child]) {
                reachable.add(child);
                queue.push(child);
            }
        }
    }

    return reachable;
}

// ── Decode ──────────────────────────────────────────────────────────────

/**
 * Decode a persisted blob (v1 or v2) into the in-memory `RepertoireData`
 * shape that `normalize()` expects.
 *
 *   v1 (or absent `v`) → pass-through (returned object IS the input).
 *   v2                  → rebuild `repertoires` with full FEN keys and
 *                         unpacked cards by walking the graph from the
 *                         standard initial FEN.
 *
 * Hard-fails if any persisted position hash is not reached by the walk
 * (symmetric with `encode`'s orphan check) or if `v` is an unknown future
 * version.
 */
export function decodePersistedBlob(raw: unknown): RepertoireData {
    if (!raw || typeof raw !== 'object') {
        return raw as RepertoireData;
    }

    const v = (raw as { v?: unknown }).v;
    if (v === undefined) {
        return raw as RepertoireData;
    }
    if (v !== PERSISTED_BLOB_VERSION) {
        throw new Error(`BlobCodec.decode: unsupported repertoire blob version: ${String(v)}`);
    }

    const persisted = raw as PersistedBlobV2;
    const outReps: RepertoireEntry[] = [];

    for (const rep of persisted.repertoires ?? []) {
        const start = normalizeFenResetHalfmoveClock(new Chess().fen());
        const startHash = hashFen(start);

        const outPositions: Record<string, PositionEntry> = {};
        // Track both FENs (for cycle detection during the walk) and hashes
        // (for the orphan check at the end). We always know both at insertion
        // time, so maintaining the hash set in parallel avoids a second
        // hashing pass over every visited FEN.
        const visitedFens = new Set<string>();
        const visitedHashes = new Set<string>();

        const seedEntry = rep.positions[startHash];
        const queue: { fen: string; hash: string }[] = [];
        if (seedEntry) {
            visitedFens.add(start);
            visitedHashes.add(startHash);
            queue.push({ fen: start, hash: startHash });
        }

        while (queue.length > 0) {
            const { fen, hash } = queue.shift()!;
            const entry = rep.positions[hash];
            if (!entry) continue;

            const outMoves: Record<string, MoveEntry> = {};
            for (const [san, move] of Object.entries(entry.moves ?? {})) {
                outMoves[san] = move.card !== undefined ? { card: unpackCard(move.card) } : {};

                const chess = new Chess(fen);
                let moved;
                try {
                    moved = chess.move(san);
                } catch {
                    moved = null;
                }
                if (!moved) continue;
                const childFen = normalizeFenResetHalfmoveClock(chess.fen());
                if (visitedFens.has(childFen)) continue;
                const childHash = hashFen(childFen);
                if (!rep.positions[childHash]) continue;
                visitedFens.add(childFen);
                visitedHashes.add(childHash);
                queue.push({ fen: childFen, hash: childHash });
            }

            const outPos: PositionEntry = { moves: outMoves };
            if (entry.annotations && entry.annotations.length > 0) {
                outPos.annotations = entry.annotations;
            }
            outPositions[fen] = outPos;
        }

        // Check that we visited every persisted hash. Anything left over is
        // an orphan we cannot map back to a full FEN — refuse silently
        // dropping it on round-trip.
        for (const hash of Object.keys(rep.positions)) {
            if (!visitedHashes.has(hash)) {
                throw new Error(
                    `BlobCodec.decode: orphan persisted entry in repertoire "${rep.name}" — ` +
                    `hash "${hash}" is not reachable from the standard initial position ` +
                    `by replaying SANs. The blob is inconsistent.`
                );
            }
        }

        outReps.push({ name: rep.name, orientation: rep.orientation, positions: outPositions });
    }

    return {
        repertoires: outReps,
        currentEpoch: persisted.currentEpoch ?? 0,
        lastPlayedDate: persisted.lastPlayedDate as unknown as Date, // normalize() re-hydrates
        dailyPlayCount: persisted.dailyPlayCount ?? 0,
        settings: persisted.settings,
        activity: persisted.activity,
        games: persisted.games,
    };
}
