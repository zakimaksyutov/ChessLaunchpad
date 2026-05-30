import { describe, it, expect } from 'vitest';
import { State } from 'ts-fsrs';
import { PathPlanner } from './PathPlanner';
import { RepertoireGraph } from './RepertoireGraph';
import { FSRSService } from './FSRSService';
import { ReviewQueue } from './ReviewQueue';
import { FSRSCardData } from '../models/FSRSCardData';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { Chess } from 'chess.js';

function getFenAfterMoves(moves: string[]): string {
    const chess = new Chess();
    for (const m of moves) chess.move(m);
    return normalizeFenResetHalfmoveClock(chess.fen());
}

function makeCardKey(moves: string[], moveIndex: number): string {
    const chess = new Chess();
    for (let i = 0; i < moveIndex; i++) chess.move(moves[i]);
    const fen = normalizeFenResetHalfmoveClock(chess.fen());
    return FSRSService.makeCardKey(fen, moves[moveIndex]);
}

describe('PathPlanner', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bb5 (white, 3 user moves: e4, Nf3, Bb5)
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5';
    const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];

    describe('planTraversal', () => {
        it('should create a plan for a due card', () => {
            const graph = new RepertoireGraph([{ pgn, orientation: 'white' }]);
            const service = new FSRSService({});
            // Ensure all cards
            for (const key of graph.getCardKeys()) {
                service.ensureCard(key);
            }
            const planner = new PathPlanner(graph, service, 2);

            // Target: Nf3 (the second user move)
            const targetKey = makeCardKey(moves, 2); // Nf3 at index 2
            const plan = planner.planTraversal(targetKey, new Set([targetKey]));

            expect(plan).not.toBeNull();
            expect(plan!.steps.length).toBeGreaterThan(0);
            expect(plan!.orientation).toBe('white');

            // Should contain the target move
            const targetSteps = plan!.steps.filter(s => s.cardKey === targetKey);
            expect(targetSteps.length).toBeGreaterThanOrEqual(1);
        });

        it('should return null for unknown card key', () => {
            const graph = new RepertoireGraph([{ pgn, orientation: 'white' }]);
            const service = new FSRSService({});
            const planner = new PathPlanner(graph, service, 2);

            const plan = planner.planTraversal('unknown::key', new Set());
            expect(plan).toBeNull();
        });

        it('should mark autoplay steps for moves before context zone', () => {
            // Longer variant so we have autoplay moves
            const longPgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O';
            const longMoves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O'];
            const graph = new RepertoireGraph([{ pgn: longPgn, orientation: 'white' }]);
            const service = new FSRSService({});
            for (const key of graph.getCardKeys()) service.ensureCard(key);

            // Target the last move (O-O) with context depth 1
            const targetKey = makeCardKey(longMoves, 8); // O-O at index 8
            const planner = new PathPlanner(graph, service, 1);
            const plan = planner.planTraversal(targetKey, new Set([targetKey]));

            expect(plan).not.toBeNull();
            // First moves should be autoplay
            const autoplaySteps = plan!.steps.filter(s => s.role === 'autoplay');
            expect(autoplaySteps.length).toBeGreaterThan(0);
        });
    });

    describe('planTeachRecall', () => {
        it('should create a plan for a new card', () => {
            const graph = new RepertoireGraph([{ pgn, orientation: 'white' }]);
            const service = new FSRSService({});
            for (const key of graph.getCardKeys()) service.ensureCard(key);

            const targetKey = makeCardKey(moves, 0); // e4
            const allNewKeys = new Set(graph.getCardKeys());
            const planner = new PathPlanner(graph, service, 2);
            const plan = planner.planTeachRecall(targetKey, allNewKeys);

            expect(plan).not.toBeNull();
            expect(plan!.steps.length).toBeGreaterThan(0);
        });

        it('should assign autoplay role to known prefix and target to new cards', () => {
            // Variant: 1. e4 e5 2. Nf3 Nc6 3. Bb5
            // Only Bb5 is new; e4 and Nf3 are known prefix moves
            const graph = new RepertoireGraph([{ pgn, orientation: 'white' }]);
            const service = new FSRSService({});
            for (const key of graph.getCardKeys()) service.ensureCard(key);

            const bb5Key = makeCardKey(moves, 4); // Bb5 at index 4
            const allNewKeys = new Set([bb5Key]);
            const planner = new PathPlanner(graph, service, 2);
            const plan = planner.planTeachRecall(bb5Key, allNewKeys);

            expect(plan).not.toBeNull();
            // User-turn steps: e4 (index 0), Nf3 (index 2), Bb5 (index 4)
            const userSteps = plan!.steps.filter(s => s.isUserTurn);
            expect(userSteps.length).toBe(3);

            // e4 and Nf3 are known → autoplay role
            expect(userSteps[0].expectedMove).toBe('e4');
            expect(userSteps[0].role).toBe('autoplay');
            expect(userSteps[1].expectedMove).toBe('Nf3');
            expect(userSteps[1].role).toBe('autoplay');

            // Bb5 is new → target role
            expect(userSteps[2].expectedMove).toBe('Bb5');
            expect(userSteps[2].role).toBe('target');
        });

        it('should assign target role to all steps when all cards are new', () => {
            const graph = new RepertoireGraph([{ pgn, orientation: 'white' }]);
            const service = new FSRSService({});
            for (const key of graph.getCardKeys()) service.ensureCard(key);

            const e4Key = makeCardKey(moves, 0);
            const allNewKeys = new Set(graph.getCardKeys());
            const planner = new PathPlanner(graph, service, 2);
            const plan = planner.planTeachRecall(e4Key, allNewKeys);

            expect(plan).not.toBeNull();
            const userSteps = plan!.steps.filter(s => s.isUserTurn);
            // All user-turn steps should be targets when all cards are new
            for (const step of userSteps) {
                expect(step.role).toBe('target');
            }
        });
    });

    describe('context depth', () => {
        it('should respect context depth = 0 (target only)', () => {
            const graph = new RepertoireGraph([{ pgn, orientation: 'white' }]);
            const service = new FSRSService({});
            for (const key of graph.getCardKeys()) service.ensureCard(key);

            // Target Nf3 (middle of variant) with context depth 0
            const targetKey = makeCardKey(moves, 2);
            const planner = new PathPlanner(graph, service, 0);
            const plan = planner.planTraversal(targetKey, new Set([targetKey]));

            expect(plan).not.toBeNull();
            // With depth 0, only the target should be non-autoplay user move
            const userTargetSteps = plan!.steps.filter(
                s => s.isUserTurn && s.role === 'target'
            );
            expect(userTargetSteps.length).toBe(1);
        });
    });

    // Characterization tests for the queue → planner interaction with two due
    // cards on the same variant. These do NOT assert what the algorithm "should"
    // do — they pin down current behavior so a future change is visible.
    //
    // Scenario from the user's repertoire:
    //   1. e4 g6  2. d4 Bg7  3. Nc3 d6  4. Be3 c6  5. Qd2 b5  6. Bd3 Nd7
    //   7. Nf3 Qc7  8. Ne2
    // White's user moves (by index in the SAN array):
    //   0: e4,  2: d4,  4: Nc3,  6: Be3,  8: Qd2,  10: Bd3,  12: Nf3,  14: Ne2
    // Be3 and Ne2 are both "due". Qd2/Bd3/Nf3 etc. are New (priority 3, so they
    // are NOT in the dueKeys set passed to the planner).
    describe('queue-driven target selection (two due cards on same variant)', () => {
        const longPgn = '1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. Be3 c6 5. Qd2 b5 6. Bd3 Nd7 7. Nf3 Qc7 8. Ne2';
        const longMoves = ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6', 'Be3', 'c6', 'Qd2', 'b5', 'Bd3', 'Nd7', 'Nf3', 'Qc7', 'Ne2'];

        // Build a Learning-state card with explicit days-past-due. For Learning
        // state, FSRSService.getOverdueness returns daysPastDue directly from
        // `d`, with no FSRS interval math — so ordering is deterministic.
        function learningCardOverdueBy(daysOverdue: number): FSRSCardData {
            return {
                d: new Date(Date.now() - daysOverdue * 86400_000).toISOString(),
                s: 1, di: 5, e: 0, sd: 1, ls: 0, r: 1, l: 0,
                st: State.Learning,
            };
        }

        function setup(be3DaysOverdue: number, ne2DaysOverdue: number) {
            const cards: Record<string, FSRSCardData> = {};
            const graph = new RepertoireGraph([{ pgn: longPgn, orientation: 'white' }]);
            const be3Key = makeCardKey(longMoves, 6);
            const ne2Key = makeCardKey(longMoves, 14);

            // All graph cards start as New (priority 3, included in queue but
            // NOT in dueKeys because TrainingEngine filters out State.New).
            const service = new FSRSService(cards);
            for (const key of graph.getCardKeys()) service.ensureCard(key);

            // Replace Be3 and Ne2 with Learning cards at controlled overdueness.
            cards[be3Key] = learningCardOverdueBy(be3DaysOverdue);
            cards[ne2Key] = learningCardOverdueBy(ne2DaysOverdue);

            return { graph, service, be3Key, ne2Key };
        }

        // Mirrors TrainingEngine.startRegularTraversal: take all non-New
        // entries from the queue as the dueKeys set.
        function buildDueKeysFromQueue(service: FSRSService, graph: RepertoireGraph): { queue: ReviewQueue; dueKeys: Set<string> } {
            const queue = new ReviewQueue();
            queue.build(service, graph.getCardKeys(), new Date());
            const dueKeys = new Set<string>();
            for (const e of queue.getEntries()) {
                if (e.state !== State.New) dueKeys.add(e.cardKey);
            }
            return { queue, dueKeys };
        }

        it('Ne2 (deeper) more overdue: queue pops Ne2, planner builds ONE variant covering both Be3 and Ne2 as targets', () => {
            const { graph, service, be3Key, ne2Key } = setup(/* be3Days */ 1, /* ne2Days */ 30);

            const { queue, dueKeys } = buildDueKeysFromQueue(service, graph);

            // Sanity: both cards are in the queue, Ne2 first because more overdue.
            expect(queue.peek()!.cardKey).toBe(ne2Key);
            expect(dueKeys).toEqual(new Set([be3Key, ne2Key]));

            const planner = new PathPlanner(graph, service, 2);
            const plan = planner.planTraversal(ne2Key, dueKeys);

            expect(plan).not.toBeNull();
            const userSteps = plan!.steps.filter(s => s.isUserTurn);
            const targetMoves = userSteps.filter(s => s.role === 'target').map(s => s.expectedMove);

            // Both Be3 and Ne2 are reached and marked as targets in the SAME variant.
            expect(targetMoves).toEqual(['Be3', 'Ne2']);

            // The variant reaches all the way to Ne2 (move 8).
            const allUserMoves = userSteps.map(s => s.expectedMove);
            expect(allUserMoves).toEqual(['e4', 'd4', 'Nc3', 'Be3', 'Qd2', 'Bd3', 'Nf3', 'Ne2']);
        });

        it('Be3 (shallower) more overdue: queue pops Be3, planner still builds ONE variant covering both Be3 and Ne2 — extension dives toward the deeper due card', () => {
            const { graph, service, be3Key, ne2Key } = setup(/* be3Days */ 30, /* ne2Days */ 1);

            const { queue, dueKeys } = buildDueKeysFromQueue(service, graph);

            // Sanity: both cards are in the queue, Be3 first because more overdue.
            expect(queue.peek()!.cardKey).toBe(be3Key);
            expect(dueKeys).toEqual(new Set([be3Key, ne2Key]));

            const planner = new PathPlanner(graph, service, 2);
            const plan = planner.planTraversal(be3Key, dueKeys);

            expect(plan).not.toBeNull();
            const userSteps = plan!.steps.filter(s => s.isUserTurn);
            const targetMoves = userSteps.filter(s => s.role === 'target').map(s => s.expectedMove);

            // Both Be3 and Ne2 are targets in the SAME variant. extendPath now
            // dives toward the deeper due descendant (Ne2) even when the next
            // user-turn edges (Qd2, Bd3, Nf3) aren't themselves due — so the
            // outcome no longer depends on which one the queue popped first.
            expect(targetMoves).toEqual(['Be3', 'Ne2']);

            const allUserMoves = userSteps.map(s => s.expectedMove);
            expect(allUserMoves).toEqual(['e4', 'd4', 'Nc3', 'Be3', 'Qd2', 'Bd3', 'Nf3', 'Ne2']);
        });
    });
});
