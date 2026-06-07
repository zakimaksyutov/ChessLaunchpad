import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    encodePersistedBlob,
    decodePersistedBlob,
    PERSISTED_BLOB_VERSION,
    PersistedBlobV3,
} from './BlobCodec';
import { RepertoireData } from '../models/RepertoireData';
import { RepertoireEntry, PositionEntry } from '../models/Repertoires';
import { FSRSCardData } from '../models/FSRSCardData';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

const startFen = (): string => normalizeFenResetHalfmoveClock(new Chess().fen());

const fenAfter = (sans: string[]): string => {
    const c = new Chess();
    for (const san of sans) c.move(san);
    return normalizeFenResetHalfmoveClock(c.fen());
};

function reviewCard(overrides: Partial<FSRSCardData> = {}): FSRSCardData {
    return {
        d: '2030-01-01T12:34:56.789Z',
        s: 12.5,
        di: 4.2,
        e: 3,
        sd: 7,
        ls: 0,
        r: 8,
        l: 1,
        st: 2,
        lr: '2026-04-19T08:00:00.500Z',
        ...overrides,
    };
}

function newCard(): FSRSCardData {
    return { d: '2026-01-01T00:00:00.000Z', s: 0, di: 0, e: 0, sd: 0, ls: 0, r: 0, l: 0, st: 0 };
}

function whiteRep(positions: Record<string, PositionEntry>): RepertoireEntry {
    return { name: 'White', orientation: 'white', positions };
}
function blackRep(positions: Record<string, PositionEntry> = {}): RepertoireEntry {
    return { name: 'Black', orientation: 'black', positions };
}

function baseData(reps: RepertoireEntry[]): RepertoireData {
    return {
        repertoires: reps,
    };
}

/** JSON-clone a value (drops `undefined`s, matches what hits the wire). */
function jsonClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

describe('BlobCodec', () => {
    describe('encode → decode round-trip', () => {
        it('round-trips a simple White repertoire with one user-turn card', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: { moves: {} },
                }),
                blackRep(),
            ]);

            const enc = encodePersistedBlob(data);
            const dec = decodePersistedBlob(jsonClone(enc));

            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[root].moves.e4.card).toEqual(reviewCard());
            expect(w.positions[fenAfter(['e4'])]).toEqual({ moves: {} });
            const b = dec.repertoires!.find(r => r.orientation === 'black')!;
            expect(b.positions).toEqual({});
        });

        it('round-trips an opponent move (empty envelope)', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: { moves: { e5: {} } },           // Black to move — opponent
                    [fenAfter(['e4', 'e5'])]: { moves: {} },
                }),
                blackRep(),
            ]);

            const enc = encodePersistedBlob(data);
            const dec = decodePersistedBlob(jsonClone(enc));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            // Opponent move — no card; `to` is denormalized by the decoder.
            expect(w.positions[fenAfter(['e4'])].moves.e5.card).toBeUndefined();
        });

        it('round-trips position-level annotations', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: {
                        annotations: [
                            { brush: 'G', orig: 'e2', dest: 'e4' },
                            { brush: 'R', orig: 'e5' },
                        ],
                        moves: { e4: { card: reviewCard() } },
                    },
                    [fenAfter(['e4'])]: { moves: {} },
                }),
                blackRep(),
            ]);

            const dec = decodePersistedBlob(jsonClone(encodePersistedBlob(data)));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[root].annotations).toEqual([
                { brush: 'G', orig: 'e2', dest: 'e4' },
                { brush: 'R', orig: 'e5' },
            ]);
        });

        it('round-trips a card WITHOUT lr (length-9 packed array)', async () => {
            const root = startFen();
            const c = newCard();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: c } } },
                    [fenAfter(['e4'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            const move = enc.repertoires[0].positions[0].moves['e4:1'];
            expect(move.card).toHaveLength(9);
            const dec = decodePersistedBlob(jsonClone(enc));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[root].moves.e4.card).toEqual(c);
        });

        it('preserves epoch-ms precision on lr', async () => {
            const root = startFen();
            const c = reviewCard({ lr: '2026-04-19T08:00:00.123Z' });
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: c } } },
                    [fenAfter(['e4'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const dec = decodePersistedBlob(jsonClone(encodePersistedBlob(data)));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[root].moves.e4.card!.lr).toBe('2026-04-19T08:00:00.123Z');
        });

        it('round-trips deeper lines with a cycle that returns to root (cycle-safe walk)', async () => {
            // 1.Nf3 Nf6 2.Ng1 Ng8 transposes back to the standard start FEN.
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { Nf3: { card: reviewCard() } } },
                    [fenAfter(['Nf3'])]: { moves: { Nf6: {} } },
                    [fenAfter(['Nf3', 'Nf6'])]: { moves: { Ng1: { card: reviewCard() } } },
                    [fenAfter(['Nf3', 'Nf6', 'Ng1'])]: { moves: { Ng8: {} } },
                    // 1.Nf3 Nf6 2.Ng1 Ng8 → back to root; the cycle must not loop.
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            // The Ng8 edge must point back at index 0 (the cycle).
            const ng8Entry = enc.repertoires[0].positions[3];
            expect(Object.keys(ng8Entry.moves)).toEqual(['Ng8:0']);

            const dec = decodePersistedBlob(jsonClone(enc));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(Object.keys(w.positions[root].moves).sort()).toEqual(['Nf3']);
            expect(w.positions[fenAfter(['Nf3', 'Nf6', 'Ng1'])].moves.Ng8.card).toBeUndefined();
        });

        it('collapses transpositions to a single index (1.e4 e5 2.Nf3 == 1.Nf3 e5 2.e4)', async () => {
            // Both move orders reach the same FEN-after-{e4,e5,Nf3} position.
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() }, Nf3: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: { moves: { e5: {} } },
                    [fenAfter(['e4', 'e5'])]: { moves: { Nf3: { card: reviewCard() } } },
                    [fenAfter(['Nf3'])]: { moves: { e5: {} } },
                    [fenAfter(['Nf3', 'e5'])]: { moves: { e4: { card: reviewCard() } } },
                    // Both 1.e4 e5 2.Nf3 and 1.Nf3 e5 2.e4 reach the same position.
                    [fenAfter(['e4', 'e5', 'Nf3'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            // 6 distinct positions in the in-memory model → 6 array entries.
            expect(enc.repertoires[0].positions).toHaveLength(6);

            // The transposed leaf should be reachable by both index pointers.
            // Find the indices of the two parents and check their children agree.
            const wEnc = enc.repertoires[0];
            const leafFen = fenAfter(['e4', 'e5', 'Nf3']);

            // Round-trip retains the leaf as a single in-memory entry.
            const dec = decodePersistedBlob(jsonClone(enc));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[leafFen]).toEqual({ moves: {} });
            // Sanity: the two parent positions both list the leaf in their moves.
            expect(w.positions[fenAfter(['e4', 'e5'])].moves.Nf3.card).toBeDefined();
            expect(w.positions[fenAfter(['Nf3', 'e5'])].moves.e4.card).toBeDefined();

            // Both transposition edges must point at the same child index in the wire blob.
            const e4e5Entry = wEnc.positions.find(p =>
                Object.keys(p.moves).some(k => k.startsWith('Nf3:'))
                && Object.keys(p.moves).length === 1
            );
            const nf3e5Entry = wEnc.positions.find(p =>
                Object.keys(p.moves).some(k => k.startsWith('e4:'))
                && Object.keys(p.moves).length === 1
            );
            expect(e4e5Entry).toBeDefined();
            expect(nf3e5Entry).toBeDefined();
            const nf3IdxFromE5 = Number(Object.keys(e4e5Entry!.moves)[0].split(':')[1]);
            const e4IdxFromE5  = Number(Object.keys(nf3e5Entry!.moves)[0].split(':')[1]);
            expect(nf3IdxFromE5).toBe(e4IdxFromE5);
        });

        it('round-trips a Black repertoire with an opponent-first-move shape', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({}),
                blackRep({
                    [root]: { moves: { e4: {} } },                       // White to move — opponent
                    [fenAfter(['e4'])]: { moves: { c5: { card: reviewCard() } } },
                    [fenAfter(['e4', 'c5'])]: { moves: {} },
                }),
            ]);
            const dec = decodePersistedBlob(jsonClone(encodePersistedBlob(data)));
            const b = dec.repertoires!.find(r => r.orientation === 'black')!;
            expect(b.positions[fenAfter(['e4'])].moves.c5.card).toEqual(reviewCard());
        });

        it('preserves settings / activity / games', async () => {
            const root = startFen();
            const data: RepertoireData = {
                ...baseData([
                    whiteRep({
                        [root]: { moves: { e4: { card: reviewCard() } } },
                        [fenAfter(['e4'])]: { moves: {} },
                    }),
                    blackRep(),
                ]),
                settings: { contextDepth: 4, retention: 0.97 },
                activity: {
                    practiceLog: [
                        { date: '2026-05-25', reviewed: 10, mistakes: 2, learned: 1, traversals: 3, timeSeconds: 300 },
                    ],
                    lifetime: { reviewed: 100, mistakes: 20, learned: 10, traversals: 50, timeSeconds: 5000 },
                },
                games: { 'lichess:foo': { watermarkMs: 1234567890123, recentIds: [{ id: 'g1', ts: 1234567890000 }] } },
            };
            const enc = encodePersistedBlob(data);
            const dec = decodePersistedBlob(jsonClone(enc));

            expect(dec.settings?.contextDepth).toBe(4);
            expect(dec.activity?.practiceLog).toHaveLength(1);
            expect(dec.games?.['lichess:foo'].watermarkMs).toBe(1234567890123);
            expect(dec.games?.['lichess:foo'].recentIds[0]).toEqual({ id: 'g1', ts: 1234567890000 });
        });
    });

    describe('encode shape', () => {
        it('stamps the version flag and uses array-of-positions with SAN:idx keys', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            expect(enc.v).toBe(PERSISTED_BLOB_VERSION);
            // Literal `3` as a sentinel — if anyone bumps PERSISTED_BLOB_VERSION
            // without realizing the wire format has actually changed shape, this
            // assertion fires and forces them to come back and update the tests
            // (and the spec) to match the new shape.
            expect(enc.v).toBe(3);
            // positions is now an array, not a dict.
            expect(Array.isArray(enc.repertoires[0].positions)).toBe(true);
            expect(enc.repertoires[0].positions).toHaveLength(2);
            // No FEN-y or hash-y dict keys anywhere.
            expect(Object.keys(enc.repertoires[0].positions[0].moves)).toEqual(['e4:1']);
        });

        it('uses "-1" for moves whose child is not stored in the repertoire', async () => {
            const root = startFen();
            // User-move e4 has a card but no child position stored.
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() } } },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            expect(enc.repertoires[0].positions).toHaveLength(1);
            const moves = enc.repertoires[0].positions[0].moves;
            expect(Object.keys(moves)).toEqual(['e4:-1']);
            expect(moves['e4:-1'].card).toBeDefined();

            // Decode: card attaches at parent.moves.e4 in the in-memory model.
            const dec = decodePersistedBlob(jsonClone(enc));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[root].moves.e4.card).toEqual(reviewCard());
            expect(w.positions[fenAfter(['e4'])]).toBeUndefined();
        });

        it('packs cards as 9- or 10-element arrays', async () => {
            const root = startFen();
            const withLr = reviewCard();
            const noLr = newCard();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: withLr }, d4: { card: noLr } } },
                    [fenAfter(['e4'])]: { moves: {} },
                    [fenAfter(['d4'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            const moves = enc.repertoires[0].positions[0].moves;
            // Sorted SAN order: 'd4' before 'e4' (lowercase d < e).
            // BFS visitation order: d4 child is index 1, e4 child is index 2.
            const d4Key = Object.keys(moves).find(k => k.startsWith('d4:'))!;
            const e4Key = Object.keys(moves).find(k => k.startsWith('e4:'))!;
            expect(moves[d4Key].card).toHaveLength(9);
            expect(moves[e4Key].card).toHaveLength(10);
            expect(typeof (moves[e4Key].card as number[])[0]).toBe('number');
            expect(Number.isInteger((moves[e4Key].card as number[])[0])).toBe(true);
        });

        it('produces deterministic byte-identical output for the same in-memory model', async () => {
            const root = startFen();
            const buildData = (): RepertoireData => baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() }, d4: { card: reviewCard() }, Nf3: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: { moves: { c5: {}, e5: {} } },
                    [fenAfter(['d4'])]: { moves: { d5: {}, Nf6: {} } },
                    [fenAfter(['Nf3'])]: { moves: {} },
                    [fenAfter(['e4', 'c5'])]: { moves: {} },
                    [fenAfter(['e4', 'e5'])]: { moves: {} },
                    [fenAfter(['d4', 'd5'])]: { moves: {} },
                    [fenAfter(['d4', 'Nf6'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const a = JSON.stringify(encodePersistedBlob(buildData()));
            const b = JSON.stringify(encodePersistedBlob(buildData()));
            expect(a).toBe(b);
        });

        it('encodes BFS children in sorted SAN order (deterministic index assignment)', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    // Insert moves intentionally out of sorted order in the source dict.
                    [root]: { moves: { e4: { card: reviewCard() }, Nf3: { card: reviewCard() }, d4: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: { moves: {} },
                    [fenAfter(['d4'])]: { moves: {} },
                    [fenAfter(['Nf3'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            const keys = Object.keys(enc.repertoires[0].positions[0].moves);
            // Sorted SAN order: 'Nf3' (uppercase first), 'd4', 'e4'.
            // Each child gets the next available index in that order: 1, 2, 3.
            expect(keys).toEqual(['Nf3:1', 'd4:2', 'e4:3']);
        });
    });

    describe('error paths', () => {
        it('encode throws on orphan position (unreachable from initial FEN)', async () => {
            const root = startFen();
            // A position reachable via 1.e4 e5 but its parent (after 1.e4) is missing
            // from the dict — so the walk from root cannot reach it.
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() } } },
                    // NOTE: `fenAfter(['e4'])` is intentionally missing.
                    [fenAfter(['e4', 'e5'])]: { moves: {} },
                }),
                blackRep(),
            ]);
            expect(() => encodePersistedBlob(data)).toThrow(/orphan position/);
        });

        it('encode throws on a SAN that cannot be replayed (illegal move)', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { Zz9: { card: reviewCard() } } },
                }),
                blackRep(),
            ]);
            expect(() => encodePersistedBlob(data)).toThrow(/illegal move/);
        });

        it('decode throws on unsupported version', async () => {
            const blob = { v: 99, repertoires: [] };
            expect(() => decodePersistedBlob(blob)).toThrow(/unsupported repertoire blob version/i);
        });

        it('decode throws specifically for the interim v2 hashed-key format', async () => {
            const blob = { v: 2, repertoires: [] };
            expect(() => decodePersistedBlob(blob)).toThrow(/unsupported repertoire blob version: 2/);
            // And it mentions the interim/never-shipped status so devs aren't confused.
            expect(() => decodePersistedBlob(blob)).toThrow(/never shipped/);
        });

        it('decode throws when a persisted array index is unreachable from index 0', async () => {
            // Hand-craft a v3 blob with an extra positions entry that no edge points to.
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [
                            // index 0 = start; advertises ONE child (e4 at index 1)
                            { moves: { 'e4:1': { card: [Date.parse('2030-01-01'), 0, 0, 0, 0, 0, 0, 0, 0] } } },
                            // index 1 = position after 1.e4 — reachable
                            { moves: {} },
                            // index 2 = an orphan entry no edge points to
                            { moves: {} },
                        ],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/orphan persisted entries.*\[2\]/);
        });

        it('decode throws on out-of-bounds child index', async () => {
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [
                            // index 0 → e4 should land at 1, but we maliciously write 5.
                            { moves: { 'e4:5': {} } },
                        ],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/out-of-bounds child index 5/);
        });

        it('decode throws on inconsistent child index (two paths → same idx → different FENs)', async () => {
            // Construct a blob where index 1 is reached via two distinct edges that
            // would compute DIFFERENT child FENs. The cross-check must catch it.
            // Setup:
            //   index 0 = start
            //   index 1 = should be position after 1.e4 (per the first edge)
            //   index 2 = position after 1.e4 e5
            //   The malicious second edge: index 2 -> Nf3 -> claims index 1.
            //   But replaying Nf3 from "after e4 e5" gives a DIFFERENT FEN than "after e4".
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [
                            { moves: { 'e4:1': { card: [Date.parse('2030-01-01'), 0, 0, 0, 0, 0, 0, 0, 0] } } },
                            { moves: { 'e5:2': {} } },
                            { moves: { 'Nf3:1': {} } }, // BAD: Nf3 from this position ≠ FEN at index 1.
                        ],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/expects child index 1 to map to FEN/);
        });

        it('decode throws on illegal SAN even when the edge is "-1" (no recursion)', async () => {
            // Without SAN replay-on-`-1`, a corrupt blob with an illegal SAN
            // could silently inject garbage `moves[SAN]` entries.
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [
                            { moves: { 'Zz9:-1': {} } },
                        ],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/illegal move "Zz9"/);
        });

        it('decode throws on malformed move key (missing index)', async () => {
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [{ moves: { 'e4': {} } }],   // missing ":<idx>"
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/malformed move key "e4"/);
        });

        it('decode throws on non-integer index suffix', async () => {
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [{ moves: { 'e4:abc': {} } }],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/malformed move key/);
        });

        it('decode throws when `positions` is not an array', async () => {
            const blob = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [{ name: 'White', orientation: 'white', positions: { foo: {} } }],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/non-array `positions`/);
        });

        it('decode throws when a positions array entry has missing/invalid `moves`', async () => {
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [{} as unknown as never],   // no `moves` at index 0
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/missing\/invalid `moves`/);
        });

        it('decode throws on malformed packed card', async () => {
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [
                            { moves: { 'e4:1': { card: [1, 2, 3] as unknown as never } } },
                            { moves: {} },
                        ],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/malformed packed card/);
        });

        // Each non-finite value below would crash with "RangeError: Invalid time value"
        // (from `new Date(...).toISOString()`) without an explicit guard — that error
        // gives the caller no clue where the bad data came from. The dedicated
        // "malformed packed card" message names the offending element index and value.
        for (const badValue of [NaN, Infinity, -Infinity, null, undefined, '123', true]) {
            it(`decode throws "malformed packed card" on non-finite element (${
                JSON.stringify(badValue)
            }) instead of "Invalid time value"`, () => {
                const card = [badValue, 1, 1, 0, 1, 0, 1, 0, 2] as unknown as never;
                const blob: PersistedBlobV3 = {
                    v: PERSISTED_BLOB_VERSION,
                    repertoires: [
                        {
                            name: 'White', orientation: 'white',
                            positions: [
                                { moves: { 'e4:1': { card } } },
                                { moves: {} },
                            ],
                        },
                        { name: 'Black', orientation: 'black', positions: [] },
                    ],
                    };
                expect(() => decodePersistedBlob(blob)).toThrow(/malformed packed card.*element 0/);
            });
        }

        it('decode throws "malformed packed card" with the offending element index for lr (element 9)', () => {
            const card = [Date.parse('2030-01-01'), 1, 1, 0, 1, 0, 1, 0, 2, NaN] as unknown as never;
            const blob: PersistedBlobV3 = {
                v: PERSISTED_BLOB_VERSION,
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: [
                            { moves: { 'e4:1': { card } } },
                            { moves: {} },
                        ],
                    },
                    { name: 'Black', orientation: 'black', positions: [] },
                ],
                };
            expect(() => decodePersistedBlob(blob)).toThrow(/malformed packed card.*element 9/);
        });
    });

    describe('v1 pass-through', () => {
        it('returns the raw object unchanged when `v` is absent', async () => {
            const v1: RepertoireData = {
                data: [],
            };
            const out = decodePersistedBlob(v1);
            expect(out).toBe(v1);
        });

        it('returns a v1 position-centric blob (with `repertoires`, no `v`) unchanged', async () => {
            const v1: RepertoireData = {
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: { [startFen()]: { moves: { e4: { card: reviewCard() } } } },
                    },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
            };
            const out = decodePersistedBlob(v1);
            expect(out).toBe(v1);
        });
    });

    describe('empty cases', () => {
        it('encodes/decodes a fully empty repertoire pair', async () => {
            const data = baseData([whiteRep({}), blackRep({})]);
            const enc = encodePersistedBlob(data);
            expect(enc.v).toBe(PERSISTED_BLOB_VERSION);
            expect(enc.repertoires[0].positions).toEqual([]);
            expect(enc.repertoires[1].positions).toEqual([]);
            const dec = decodePersistedBlob(jsonClone(enc));
            expect(dec.repertoires).toHaveLength(2);
            expect(dec.repertoires![0].positions).toEqual({});
            expect(dec.repertoires![1].positions).toEqual({});
        });

        it('encodes a leaf position with annotations and no moves', async () => {
            const root = startFen();
            const data = baseData([
                whiteRep({
                    [root]: { moves: { e4: { card: reviewCard() } } },
                    [fenAfter(['e4'])]: {
                        annotations: [{ brush: 'B', orig: 'd5' }],
                        moves: {},
                    },
                }),
                blackRep(),
            ]);
            const enc = encodePersistedBlob(data);
            const dec = decodePersistedBlob(jsonClone(enc));
            const w = dec.repertoires!.find(r => r.orientation === 'white')!;
            expect(w.positions[fenAfter(['e4'])].annotations).toEqual([{ brush: 'B', orig: 'd5' }]);
            expect(w.positions[fenAfter(['e4'])].moves).toEqual({});
        });
    });
});
