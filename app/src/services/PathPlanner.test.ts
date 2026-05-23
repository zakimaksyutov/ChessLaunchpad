import { describe, it, expect } from 'vitest';
import { PathPlanner } from './PathPlanner';
import { RepertoireGraph } from './RepertoireGraph';
import { FSRSService } from './FSRSService';
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
});
