import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    bootstrapRepertoiresFromLegacy,
    extractFsrsCardsFromRepertoires,
    extractAnnotationsFromRepertoires,
    projectFsrsCardsIntoRepertoires,
    pruneEmptyAnnotations,
} from './RepertoiresSerde';
import { OpeningVariantData } from '../models/RepertoireData';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService } from '../services/FSRSService';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { State } from 'ts-fsrs';
import { createEmptyRepertoires } from '../models/Repertoires';

function variant(pgn: string, orientation: 'white' | 'black'): OpeningVariantData {
    return {
        pgn,
        orientation,
        classifications: [],
    };
}

function startFen(): string {
    return normalizeFenResetHalfmoveClock(new Chess().fen());
}

function fenAfter(moves: string[]): string {
    const c = new Chess();
    for (const m of moves) c.move(m);
    return normalizeFenResetHalfmoveClock(c.fen());
}

function reviewCard(): FSRSCardData {
    return { d: '2030-01-01T00:00:00.000Z', s: 50, di: 2, e: 5, sd: 30, ls: 0, r: 10, l: 1, st: State.Review };
}

describe('RepertoiresSerde', () => {
    describe('bootstrapRepertoiresFromLegacy', () => {
        it('always returns both White and Black entries (spec invariant)', () => {
            const reps = bootstrapRepertoiresFromLegacy([], {});
            expect(reps).toHaveLength(2);
            expect(reps.map(r => r.orientation).sort()).toEqual(['black', 'white']);
            expect(reps[0].positions).toEqual({});
            expect(reps[1].positions).toEqual({});
        });

        it('seeds both entries even when only white variants are provided', () => {
            const reps = bootstrapRepertoiresFromLegacy([variant('1. e4', 'white')], {});
            const white = reps.find(r => r.orientation === 'white')!;
            const black = reps.find(r => r.orientation === 'black')!;
            expect(Object.keys(white.positions).length).toBeGreaterThan(0);
            expect(black.positions).toEqual({});
            expect(black.name).toBe('Black');
            expect(white.name).toBe('White');
        });

        it('attaches FSRS cards only to user-turn moves; opponent moves are `{}`', () => {
            const reps = bootstrapRepertoiresFromLegacy([variant('1. e4 e5', 'white')], {});
            const white = reps.find(r => r.orientation === 'white')!;
            const root = startFen();
            const afterE4 = fenAfter(['e4']);
            // 1.e4 — white's move (user) → card slot present (but no legacy card was provided).
            expect(white.positions[root].moves['e4']).toEqual({});
            // 1...e5 — black's move (opponent for white repertoire) → always `{}`.
            expect(white.positions[afterE4].moves['e5']).toEqual({});
        });

        it('places legacy fsrsCards on the right edges', () => {
            const root = startFen();
            const cardKey = FSRSService.makeCardKey(root, 'e4');
            const c = reviewCard();
            const reps = bootstrapRepertoiresFromLegacy(
                [variant('1. e4 e5', 'white')],
                { [cardKey]: c },
            );
            const white = reps.find(r => r.orientation === 'white')!;
            expect(white.positions[root].moves['e4'].card).toEqual(c);
        });

        it('preserves both arrow and square annotations from PGN comments (B1 regression)', () => {
            // Comment after 1.e4 has both an arrow and a square.
            const pgn = '1. e4 { [%cal Re2e4] [%csl Yd4] } e5';
            const reps = bootstrapRepertoiresFromLegacy([variant(pgn, 'white')], {});
            const white = reps.find(r => r.orientation === 'white')!;
            const afterE4 = fenAfter(['e4']);
            const anns = white.positions[afterE4].annotations ?? [];
            // Arrow R e2→e4
            expect(anns).toEqual(expect.arrayContaining([
                expect.objectContaining({ brush: 'R', orig: 'e2', dest: 'e4' }),
            ]));
            // Square Y d4 (no dest field)
            const square = anns.find(a => a.brush === 'Y' && a.orig === 'd4');
            expect(square).toBeDefined();
            expect(square!.dest).toBeUndefined();
        });

        it('merges PGN edges across white+black variants — shared edges keep cards on the user-turn side', () => {
            // Both colors include the move 1.e4. For white it's user; for black it's opponent.
            const reps = bootstrapRepertoiresFromLegacy(
                [variant('1. e4', 'white'), variant('1. e4 e5', 'black')],
                {},
            );
            const white = reps.find(r => r.orientation === 'white')!;
            const black = reps.find(r => r.orientation === 'black')!;
            const root = startFen();
            // White repertoire has the e4 move (user turn).
            expect(white.positions[root].moves['e4']).toBeDefined();
            // Black repertoire also has the e4 move (opponent move).
            expect(black.positions[root].moves['e4']).toEqual({});
        });

        it('dedupes duplicate annotations at the same FEN', () => {
            // Same arrow appears in two variants on the same position.
            const pgn = '1. e4 { [%cal Re2e4] } e5';
            const reps = bootstrapRepertoiresFromLegacy(
                [variant(pgn, 'white'), variant(pgn, 'white')],
                {},
            );
            const white = reps.find(r => r.orientation === 'white')!;
            const afterE4 = fenAfter(['e4']);
            const anns = white.positions[afterE4].annotations ?? [];
            expect(anns.filter(a => a.brush === 'R' && a.orig === 'e2' && a.dest === 'e4')).toHaveLength(1);
        });

        it('silently skips malformed PGNs without throwing', () => {
            expect(() =>
                bootstrapRepertoiresFromLegacy([variant('this is not a pgn', 'white')], {}),
            ).not.toThrow();
        });
    });

    describe('extractFsrsCardsFromRepertoires', () => {
        it('returns only user-turn cards keyed by `${fen}::${san}`', () => {
            const reps = createEmptyRepertoires();
            const root = startFen();
            const afterE4 = fenAfter(['e4']);
            const card = reviewCard();
            reps[0].positions[root] = { moves: { e4: { card } } };
            // Opponent (black) reply position in the WHITE repertoire — must be ignored.
            reps[0].positions[afterE4] = { moves: { e5: {} } };

            const out = extractFsrsCardsFromRepertoires(reps);
            expect(out[FSRSService.makeCardKey(root, 'e4')]).toEqual(card);
            expect(Object.keys(out)).toHaveLength(1);
        });
    });

    describe('projectFsrsCardsIntoRepertoires', () => {
        it('syncs an updated card from the flat map into the dict', () => {
            const reps = createEmptyRepertoires();
            const root = startFen();
            reps[0].positions[root] = { moves: { e4: {} } };

            const newCard = reviewCard();
            const cardKey = FSRSService.makeCardKey(root, 'e4');
            projectFsrsCardsIntoRepertoires(reps, { [cardKey]: newCard });
            expect(reps[0].positions[root].moves['e4'].card).toEqual(newCard);
        });

        it('clears the card field if the flat map no longer has that key', () => {
            const reps = createEmptyRepertoires();
            const root = startFen();
            reps[0].positions[root] = { moves: { e4: { card: reviewCard() } } };

            projectFsrsCardsIntoRepertoires(reps, {});
            expect(reps[0].positions[root].moves['e4'].card).toBeUndefined();
        });

        it('strips any card accidentally attached to an opponent move', () => {
            const reps = createEmptyRepertoires();
            const afterE4 = fenAfter(['e4']);
            // Bogus state: black-to-move position in WHITE repertoire has a card.
            reps[0].positions[afterE4] = { moves: { e5: { card: reviewCard() } } };

            projectFsrsCardsIntoRepertoires(reps, {});
            expect(reps[0].positions[afterE4].moves['e5'].card).toBeUndefined();
        });
    });

    describe('pruneEmptyAnnotations', () => {
        it('deletes empty annotation arrays', () => {
            const reps = createEmptyRepertoires();
            const root = startFen();
            reps[0].positions[root] = { moves: {}, annotations: [] };

            pruneEmptyAnnotations(reps);
            expect(reps[0].positions[root].annotations).toBeUndefined();
        });

        it('preserves non-empty annotation arrays', () => {
            const reps = createEmptyRepertoires();
            const root = startFen();
            reps[0].positions[root] = {
                moves: {},
                annotations: [{ brush: 'G', orig: 'e2', dest: 'e4' }],
            };

            pruneEmptyAnnotations(reps);
            expect(reps[0].positions[root].annotations).toHaveLength(1);
        });
    });

    describe('extractAnnotationsFromRepertoires', () => {
        it('partitions annotations per-orientation, no cross-orientation merge', () => {
            const reps = createEmptyRepertoires();
            const root = startFen();
            reps[0].positions[root] = {
                moves: {},
                annotations: [{ brush: 'G', orig: 'e2', dest: 'e4' }],
            };
            reps[1].positions[root] = {
                moves: {},
                annotations: [{ brush: 'R', orig: 'd7', dest: 'd5' }],
            };
            const per = extractAnnotationsFromRepertoires(reps);
            expect(per.white.get(root)).toEqual([{ brush: 'G', orig: 'e2', dest: 'e4' }]);
            expect(per.black.get(root)).toEqual([{ brush: 'R', orig: 'd7', dest: 'd5' }]);
        });
    });
});
