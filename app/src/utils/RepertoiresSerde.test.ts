import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    extractFsrsCardsFromRepertoires,
    extractAnnotationsFromRepertoires,
    projectFsrsCardsIntoRepertoires,
    pruneEmptyAnnotations,
} from './RepertoiresSerde';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService } from '../services/FSRSService';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { State } from 'ts-fsrs';
import { createEmptyRepertoires } from '../models/Repertoires';

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
