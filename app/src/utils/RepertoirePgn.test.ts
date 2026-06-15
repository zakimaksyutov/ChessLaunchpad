import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    encodeRepertoirePgn,
    decodeRepertoirePgn,
    RepertoirePgnError,
} from './RepertoirePgn';
import { RepertoireEntry, PositionEntry } from '../models/Repertoires';
import { Annotation } from '../models/Annotation';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

function makeEmptyRep(orientation: 'white' | 'black'): RepertoireEntry {
    return {
        name: orientation === 'white' ? 'White' : 'Black',
        orientation,
        positions: {},
    };
}

function rootFen(): string {
    return normalizeFenResetHalfmoveClock(new Chess().fen());
}

/**
 * Build a small repertoire from a list of SAN paths (mainline + variations).
 * Each path is an array of SANs played in sequence from the start. Used for
 * tests so we don't have to hand-craft normalized FENs.
 */
function buildRepFromPaths(
    orientation: 'white' | 'black',
    paths: string[][],
    annotations?: Record<string, Annotation[]>,
): RepertoireEntry {
    const rep = makeEmptyRep(orientation);
    rep.positions[rootFen()] = { moves: {} };
    for (const path of paths) {
        const chess = new Chess();
        let fen = rootFen();
        for (const san of path) {
            const before = chess.fen();
            const moved = chess.move(san);
            if (!moved) throw new Error(`bad SAN ${san} from ${before}`);
            const after = normalizeFenResetHalfmoveClock(chess.fen());
            const beforeNorm = normalizeFenResetHalfmoveClock(before);
            if (!rep.positions[beforeNorm]) rep.positions[beforeNorm] = { moves: {} };
            if (!rep.positions[after]) rep.positions[after] = { moves: {} };
            if (!rep.positions[beforeNorm].moves[san]) {
                rep.positions[beforeNorm].moves[san] = { to: after };
            }
            fen = after;
        }
        void fen;
    }
    if (annotations) {
        for (const [fen, ann] of Object.entries(annotations)) {
            const pos: PositionEntry | undefined = rep.positions[fen];
            if (pos) pos.annotations = ann;
        }
    }
    return rep;
}

describe('encodeRepertoirePgn / decodeRepertoirePgn', () => {
    describe('headers', () => {
        it('emits a [Repertoire "White"] header for a white repertoire', () => {
            const rep = buildRepFromPaths('white', [['e4', 'e5']]);
            const pgn = encodeRepertoirePgn(rep);
            expect(pgn).toContain('[Repertoire "White"]');
        });

        it('emits a [Repertoire "Black"] header for a black repertoire', () => {
            const rep = buildRepFromPaths('black', [['e4', 'e5']]);
            const pgn = encodeRepertoirePgn(rep);
            expect(pgn).toContain('[Repertoire "Black"]');
        });
    });

    describe('round-trip', () => {
        it('round-trips a single-line mainline', () => {
            const rep = buildRepFromPaths('white', [['e4', 'e5', 'Nf3', 'Nc6']]);
            const pgn = encodeRepertoirePgn(rep);
            const decoded = decodeRepertoirePgn(pgn);
            expect(decoded.orientation).toBe('white');
            const sans = decoded.edges.map(e => e.san);
            expect(sans).toContain('e4');
            expect(sans).toContain('e5');
            expect(sans).toContain('Nf3');
            expect(sans).toContain('Nc6');
            expect(decoded.edges.length).toBe(4);
        });

        it('round-trips a mainline + a sibling variation at the root', () => {
            const rep = buildRepFromPaths('white', [
                ['e4', 'e5'],
                ['d4', 'd5'],
            ]);
            const pgn = encodeRepertoirePgn(rep);
            const decoded = decodeRepertoirePgn(pgn);

            // 4 edges: e4, e5 (from after-e4), d4, d5 (from after-d4).
            expect(decoded.edges.length).toBe(4);
            // Same root has two outgoing white moves: e4 and d4.
            const fromRoot = decoded.edges
                .filter(e => e.from === rootFen())
                .map(e => e.san)
                .sort();
            expect(fromRoot).toEqual(['d4', 'e4']);
        });

        it('round-trips a mainline + a variation at depth 2', () => {
            const rep = buildRepFromPaths('white', [
                ['e4', 'e5', 'Nf3', 'Nc6'],
                ['e4', 'c5', 'Nf3', 'd6'],
            ]);
            const pgn = encodeRepertoirePgn(rep);
            const decoded = decodeRepertoirePgn(pgn);

            // Edges: e4, e5, c5, Nf3 (after-e5), Nc6, Nf3 (after-c5), d6.
            // The two Nf3 edges have different `from` FENs so both survive.
            const keys = decoded.edges.map(e => `${e.from}::${e.san}`).sort();
            expect(keys.length).toBe(7);
            const sansFromRoot = decoded.edges
                .filter(e => e.from === rootFen())
                .map(e => e.san);
            expect(sansFromRoot).toEqual(['e4']);
        });

        it('handles a transposition: same FEN reached two ways collapses on decode', () => {
            // 1. e4 c5 2. Nf3 e6  and  1. e4 c5 2. Nf3 e6 (alternative mover order
            // that reaches the same FEN — chosen so both paths' fourth move ends
            // on the same normalized FEN).
            const rep = buildRepFromPaths('white', [
                ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'e6'],
                ['e4', 'c5', 'Nf3', 'e6', 'd4', 'cxd4', 'Nxd4', 'Nc6'],
            ]);
            // The transposition is real — verify it by checking that both
            // 8-ply paths normalize to the same FEN at ply 8.
            const a = new Chess(); for (const s of ['e4','c5','Nf3','Nc6','d4','cxd4','Nxd4','e6']) a.move(s);
            const b = new Chess(); for (const s of ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','Nc6']) b.move(s);
            expect(normalizeFenResetHalfmoveClock(a.fen())).toBe(normalizeFenResetHalfmoveClock(b.fen()));

            const pgn = encodeRepertoirePgn(rep);
            const decoded = decodeRepertoirePgn(pgn);

            // After decode, each unique (from, san) edge is recorded once.
            const keys = new Set(decoded.edges.map(e => `${e.from}::${e.san}`));
            expect(keys.size).toBe(decoded.edges.length);
        });

        it('is byte-deterministic across calls', () => {
            const rep = buildRepFromPaths('white', [
                ['e4', 'e5', 'Nf3', 'Nc6'],
                ['d4', 'd5', 'c4'],
            ]);
            const a = encodeRepertoirePgn(rep);
            const b = encodeRepertoirePgn(rep);
            // Strip the dynamic Date header so the comparison is meaningful.
            const stripDate = (s: string) => s.replace(/\[Date "[^"]*"\]/g, '[Date "X"]');
            expect(stripDate(a)).toBe(stripDate(b));
        });
    });

    describe('annotations', () => {
        it('emits and round-trips arrow + square annotations', () => {
            const annsAfterE4: Annotation[] = [
                { brush: 'G', orig: 'e2', dest: 'e4' },
                { brush: 'Y', orig: 'f7' },
            ];
            const chess = new Chess();
            chess.move('e4');
            const afterE4 = normalizeFenResetHalfmoveClock(chess.fen());

            const rep = buildRepFromPaths('white', [['e4', 'e5']], {
                [afterE4]: annsAfterE4,
            });
            const pgn = encodeRepertoirePgn(rep);
            expect(pgn).toMatch(/\[%cal Ge2e4\]/);
            expect(pgn).toMatch(/\[%csl Yf7\]/);
            const decoded = decodeRepertoirePgn(pgn);
            const anns = decoded.annotationsByFen.get(afterE4);
            expect(anns).toBeDefined();
            expect(anns).toHaveLength(2);
            expect(anns).toEqual(expect.arrayContaining([
                expect.objectContaining({ brush: 'G', orig: 'e2', dest: 'e4' }),
                expect.objectContaining({ brush: 'Y', orig: 'f7' }),
            ]));
        });

        it('attaches a root annotation as a starting comment', () => {
            const rootAnns: Annotation[] = [
                { brush: 'R', orig: 'e1' },
            ];
            const rep = buildRepFromPaths('white', [['e4']], { [rootFen()]: rootAnns });
            const pgn = encodeRepertoirePgn(rep);
            // The starting comment appears before "1. e4".
            const idxOfComment = pgn.indexOf('[%csl Re1]');
            const idxOfMove = pgn.indexOf('1.');
            expect(idxOfComment).toBeGreaterThan(0);
            expect(idxOfComment).toBeLessThan(idxOfMove);
            const decoded = decodeRepertoirePgn(pgn);
            expect(decoded.annotationsByFen.get(rootFen())).toEqual([
                { brush: 'R', orig: 'e1' },
            ]);
        });

        it('decode does not record plain-text comments as annotations', () => {
            const text = `[Event "x"]\n[Repertoire "White"]\n\n1. e4 {a friendly remark} e5 *\n`;
            const decoded = decodeRepertoirePgn(text);
            expect(decoded.annotationsByFen.size).toBe(0);
        });

        it('decode does not record empty comments as annotations', () => {
            const text = `[Event "x"]\n[Repertoire "White"]\n\n1. e4 {} e5 *\n`;
            const decoded = decodeRepertoirePgn(text);
            expect(decoded.annotationsByFen.size).toBe(0);
        });

        it('decode does not record empty [%cal] / [%csl] markers (cannot CLEAR existing annotations)', () => {
            // Spec: "a PGN import can add or replace annotations but cannot
            // clear them." An empty/garbage structured marker must NOT cause
            // a downstream merge to wipe out existing annotations.
            const cases = [
                `[Repertoire "White"]\n\n1. e4 {[%cal ]} *\n`,
                `[Repertoire "White"]\n\n1. e4 {[%csl ]} *\n`,
                `[Repertoire "White"]\n\n1. e4 {[%cal Xe2e4]} *\n`, // bad brush
                `[Repertoire "White"]\n\n1. e4 {[%cal Gd1]} *\n`,   // malformed coord
            ];
            for (const text of cases) {
                const decoded = decodeRepertoirePgn(text);
                expect(decoded.annotationsByFen.size).toBe(0);
            }
        });
    });

    describe('variations', () => {
        it('decode handles parenthesized variations (lichess-style)', () => {
            const text = `[Event "x"]\n[Repertoire "White"]\n\n1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *\n`;
            const decoded = decodeRepertoirePgn(text);
            const keys = decoded.edges.map(e => e.san).sort();
            expect(keys).toEqual(['Nf3', 'Nf3', 'c5', 'e4', 'e5']);
        });

        it('decode handles sibling variations branching from the same parent move', () => {
            // After 1. e4: e5, c5, e6 all alternatives.
            const text = `[Event "x"]\n[Repertoire "White"]\n\n1. e4 e5 (1... c5) (1... e6) *\n`;
            const decoded = decodeRepertoirePgn(text);
            const afterE4 = (() => { const c = new Chess(); c.move('e4'); return normalizeFenResetHalfmoveClock(c.fen()); })();
            const sansFromAfterE4 = decoded.edges.filter(e => e.from === afterE4).map(e => e.san).sort();
            expect(sansFromAfterE4).toEqual(['c5', 'e5', 'e6']);
        });

        it('decode handles nested variations', () => {
            const text = `[Event "x"]\n[Repertoire "White"]\n\n1. e4 e5 (1... c5 (1... e6 2. d4)) *\n`;
            const decoded = decodeRepertoirePgn(text);
            const sans = decoded.edges.map(e => e.san).sort();
            expect(sans).toContain('c5');
            expect(sans).toContain('e6');
            expect(sans).toContain('d4');
        });
    });

    describe('rejections', () => {
        it('rejects empty input', () => {
            expect(() => decodeRepertoirePgn('')).toThrow(RepertoirePgnError);
            expect(() => decodeRepertoirePgn('   \n\n')).toThrow(RepertoirePgnError);
        });

        it('rejects missing [Repertoire] header', () => {
            expect(() => decodeRepertoirePgn(`[Event "x"]\n\n1. e4 *\n`))
                .toThrow(/Repertoire/);
        });

        it('accepts a bare movetext snippet when a defaultOrientation is supplied (paste-box flow)', () => {
            // No headers, no `[Repertoire]` — the paste-box path supplies
            // the orientation context separately.
            const text = `1. e4 e5 2. Nf3 *`;
            const decoded = decodeRepertoirePgn(text, { defaultOrientation: 'white' });
            expect(decoded.orientation).toBe('white');
            expect(decoded.edges.length).toBe(3);
        });

        it('still honors an explicit [Repertoire] header even when defaultOrientation is supplied (header wins as safety net)', () => {
            const text = `[Repertoire "Black"]\n\n1. e4 e5 *`;
            const decoded = decodeRepertoirePgn(text, { defaultOrientation: 'white' });
            expect(decoded.orientation).toBe('black');
        });

        it('rejects [Repertoire] header with unexpected value', () => {
            expect(() => decodeRepertoirePgn(`[Repertoire "Both"]\n\n1. e4 *\n`))
                .toThrow(/White|Black/);
        });

        it('rejects [FEN] header (non-standard starting position)', () => {
            const text = `[Repertoire "White"]\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 *\n`;
            expect(() => decodeRepertoirePgn(text)).toThrow(/non-standard starting position|FEN|SetUp/);
        });

        it('rejects multi-game files', () => {
            const text = [
                `[Event "g1"]`,
                `[Repertoire "White"]`,
                ``,
                `1. e4 *`,
                ``,
                `[Event "g2"]`,
                `[Repertoire "White"]`,
                ``,
                `1. d4 *`,
                ``,
            ].join('\n');
            expect(() => decodeRepertoirePgn(text)).toThrow(/single-game|multiple/);
        });

        it('rejects multi-game files concatenated within one header block (result-marker delimited)', () => {
            // Two games separated only by `*` — historically the
            // header-block detector missed this and the second game's moves
            // were silently appended to the first, fabricating an edge.
            const text = `[Repertoire "White"]\n\n1. e4 e5 * 1. d4 d5 *\n`;
            expect(() => decodeRepertoirePgn(text)).toThrow(/multiple|single-game/);
        });

        it('rejects two-game files where the second game has only a [Repertoire] header (silent-drop guard)', () => {
            // Historically the header-counting logic produced gameCount=1
            // for both 1-game and 2-game files when the second game had
            // only a single header line, causing the second game (and any
            // data loss it implied) to be silently dropped instead of
            // surfacing a clear error.
            const text = [
                `[Repertoire "White"]`,
                ``,
                `1. e4 e5 *`,
                ``,
                `[Repertoire "Black"]`,
                ``,
                `1. d4 d5 *`,
                ``,
            ].join('\n');
            expect(() => decodeRepertoirePgn(text)).toThrow(/multiple|single-game/);
        });

        it('rejects two-game files with no headers on the second game (movetext-only second game)', () => {
            const text = [
                `[Repertoire "White"]`,
                ``,
                `1. e4 e5 *`,
                ``,
                `1. d4 d5 *`,
                ``,
            ].join('\n');
            expect(() => decodeRepertoirePgn(text)).toThrow(/multiple|single-game/);
        });

        it('rejects illegal SAN', () => {
            const text = `[Repertoire "White"]\n\n1. e4 e9 *\n`;
            expect(() => decodeRepertoirePgn(text)).toThrow(/illegal/);
        });

        it('rejects unmatched parens', () => {
            const text = `[Repertoire "White"]\n\n1. e4 e5 (1... c5 *\n`;
            expect(() => decodeRepertoirePgn(text)).toThrow(/unmatched/);
        });
    });

    describe('tokenizer — compact move-number forms (no space)', () => {
        // PGN §8.2.2 — move-number indication and SAN need NOT be
        // separated by whitespace. Hand-written PGN and some ChessBase /
        // SCID exports emit "1.e4" / "1...e5"; without explicit handling
        // the tokenizer treated each as a single SAN token and chess.js
        // rejected the whole file.

        it('accepts compact white-move form "1.e4 e5 2.Nf3 Nc6"', () => {
            const text = `[Repertoire "White"]\n\n1.e4 e5 2.Nf3 Nc6 *\n`;
            const decoded = decodeRepertoirePgn(text);
            const sans = decoded.edges.map(e => e.san);
            expect(sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
        });

        it('accepts compact black-move form "1...e5" inside a variation', () => {
            // Variation branches as an alternative to the LAST move (c5),
            // so 1...e5 inside the variation is black's alternative reply
            // to 1. e4 — the natural place to encounter "1...SAN" compact
            // form in real PGN.
            const text = `[Repertoire "White"]\n\n1. e4 c5 (1...e5 2.Nf3) 2. Nf3 *\n`;
            const decoded = decodeRepertoirePgn(text);
            const sans = decoded.edges.map(e => e.san);
            expect(sans).toContain('e4');
            expect(sans).toContain('c5');
            expect(sans).toContain('e5');
            expect(sans).toContain('Nf3');
        });

        it('accepts mixed compact + spaced forms in the same file', () => {
            const text = `[Repertoire "White"]\n\n1.e4 e5 2. Nf3 Nc6 3.Bb5 *\n`;
            const decoded = decodeRepertoirePgn(text);
            const sans = decoded.edges.map(e => e.san);
            expect(sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
        });

        it('still accepts bare move numbers ("1." / "1...") as separators', () => {
            const text = `[Repertoire "White"]\n\n1. e4 e5 2. Nf3 *\n`;
            const decoded = decodeRepertoirePgn(text);
            expect(decoded.edges.map(e => e.san)).toEqual(['e4', 'e5', 'Nf3']);
        });
    });

    describe('PGN structure', () => {
        it('produces a portable PGN parseable by chess.js (mainline only)', () => {
            const rep = buildRepFromPaths('white', [['e4', 'e5', 'Nf3', 'Nc6']]);
            const pgn = encodeRepertoirePgn(rep);
            const chess = new Chess();
            // chess.js can't preserve variations but should still parse our
            // mainline content without throwing.
            expect(() => chess.loadPgn(pgn)).not.toThrow();
            // Mainline 4 plies, SANs come back in order.
            expect(chess.history()).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
        });

        it('produces a PGN that survives a chess.js round-trip with variations present', () => {
            const rep = buildRepFromPaths('white', [
                ['e4', 'e5', 'Nf3', 'Nc6'],
                ['d4', 'd5'],
            ]);
            const pgn = encodeRepertoirePgn(rep);
            const chess = new Chess();
            expect(() => chess.loadPgn(pgn)).not.toThrow();
        });

        it('terminates the movetext with "*"', () => {
            const rep = buildRepFromPaths('white', [['e4']]);
            const pgn = encodeRepertoirePgn(rep);
            expect(pgn.trim().endsWith('*')).toBe(true);
        });

        it('handles an empty repertoire (no positions)', () => {
            const rep = makeEmptyRep('white');
            const pgn = encodeRepertoirePgn(rep);
            // No moves emitted; header + "*" present.
            expect(pgn).toContain('[Repertoire "White"]');
            expect(pgn.trim().endsWith('*')).toBe(true);
            const decoded = decodeRepertoirePgn(pgn);
            expect(decoded.edges).toEqual([]);
        });
    });
});
