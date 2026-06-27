import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { isSingleAddedLine, buildAddedLineFrames } from './ReviewAnimation';
import { PendingDelta, EditChain, EditedEdge } from '../services/PendingEditModel';

// ── Builders ──────────────────────────────────────────────────────────

function edge(from: string, to: string, san: string): EditedEdge {
    return { orientation: 'white', from, to, san };
}

/**
 * Build an added chain from a flat SAN line by replaying through chess.js.
 * `parentPlies` are the moves already in the repertoire (the chain's anchor
 * path); `newPlies` are the freshly-added moves (head + tail).
 */
function chainFromLine(parentPlies: string[], newPlies: string[]): EditChain {
    const chess = new Chess();
    for (const s of parentPlies) chess.move(s);
    const parentPgn = parentPlies.length ? chess.pgn() : '';

    const edges: EditedEdge[] = [];
    for (const san of newPlies) {
        const from = chess.fen();
        chess.move(san);
        edges.push(edge(from, chess.fen(), san));
    }
    const [head, ...tail] = edges;
    return {
        orientation: 'white',
        head,
        tail,
        chainPgn: chess.pgn(),
        parentPgn,
    };
}

function deltaWith(partial: Partial<PendingDelta>): PendingDelta {
    return {
        addedChains: [],
        removedChains: [],
        editedAnnotations: [],
        counts: { added: 0, removed: 0, changed: 0 },
        ...partial,
    };
}

const anyChain = chainFromLine([], ['e4']);
const anyAnnDiff = {
    orientation: 'white' as const,
    fen: 'x',
    pgn: '',
    before: [],
    after: [{ brush: 'G' as const, orig: 'e2', dest: 'e4' }],
};

// ── isSingleAddedLine ─────────────────────────────────────────────────

describe('isSingleAddedLine', () => {
    it('is true for exactly one added chain and nothing else', () => {
        expect(isSingleAddedLine(deltaWith({ addedChains: [anyChain] }))).toBe(true);
    });

    it('is false when there are zero added chains', () => {
        expect(isSingleAddedLine(deltaWith({}))).toBe(false);
    });

    it('is false when there are multiple added chains', () => {
        expect(isSingleAddedLine(deltaWith({ addedChains: [anyChain, anyChain] }))).toBe(false);
    });

    it('is false when a removal is also present', () => {
        expect(
            isSingleAddedLine(deltaWith({ addedChains: [anyChain], removedChains: [anyChain] })),
        ).toBe(false);
    });

    it('is false when an annotation edit is also present', () => {
        expect(
            isSingleAddedLine(deltaWith({ addedChains: [anyChain], editedAnnotations: [anyAnnDiff] })),
        ).toBe(false);
    });
});

// ── buildAddedLineFrames ──────────────────────────────────────────────

describe('buildAddedLineFrames', () => {
    it('starts at the anchor and adds one frame per ply', () => {
        const chain = chainFromLine(['e4', 'c5'], ['Nf3', 'd6', 'd4']);
        const res = buildAddedLineFrames(chain);
        expect(res).not.toBeNull();
        // anchor + 3 plies
        expect(res!.frames).toHaveLength(4);
        expect(res!.arrows).toHaveLength(4);
        expect(res!.sans).toHaveLength(4);
        // Anchor frame matches the parent position (after 1.e4 c5).
        const anchor = new Chess();
        anchor.move('e4');
        anchor.move('c5');
        expect(res!.frames[0]).toBe(anchor.fen());
        // Anchor has no incoming move.
        expect(res!.arrows[0]).toBeNull();
        expect(res!.sans[0]).toBe('');
    });

    it('produces consecutive frames exactly one legal move apart', () => {
        const chain = chainFromLine(['e4'], ['e5', 'Nf3', 'Nc6', 'Bb5']);
        const res = buildAddedLineFrames(chain)!;
        // Each adjacent pair must be reconstructable by replaying one legal
        // move from the previous frame — the invariant ChessboardControl's
        // detectMove relies on to animate the glide.
        for (let i = 1; i < res.frames.length; i++) {
            const prev = new Chess(res.frames[i - 1]);
            const legal = prev.moves({ verbose: true });
            const match = legal.some(m => {
                const t = new Chess(res.frames[i - 1]);
                t.move(m);
                return t.fen() === res.frames[i];
            });
            expect(match).toBe(true);
        }
    });

    it('records a green arrow matching each played move', () => {
        const chain = chainFromLine([], ['e4', 'e5', 'Nf3']);
        const res = buildAddedLineFrames(chain)!;
        expect(res.arrows[1]).toEqual({ brush: 'G', orig: 'e2', dest: 'e4' });
        expect(res.arrows[2]).toEqual({ brush: 'G', orig: 'e7', dest: 'e5' });
        expect(res.arrows[3]).toEqual({ brush: 'G', orig: 'g1', dest: 'f3' });
    });

    it('handles a root anchor (empty parentPgn)', () => {
        const chain = chainFromLine([], ['d4']);
        const res = buildAddedLineFrames(chain)!;
        expect(res.frames[0]).toBe(new Chess().fen());
        expect(res.frames).toHaveLength(2);
    });

    it('returns null when the parent PGN cannot be replayed', () => {
        const chain = chainFromLine([], ['e4']);
        const bad: EditChain = { ...chain, parentPgn: 'this is not pgn 1. zz' };
        expect(buildAddedLineFrames(bad)).toBeNull();
    });

    it('returns null when a chain SAN is illegal from the anchor', () => {
        const chain = chainFromLine([], ['e4']);
        const bad: EditChain = {
            ...chain,
            head: { ...chain.head, san: 'Qh5xz' },
        };
        expect(buildAddedLineFrames(bad)).toBeNull();
    });
});
