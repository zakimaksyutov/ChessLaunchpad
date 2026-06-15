import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    applyImportedPgnToRepertoires,
    mergeImportedPgnReadMode,
} from './RepertoirePgnMerge';
import { encodeRepertoirePgn, decodeRepertoirePgn } from './RepertoirePgn';
import {
    RepertoireEntry,
    createEmptyRepertoires,
} from '../models/Repertoires';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

function rootFen(): string {
    return normalizeFenResetHalfmoveClock(new Chess().fen());
}

function buildWhiteRepFromPaths(paths: string[][]): RepertoireEntry {
    const reps = createEmptyRepertoires();
    const rep = reps.find(r => r.orientation === 'white')!;
    rep.positions[rootFen()] = { moves: {} };
    for (const path of paths) {
        const chess = new Chess();
        for (const san of path) {
            const before = normalizeFenResetHalfmoveClock(chess.fen());
            const moved = chess.move(san);
            if (!moved) throw new Error(`bad SAN ${san}`);
            const after = normalizeFenResetHalfmoveClock(chess.fen());
            if (!rep.positions[before]) rep.positions[before] = { moves: {} };
            if (!rep.positions[after]) rep.positions[after] = { moves: {} };
            if (!rep.positions[before].moves[san]) {
                rep.positions[before].moves[san] = { to: after };
            }
        }
    }
    return rep;
}

describe('applyImportedPgnToRepertoires', () => {
    it('adds new edges into an empty repertoire and creates FSRS cards on user moves', () => {
        const reps = createEmptyRepertoires();
        const decoded = decodeRepertoirePgn(
            `[Repertoire "White"]\n\n1. e4 e5 2. Nf3 *\n`,
        );
        const cards: Record<string, any> = {};
        const summary = applyImportedPgnToRepertoires(reps, decoded, cards);

        expect(summary.orientation).toBe('white');
        expect(summary.addedEdges).toBe(3);
        const white = reps.find(r => r.orientation === 'white')!;
        // root and after-each-ply.
        expect(Object.keys(white.positions).length).toBe(4);
        // user-turn cards: e4 (white-to-move) and Nf3 (white-to-move).
        // After e5, it's white-to-move; Nf3 is a white move so its card
        // is also user-turn. Total 2 cards.
        expect(Object.keys(cards).length).toBe(2);
    });

    it('preserves existing FSRS cards on already-present edges (union semantics)', () => {
        // Start with e4 already in the rep, then import a PGN that also
        // contains e4 and adds e5 + d4.
        const reps = createEmptyRepertoires();
        const white = reps.find(r => r.orientation === 'white')!;
        white.positions[rootFen()] = { moves: { 'e4': { to: 'placeholder' } } };
        // Replace placeholder `to` with the real FEN.
        const chess = new Chess();
        chess.move('e4');
        const afterE4 = normalizeFenResetHalfmoveClock(chess.fen());
        white.positions[rootFen()].moves['e4'].to = afterE4;
        white.positions[afterE4] = { moves: {} };
        // Pretend a sentinel card was already attached to root → e4.
        const sentinelCard = {
            due: new Date(0).toISOString(),
            stability: 999, difficulty: 1, elapsedDays: 0, scheduledDays: 0,
            learningSteps: 0, reps: 7, lapses: 0, state: 2,
        };
        (white.positions[rootFen()].moves['e4'] as any).card = sentinelCard;
        const cardsOut: Record<string, any> = {
            [`${rootFen()}::e4`]: sentinelCard,
        };

        const decoded = decodeRepertoirePgn(
            `[Repertoire "White"]\n\n1. e4 (1. d4 d5) e5 *\n`,
        );
        const summary = applyImportedPgnToRepertoires(reps, decoded, cardsOut);

        // 3 NEW edges: d4 (root), d5 (after-d4), e5 (after-e4); e4 already
        // present so not counted.
        expect(summary.addedEdges).toBe(3);
        // Sentinel card untouched.
        expect(white.positions[rootFen()].moves['e4'].card).toBe(sentinelCard);
    });

    it('replaces annotations only at positions whose comment carried %cal/%csl', () => {
        // Pre-existing annotation at after-e4.
        const reps = createEmptyRepertoires();
        const white = reps.find(r => r.orientation === 'white')!;
        const root = rootFen();
        const chess = new Chess();
        chess.move('e4');
        const afterE4 = normalizeFenResetHalfmoveClock(chess.fen());
        chess.move('e5');
        const afterE5 = normalizeFenResetHalfmoveClock(chess.fen());

        white.positions[root] = { moves: { 'e4': { to: afterE4 } } };
        white.positions[afterE4] = {
            moves: { 'e5': { to: afterE5 } },
            annotations: [{ brush: 'R', orig: 'a1', dest: 'a8' }],
        };
        white.positions[afterE5] = {
            moves: {},
            annotations: [{ brush: 'G', orig: 'h1' }],
        };
        const cards: Record<string, any> = {};

        // Import a PGN: structured comment at after-e4, plain-text comment
        // at after-e5. Expect after-e4 to be replaced; after-e5 to retain
        // its original annotation.
        const decoded = decodeRepertoirePgn(
            `[Repertoire "White"]\n\n1. e4 {[%cal Ye2e4]} e5 {plaintext note} *\n`,
        );
        const summary = applyImportedPgnToRepertoires(reps, decoded, cards);
        expect(summary.annotationsReplaced).toBe(1);
        expect(white.positions[afterE4].annotations).toEqual([
            { brush: 'Y', orig: 'e2', dest: 'e4' },
        ]);
        // Untouched.
        expect(white.positions[afterE5].annotations).toEqual([
            { brush: 'G', orig: 'h1' },
        ]);
    });

    it('cannot clear existing annotations via an empty/garbage [%cal] / [%csl] token', () => {
        // The spec guarantees that import "can add or replace annotations
        // but cannot clear them" — verify end-to-end (decode → merge) that
        // a structured marker with no valid annotations leaves the
        // pre-existing annotation set untouched.
        const reps = createEmptyRepertoires();
        const white = reps.find(r => r.orientation === 'white')!;
        const root = rootFen();
        const chess = new Chess();
        chess.move('e4');
        const afterE4 = normalizeFenResetHalfmoveClock(chess.fen());

        const original = [{ brush: 'R' as const, orig: 'a1', dest: 'a8' }];
        white.positions[root] = { moves: { 'e4': { to: afterE4 } } };
        white.positions[afterE4] = { moves: {}, annotations: [...original] };

        const decoded = decodeRepertoirePgn(
            `[Repertoire "White"]\n\n1. e4 {[%cal ]} *\n`,
        );
        const summary = applyImportedPgnToRepertoires(reps, decoded, {});
        expect(summary.annotationsReplaced).toBe(0);
        expect(white.positions[afterE4].annotations).toEqual(original);
    });

    it('round-trip preserves the position DAG and annotations', () => {
        const original = buildWhiteRepFromPaths([
            ['e4', 'e5', 'Nf3', 'Nc6'],
            ['d4', 'd5', 'c4'],
        ]);
        // Annotate root and after-e4.
        original.positions[rootFen()].annotations = [
            { brush: 'G', orig: 'e2', dest: 'e4' },
        ];
        const chess = new Chess();
        chess.move('e4');
        const afterE4 = normalizeFenResetHalfmoveClock(chess.fen());
        original.positions[afterE4].annotations = [
            { brush: 'Y', orig: 'e7' },
            { brush: 'R', orig: 'd8', dest: 'h4' },
        ];

        const pgn = encodeRepertoirePgn(original);
        const decoded = decodeRepertoirePgn(pgn);

        const fresh = createEmptyRepertoires();
        const cards: Record<string, any> = {};
        applyImportedPgnToRepertoires(fresh, decoded, cards);
        const importedWhite = fresh.find(r => r.orientation === 'white')!;

        // Same positions present.
        const originalFens = new Set(Object.keys(original.positions));
        const importedFens = new Set(Object.keys(importedWhite.positions));
        expect(importedFens).toEqual(originalFens);

        // Same outgoing SANs at each FEN.
        for (const fen of originalFens) {
            const origSans = Object.keys(original.positions[fen].moves).sort();
            const impSans = Object.keys(importedWhite.positions[fen].moves).sort();
            expect(impSans).toEqual(origSans);
        }

        // Annotations preserved.
        expect(importedWhite.positions[rootFen()].annotations)
            .toEqual([{ brush: 'G', orig: 'e2', dest: 'e4' }]);
        expect(importedWhite.positions[afterE4].annotations)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ brush: 'Y', orig: 'e7' }),
                expect.objectContaining({ brush: 'R', orig: 'd8', dest: 'h4' }),
            ]));
    });

    it('targets only the orientation named in the imported file (other rep untouched)', () => {
        const reps = createEmptyRepertoires();
        const black = reps.find(r => r.orientation === 'black')!;
        // Pre-seed black with a single edge so we can detect any unwanted mutation.
        const chess = new Chess();
        chess.move('d4');
        const afterD4 = normalizeFenResetHalfmoveClock(chess.fen());
        black.positions[rootFen()] = { moves: { d4: { to: afterD4 } } };
        black.positions[afterD4] = { moves: {} };

        // Import a WHITE pgn.
        const decoded = decodeRepertoirePgn(`[Repertoire "White"]\n\n1. e4 *\n`);
        applyImportedPgnToRepertoires(reps, decoded, {});

        // Black unchanged.
        expect(Object.keys(black.positions)).toEqual([rootFen(), afterD4]);
        expect(black.positions[rootFen()].moves).toEqual({ d4: { to: afterD4 } });
    });
});

describe('mergeImportedPgnReadMode', () => {
    it('does not mutate the source repertoire (returns clone)', () => {
        const reps = createEmptyRepertoires();
        const decoded = decodeRepertoirePgn(`[Repertoire "White"]\n\n1. e4 *\n`);
        const { repertoires } = mergeImportedPgnReadMode(reps, {}, decoded);
        // Source still empty.
        const whiteSrc = reps.find(r => r.orientation === 'white')!;
        expect(Object.keys(whiteSrc.positions)).toEqual([]);
        // Clone populated.
        const whiteCloned = repertoires.find(r => r.orientation === 'white')!;
        expect(Object.keys(whiteCloned.positions).length).toBeGreaterThan(0);
    });
});
