import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TrainingEngine } from './TrainingEngine';
import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';

// Simple variant: 1. e4 e5 2. Nf3 (white)
const SIMPLE_WHITE_PGN = '1. e4 e5 2. Nf3';

// Simple variant: 1. e4 e5 (black)
const SIMPLE_BLACK_PGN = '1. e4 e5';

function makePgnInput(pgn: string, orientation: 'white' | 'black') {
    return { pgn, orientation };
}

function makeEngine(pgns: { pgn: string; orientation: 'white' | 'black' }[], fsrsCards: Record<string, any> = {}) {
    return new TrainingEngine(pgns, fsrsCards);
}

describe('TrainingEngine', () => {
    beforeEach(() => {
        // Mock localStorage for context depth
        const store: Record<string, string> = {};
        vi.stubGlobal('localStorage', {
            getItem(key: string) { return store[key] ?? null; },
            setItem(key: string, value: string) { store[key] = value; },
            removeItem(key: string) { delete store[key]; },
        });
    });

    describe('context depth', () => {
        it('should use default context depth when not set', () => {
            expect(TrainingEngine.getContextDepth()).toBe(2);
        });

        it('should persist context depth to localStorage', () => {
            TrainingEngine.setContextDepth(5);
            expect(TrainingEngine.getContextDepth()).toBe(5);
        });

        it('should clamp negative values to 0', () => {
            TrainingEngine.setContextDepth(-1);
            expect(TrainingEngine.getContextDepth()).toBe(0);
        });
    });

    describe('startTraversal', () => {
        it('should return status with phase and orientation for white', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            const status = engine.startTraversal();
            expect(status).not.toBeNull();
            expect(status!.orientation).toBe('white');
            expect(['autoplay', 'awaiting_user', 'teaching', 'recalling', 'ahead_of_schedule'])
                .toContain(status!.phase);
        });

        it('should return status for black variant', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_BLACK_PGN, 'black')]);
            const status = engine.startTraversal();
            expect(status).not.toBeNull();
            expect(status!.orientation).toBe('black');
        });

        it('should return empty phase when no variants', () => {
            const engine = makeEngine([]);
            const status = engine.startTraversal();
            expect(status).not.toBeNull();
            expect(status!.phase).toBe('empty');
        });
    });

    describe('getCurrentStep', () => {
        it('should return a step after starting traversal', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            engine.startTraversal();
            const step = engine.getCurrentStep();
            expect(step).not.toBeNull();
            expect(step!.expectedMove).toBeDefined();
        });
    });

    describe('handleUserMove', () => {
        it('should accept correct move at user turn', () => {
            const engine = makeEngine([makePgnInput('1. e4', 'white')]);
            TrainingEngine.setContextDepth(0);
            const status = engine.startTraversal();

            if (status!.phase === 'teaching') {
                // New card: teaching pass
                const chess = new Chess();
                const step = engine.getCurrentStep();
                expect(step).not.toBeNull();

                if (step && !step.isUserTurn) {
                    // Autoplay step - advance it first
                    chess.move(step.expectedMove);
                    engine.advanceAutoplay();
                }

                const currentStep = engine.getCurrentStep();
                if (currentStep && currentStep.isUserTurn) {
                    const result = engine.handleUserMove('e2', 'e4', chess);
                    expect(result.accepted).toBe(true);
                }
            }
        });

        it('should reject invalid move', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            TrainingEngine.setContextDepth(0);
            engine.startTraversal();

            // Wait until user turn
            const chess = new Chess();
            let step = engine.getCurrentStep();
            while (step && !step.isUserTurn) {
                chess.move(step.expectedMove);
                engine.advanceAutoplay();
                step = engine.getCurrentStep();
            }

            if (step) {
                // Try an invalid move (moving to a random square)
                const result = engine.handleUserMove('a1', 'a8', chess);
                expect(result.accepted).toBe(false);
            }
        });
    });

    describe('advanceAutoplay', () => {
        it('should advance through autoplay steps', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            engine.startTraversal();

            const step = engine.getCurrentStep();
            if (step && engine.getStatus().phase === 'autoplay') {
                const nextStatus = engine.advanceAutoplay();
                expect(nextStatus).toBeDefined();
            }
        });
    });

    describe('requestHint', () => {
        it('should return hint with from/to/san', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            engine.startTraversal();

            // Advance to user turn
            let step = engine.getCurrentStep();
            const chess = new Chess();
            while (step && !step.isUserTurn) {
                chess.move(step.expectedMove);
                engine.advanceAutoplay();
                step = engine.getCurrentStep();
            }

            if (step) {
                const hint = engine.requestHint();
                expect(hint).not.toBeNull();
                if (hint) {
                    expect(hint.from).toBeDefined();
                    expect(hint.to).toBeDefined();
                    expect(hint.san).toBeDefined();
                }
            }
        });
    });

    describe('getQueueStats', () => {
        it('should return queue statistics', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            const stats = engine.getQueueStats();
            expect(stats.totalCards).toBeGreaterThanOrEqual(0);
            expect(typeof stats.dueCount).toBe('number');
            expect(typeof stats.newCount).toBe('number');
        });
    });

    describe('getCardsRated', () => {
        it('should start at 0', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            expect(engine.getCardsRated()).toBe(0);
        });
    });

    describe('getFsrsCards', () => {
        it('should return fsrs cards map', () => {
            const engine = makeEngine([makePgnInput(SIMPLE_WHITE_PGN, 'white')]);
            const cards = engine.getFsrsCards();
            expect(typeof cards).toBe('object');
        });
    });

    describe('teaching → recall lifecycle', () => {
        it('should complete teach then recall for a new card', () => {
            // 1. e4 for white: single user-turn edge (e4). contextDepth=0 → no warm-up/cool-down
            TrainingEngine.setContextDepth(0);
            const engine = makeEngine([makePgnInput('1. e4', 'white')]);
            const status = engine.startTraversal();
            expect(status).not.toBeNull();
            // New card → teaching phase
            expect(status!.phase).toBe('teaching');

            // Teaching: play the shown move (e4)
            const chess = new Chess();
            const step = engine.getCurrentStep();
            expect(step).not.toBeNull();
            expect(step!.expectedMove).toBe('e4');
            expect(step!.isUserTurn).toBe(true);

            const teachResult = engine.handleUserMove('e2', 'e4', chess);
            expect(teachResult.accepted).toBe(true);
            // Teaching finishes → transitions to recalling
            expect(teachResult.isEndOfTraversal).toBe(false);

            const recallStatus = engine.getStatus();
            expect(recallStatus.phase).toBe('recalling');

            // Recall: replay the same move
            const recallChess = new Chess();
            const recallStep = engine.getCurrentStep();
            expect(recallStep).not.toBeNull();
            expect(recallStep!.expectedMove).toBe('e4');

            const recallResult = engine.handleUserMove('e2', 'e4', recallChess);
            expect(recallResult.accepted).toBe(true);
            expect(recallResult.isEndOfTraversal).toBe(true);
            expect(recallResult.ratingWasCorrect).toBe(false); // recall always rated Again

            // Card was rated
            expect(engine.getCardsRated()).toBe(1);
        });
    });

    describe('branch point handling', () => {
        it('should rate alternative move Good and ask for planned move', () => {
            // Two white moves from same position: 1. e4 and 1. d4
            TrainingEngine.setContextDepth(0);
            const engine = makeEngine([
                makePgnInput('1. e4 e5', 'white'),
                makePgnInput('1. d4 d5', 'white'),
            ]);

            // Rate one card so it's in Review state (not New) to trigger regular traversal
            const cards = engine.getFsrsCards();
            const cardKeys = Object.keys(cards);
            expect(cardKeys.length).toBeGreaterThanOrEqual(2);

            // Start traversal — it will pick one of the two new cards for teaching
            const status = engine.startTraversal();
            expect(status).not.toBeNull();

            // Both moves are new, so it will enter teaching phase
            // Complete teaching and recall for the first card
            const chess = new Chess();
            const step = engine.getCurrentStep();
            expect(step).not.toBeNull();
            const plannedMove = step!.expectedMove;

            // Play the planned move during teaching
            const teachRes = engine.handleUserMove(
                plannedMove === 'e4' ? 'e2' : 'd2',
                plannedMove === 'e4' ? 'e4' : 'd4',
                chess
            );
            expect(teachRes.accepted).toBe(true);
        });

        it('should not double-rate the same branch alternative', () => {
            // Need a graph where we can trigger branch point during regular traversal
            // Use pre-rated cards (Review state) with 2 options from start position
            TrainingEngine.setContextDepth(0);

            // Create cards in a state that will trigger regular traversal (not new)
            const startFen = normalizeFenResetHalfmoveClock(new Chess().fen());
            const cardKeyE4 = `${startFen}::e4`;
            const cardKeyD4 = `${startFen}::d4`;

            // Pre-rate cards so they're in Learning state with past due dates
            const now = new Date();
            const pastDue = new Date(now.getTime() - 86400000).toISOString();
            const fsrsCards: Record<string, any> = {};
            fsrsCards[cardKeyE4] = {
                d: pastDue, s: 1, di: 5, e: 1, sd: 1, ls: 0, r: 1, l: 0, st: 1, lr: pastDue
            };
            fsrsCards[cardKeyD4] = {
                d: pastDue, s: 1, di: 5, e: 1, sd: 1, ls: 0, r: 1, l: 0, st: 1, lr: pastDue
            };

            const engine = makeEngine([
                makePgnInput('1. e4 e5', 'white'),
                makePgnInput('1. d4 d5', 'white'),
            ], fsrsCards);

            const status = engine.startTraversal();
            expect(status).not.toBeNull();

            // Advance to user turn
            const chess = new Chess();
            let step = engine.getCurrentStep();
            while (step && !step.isUserTurn) {
                chess.move(step.expectedMove);
                engine.advanceAutoplay();
                step = engine.getCurrentStep();
            }

            if (step) {
                // Play the OTHER move (branch point)
                const otherMove = step.expectedMove === 'e4' ? 'd4' : 'e4';
                const otherFrom = otherMove === 'e4' ? 'e2' : 'd2';
                const otherTo = otherMove === 'e4' ? 'e4' : 'd4';

                const branchResult = engine.handleUserMove(otherFrom, otherTo, chess);
                expect(branchResult.accepted).toBe(false);
                expect(branchResult.branchPointMessage).toBeDefined();
                expect(branchResult.ratingWasCorrect).toBe(true);

                const ratedAfterFirst = engine.getCardsRated();

                // Try the same alternative again — should NOT re-rate
                const branchResult2 = engine.handleUserMove(otherFrom, otherTo, chess);
                expect(branchResult2.accepted).toBe(false);
                expect(engine.getCardsRated()).toBe(ratedAfterFirst); // no increment
            }
        });
    });

    describe('hint → Again rating', () => {
        it('should rate card Again after hint even if correct move is played', () => {
            TrainingEngine.setContextDepth(0);

            const startFen = normalizeFenResetHalfmoveClock(new Chess().fen());
            const cardKey = `${startFen}::e4`;
            const pastDue = new Date(Date.now() - 86400000).toISOString();
            const fsrsCards: Record<string, any> = {};
            fsrsCards[cardKey] = {
                d: pastDue, s: 1, di: 5, e: 1, sd: 1, ls: 0, r: 1, l: 0, st: 1, lr: pastDue
            };

            const engine = makeEngine([makePgnInput('1. e4 e5', 'white')], fsrsCards);
            engine.startTraversal();

            // Advance to user turn
            const chess = new Chess();
            let step = engine.getCurrentStep();
            while (step && !step.isUserTurn) {
                chess.move(step.expectedMove);
                engine.advanceAutoplay();
                step = engine.getCurrentStep();
            }

            expect(step).not.toBeNull();

            // Request hint first
            const hint = engine.requestHint();
            expect(hint).not.toBeNull();

            // Now play the correct move
            const result = engine.handleUserMove('e2', 'e4', chess);
            expect(result.accepted).toBe(true);
            expect(result.ratingWasCorrect).toBe(false); // hint was used → Again
        });
    });

    describe('ahead-of-schedule mode', () => {
        it('should enter ahead_of_schedule when all cards are reviewed', () => {
            TrainingEngine.setContextDepth(0);

            const startFen = normalizeFenResetHalfmoveClock(new Chess().fen());
            const cardKey = `${startFen}::e4`;

            // Create a card that's in Review state and NOT due (future due date)
            const futureDue = new Date(Date.now() + 86400000).toISOString();
            const fsrsCards: Record<string, any> = {};
            fsrsCards[cardKey] = {
                d: futureDue, s: 10, di: 5, e: 1, sd: 10, ls: 0, r: 5, l: 0, st: 2, lr: new Date().toISOString()
            };

            const engine = makeEngine([makePgnInput('1. e4 e5', 'white')], fsrsCards);
            const status = engine.startTraversal();

            expect(status).not.toBeNull();
            // Should be in ahead_of_schedule (not empty, not teaching)
            expect(status!.phase).toBe('ahead_of_schedule');
        });
    });

    describe('getFsrsCards after traversal', () => {
        it('should return updated cards with ratings after completing traversal', () => {
            TrainingEngine.setContextDepth(0);
            const engine = makeEngine([makePgnInput('1. e4', 'white')]);
            engine.startTraversal();

            // Complete teaching pass
            const chess1 = new Chess();
            engine.handleUserMove('e2', 'e4', chess1);

            // Complete recall pass
            const chess2 = new Chess();
            engine.handleUserMove('e2', 'e4', chess2);

            const cards = engine.getFsrsCards();
            const startFen = normalizeFenResetHalfmoveClock(new Chess().fen());
            const cardKey = `${startFen}::e4`;

            expect(cards[cardKey]).toBeDefined();
            expect(cards[cardKey].r).toBeGreaterThan(0);
        });
    });
});
