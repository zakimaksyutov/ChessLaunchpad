import { Chess } from 'chess.js';
import { State } from 'ts-fsrs';
import { FSRSCardData } from '../models/FSRSCardData';
import { FSRSService } from './FSRSService';
import { RepertoireGraph, GraphEdge } from './RepertoireGraph';
import { ReviewQueue } from './ReviewQueue';
import { PathPlanner, TraversalPlan, TraversalStep } from './PathPlanner';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { Annotation } from '../models/Annotation';

export type EnginePhase =
    | 'idle'
    | 'autoplay'
    | 'awaiting_user'
    | 'teaching'
    | 'recalling'
    | 'branch_point'
    | 'complete'
    | 'ahead_of_schedule'
    | 'empty';

export interface MoveResult {
    accepted: boolean;
    isEndOfTraversal: boolean;
    branchPointMessage?: string; // "Correct, but there are more options"
    ratedCardKey?: string;
    ratingWasCorrect?: boolean;
}

export interface EngineStatus {
    phase: EnginePhase;
    currentStepIndex: number;
    totalSteps: number;
    queueSize: number;
    cardsReviewedThisTraversal: number;
    orientation: 'white' | 'black';
    isTeaching: boolean;
    showHint: boolean;      // true = show correct move arrow/highlight
    hintMove?: { from: string; to: string; san: string };
    annotations: Annotation[];
}

const CONTEXT_DEPTH_KEY = 'chesslaunchpad_context_depth';
const DEFAULT_CONTEXT_DEPTH = 2;

/**
 * Orchestrates the traversal lifecycle for FSRSv2 training.
 * Manages queue building, path planning, move handling, rating, and phase transitions.
 */
export class TrainingEngine {
    private graph: RepertoireGraph;
    private fsrsService: FSRSService;
    private queue: ReviewQueue;
    private planner: PathPlanner;

    private plan: TraversalPlan | null = null;
    private stepIndex: number = 0;
    private phase: EnginePhase = 'idle';
    private cardsRated: number = 0;
    private errorFens: Set<string> = new Set();
    private branchAlternativesPlayed: Set<string> = new Set(); // card keys played at branch points
    private _isTeachingPass: boolean = false;
    private _isAheadOfSchedule: boolean = false;
    private _recallPlan: TraversalPlan | null = null; // saved for recall pass after teaching
    private hintRequested: boolean = false;

    // Annotation lookup from PGN variants
    private annotations: Map<string, Annotation[]> = new Map();

    constructor(
        pgns: { pgn: string; orientation: 'white' | 'black'; annotations?: Record<string, Annotation[]> }[],
        fsrsCards: Record<string, FSRSCardData>
    ) {
        this.graph = new RepertoireGraph(pgns);
        this.fsrsService = new FSRSService(fsrsCards);
        this.queue = new ReviewQueue();
        const contextDepth = TrainingEngine.getContextDepth();
        this.planner = new PathPlanner(this.graph, this.fsrsService, contextDepth);

        // Ensure all graph cards exist in FSRS service (defensive reconciliation)
        for (const key of this.graph.getCardKeys()) {
            this.fsrsService.ensureCard(key);
        }

        // Merge annotations from all PGNs
        for (const p of pgns) {
            if (p.annotations) {
                for (const [fen, anns] of Object.entries(p.annotations)) {
                    const existing = this.annotations.get(fen) ?? [];
                    this.annotations.set(fen, [...existing, ...anns]);
                }
            }
        }
    }

    // ─── Static helpers ────────────────────────────────────────────────

    static getContextDepth(): number {
        try {
            const stored = localStorage.getItem(CONTEXT_DEPTH_KEY);
            if (stored !== null) {
                const val = parseInt(stored, 10);
                if (isFinite(val) && val >= 0) return val;
            }
        } catch { /* localStorage unavailable */ }
        return DEFAULT_CONTEXT_DEPTH;
    }

    static setContextDepth(depth: number): void {
        try {
            localStorage.setItem(CONTEXT_DEPTH_KEY, String(Math.max(0, Math.round(depth))));
        } catch { /* localStorage unavailable */ }
    }

    // ─── Traversal lifecycle ───────────────────────────────────────────

    /**
     * Start a new traversal. Builds the queue, picks the highest-priority card,
     * plans a path, and returns the initial status.
     * Returns null if there's nothing to train.
     */
    startTraversal(): EngineStatus | null {
        const now = new Date();
        const cardKeys = this.graph.getCardKeys();
        this.queue.build(this.fsrsService, cardKeys, now);

        this.cardsRated = 0;
        this.errorFens.clear();
        this.branchAlternativesPlayed.clear();
        this._isTeachingPass = false;
        this._isAheadOfSchedule = false;
        this._recallPlan = null;
        this.hintRequested = false;

        if (this.queue.isEmpty()) {
            // All cards reviewed — enter ahead-of-schedule mode
            const weakest = this.fsrsService.getWeakestCards(cardKeys, now, 1);
            if (weakest.length === 0) {
                this.phase = 'empty';
                return this.getStatus();
            }

            const dueKeys = new Set<string>();
            dueKeys.add(weakest[0]);
            this.plan = this.planner.planTraversal(weakest[0], dueKeys);
            if (!this.plan) {
                this.phase = 'empty';
                return this.getStatus();
            }
            this._isAheadOfSchedule = true;
            this.phase = 'ahead_of_schedule';
            this.stepIndex = 0;
            return this.advanceToNextAction();
        }

        const entry = this.queue.peek()!;

        if (entry.state === State.New) {
            return this.startTeachRecall(entry.cardKey);
        }

        return this.startRegularTraversal(entry.cardKey);
    }

    /**
     * Get the current expected move (for autoplay or validation).
     */
    getCurrentStep(): TraversalStep | null {
        if (!this.plan || this.stepIndex >= this.plan.steps.length) return null;
        return this.plan.steps[this.stepIndex];
    }

    /**
     * Handle a user's move attempt. Returns result indicating acceptance, rating, etc.
     */
    handleUserMove(fromSq: string, toSq: string, chess: Chess): MoveResult {
        const step = this.getCurrentStep();
        if (!step) return { accepted: false, isEndOfTraversal: true };

        // Validate move with chess.js
        const testChess = new Chess(chess.fen());
        let move;
        try {
            move = testChess.move({ from: fromSq, to: toSq });
        } catch {
            return { accepted: false, isEndOfTraversal: false };
        }
        if (!move) return { accepted: false, isEndOfTraversal: false };

        const currentFen = normalizeFenResetHalfmoveClock(chess.fen());
        const playedSan = move.san;

        // ── Teaching pass: user must play the shown move exactly ──
        if (this._isTeachingPass) {
            if (playedSan !== step.expectedMove) {
                // Wrong move during teaching — reject
                return { accepted: false, isEndOfTraversal: false };
            }
            // Correct — advance but do NOT rate
            this.stepIndex++;
            this.hintRequested = false;
            const isEnd = this.stepIndex >= this.plan!.steps.length;
            if (isEnd) {
                return this.finishTeachingPass();
            }
            // Update phase for next step (e.g. transition to autoplay for opponent)
            this.advanceToNextAction();
            return { accepted: true, isEndOfTraversal: false };
        }

        // ── Recall pass: user must recall each move, rated Again ──
        if (this.phase === 'recalling') {
            if (step.isUserTurn && playedSan !== step.expectedMove) {
                // Wrong move during recall
                this.errorFens.add(currentFen);
                return { accepted: false, isEndOfTraversal: false };
            }
            if (step.isUserTurn) {
                // Only rate cards that are part of the new card set being taught
                const isNewCard = this.plan!.newCardKeys.includes(step.cardKey);
                if (isNewCard) {
                    this.fsrsService.rateCardByKey(step.cardKey, false, new Date());
                    this.cardsRated++;
                    this.queue.remove(step.cardKey);
                }
                this.errorFens.delete(currentFen);
                this.hintRequested = false;
            }
            this.stepIndex++;
            const isEnd = this.stepIndex >= this.plan!.steps.length;
            if (!isEnd) {
                // Update phase for next step (e.g. transition to autoplay for opponent)
                this.advanceToNextAction();
            }
            return {
                accepted: true,
                isEndOfTraversal: isEnd,
                ratedCardKey: step.isUserTurn ? step.cardKey : undefined,
                ratingWasCorrect: false,
            };
        }

        // ── Regular traversal ──

        // Check if the move matches the planned move
        if (playedSan === step.expectedMove) {
            // Planned move — rate normally
            const hadError = this.errorFens.has(currentFen);
            const isCorrect = !hadError && !this.hintRequested;
            this.fsrsService.rateCardByKey(step.cardKey, isCorrect, new Date());
            this.cardsRated++;
            this.queue.remove(step.cardKey);
            this.errorFens.delete(currentFen);
            this.hintRequested = false;

            this.stepIndex++;
            const isEnd = this.stepIndex >= this.plan!.steps.length;
            if (!isEnd) {
                // Update phase for next step (e.g. transition to autoplay for opponent)
                this.advanceToNextAction();
            }
            return {
                accepted: true,
                isEndOfTraversal: isEnd,
                ratedCardKey: step.cardKey,
                ratingWasCorrect: isCorrect,
            };
        }

        // Check if it's a valid repertoire move but not the planned one (branch point)
        const edge = this.graph.getEdge(currentFen, playedSan);
        const fenParts = currentFen.split(' ');
        const activeColor = fenParts.length > 1 ? fenParts[1] : 'w';
        const isWhiteToMove = activeColor === 'w';
        const isUserTurnHere = (this.plan!.orientation === 'white' && isWhiteToMove) ||
                               (this.plan!.orientation === 'black' && !isWhiteToMove);
        if (edge && isUserTurnHere) {
            // Valid repertoire move at a branch point
            if (!this.branchAlternativesPlayed.has(edge.cardKey)) {
                // Rate this unplanned move as Good
                this.fsrsService.rateCardByKey(edge.cardKey, true, new Date());
                this.cardsRated++;
                this.queue.remove(edge.cardKey);
                this.branchAlternativesPlayed.add(edge.cardKey);
            }

            return {
                accepted: false, // move is acknowledged but board reverts (user must play planned move)
                isEndOfTraversal: false,
                branchPointMessage: 'Correct, but there are more options. Try another move.',
                ratedCardKey: edge.cardKey,
                ratingWasCorrect: true,
            };
        }

        // Invalid move
        this.errorFens.add(currentFen);
        return { accepted: false, isEndOfTraversal: false };
    }

    /**
     * Advance past the current autoplay step (called after animation completes).
     */
    advanceAutoplay(): EngineStatus {
        this.stepIndex++;
        return this.advanceToNextAction();
    }

    /**
     * Request a hint: show the correct move. Card will be rated Again.
     */
    requestHint(): { from: string; to: string; san: string } | null {
        const step = this.getCurrentStep();
        if (!step) return null;

        this.hintRequested = true;

        const chess = new Chess();
        chess.load(step.fen);
        try {
            const move = chess.move(step.expectedMove);
            if (move) {
                return { from: move.from, to: move.to, san: move.san };
            }
        } catch { /* fall through */ }
        return null;
    }

    /**
     * Get current engine status for UI rendering.
     */
    getStatus(): EngineStatus {
        const step = this.getCurrentStep();
        // Compute hint without side effects (requestHint sets hintRequested flag)
        const hint = this.hintRequested && step ? this.getHintForStep(step) : undefined;
        // During autoplay, show annotations for the current board position (step.fen)
        // so the user sees them before the opponent moves.
        // During user turns, show annotations for the position after their last move (destFen of prev step = step.fen).
        const annotationFen = step?.fen ?? '';
        const anns = this._isTeachingPass
            ? []
            : (this.annotations.get(annotationFen) ?? []);

        return {
            phase: this.phase,
            currentStepIndex: this.stepIndex,
            totalSteps: this.plan?.steps.length ?? 0,
            queueSize: this.queue.size(),
            cardsReviewedThisTraversal: this.cardsRated,
            orientation: this.plan?.orientation ?? 'white',
            isTeaching: this._isTeachingPass,
            showHint: this._isTeachingPass || this.hintRequested,
            hintMove: this._isTeachingPass && step ? this.getHintForStep(step) : hint ?? undefined,
            annotations: anns,
        };
    }

    /**
     * Get queue statistics for badge display.
     */
    getQueueStats(): { dueCount: number; newCount: number; totalCards: number } {
        return {
            dueCount: this.queue.dueCount(),
            newCount: this.queue.newCount(),
            totalCards: this.graph.getCardKeys().length,
        };
    }

    /**
     * Get the fsrsCards map (for persistence).
     */
    getFsrsCards(): Record<string, FSRSCardData> {
        return this.fsrsService.getCards();
    }

    /**
     * Get total cards rated this traversal (for dailyPlayCount).
     */
    getCardsRated(): number {
        return this.cardsRated;
    }

    // ─── Private ───────────────────────────────────────────────────────

    private logPlan(plan: TraversalPlan, mode: 'regular' | 'teach'): void {
        const roleTag: Record<string, string> = {
            'warm-up': '🔶',
            'target': '🎯',
            'cool-down': '🔷',
            'autoplay': '',
        };

        // Build PGN-like string with move numbers
        let moveNum = 1;
        let isWhite = plan.orientation === 'white'; // first move is white's for white orientation
        const parts: string[] = [];

        for (const step of plan.steps) {
            const tag = roleTag[step.role] ?? '';
            if (isWhite) {
                parts.push(`${moveNum}.${tag}${step.expectedMove}`);
            } else {
                if (parts.length === 0) parts.push(`${moveNum}...`);
                parts.push(`${tag}${step.expectedMove}`);
                moveNum++;
            }
            isWhite = !isWhite;
        }

        const legend = `[${mode}|${plan.orientation}]`;
        console.info(`${legend} ${parts.join(' ')}`);
    }

    private startRegularTraversal(targetCardKey: string): EngineStatus | null {
        const dueKeys = new Set<string>();
        for (const entry of this.queue.getEntries()) {
            if (entry.state !== State.New) {
                dueKeys.add(entry.cardKey);
            }
        }

        let cardKey = targetCardKey;
        // Loop instead of recursion to avoid stack overflow with many un-plannable cards
        for (let attempts = 0; attempts < 100; attempts++) {
            const plan = this.planner.planTraversal(cardKey, dueKeys);
            if (plan) {
                this.plan = plan;
                this.stepIndex = 0;
                this._isTeachingPass = false;
                this.logPlan(plan, 'regular');
                return this.advanceToNextAction();
            }

            // Skip this card if no path found
            this.queue.pop();
            if (this.queue.isEmpty()) {
                this.phase = 'empty';
                return this.getStatus();
            }

            const next = this.queue.peek()!;
            if (next.state === State.New) {
                return this.startTeachRecall(next.cardKey);
            }
            cardKey = next.cardKey;
        }

        this.phase = 'empty';
        return this.getStatus();
    }

    private startTeachRecall(newCardKey: string): EngineStatus | null {
        const allNewKeys = new Set<string>();
        for (const entry of this.queue.getEntries()) {
            if (entry.state === State.New) allNewKeys.add(entry.cardKey);
        }

        let cardKey = newCardKey;
        // Loop instead of recursion to avoid stack overflow
        for (let attempts = 0; attempts < 100; attempts++) {
            const plan = this.planner.planTeachRecall(cardKey, allNewKeys);
            if (plan) {
                this.plan = plan;
                this._isTeachingPass = true;
                this._recallPlan = plan; // save for recall pass
                this.stepIndex = 0;
                this.phase = 'teaching';
                this.logPlan(plan, 'teach');
                return this.advanceToNextAction();
            }

            this.queue.pop();
            if (this.queue.isEmpty()) {
                this.phase = 'empty';
                return this.getStatus();
            }

            const next = this.queue.peek()!;
            if (next.state !== State.New) {
                return this.startRegularTraversal(next.cardKey);
            }
            cardKey = next.cardKey;
        }

        this.phase = 'empty';
        return this.getStatus();
    }

    private finishTeachingPass(): MoveResult {
        // Switch to recall pass
        this._isTeachingPass = false;
        this.phase = 'recalling';
        this.plan = this._recallPlan;
        this._recallPlan = null;
        this.stepIndex = 0;
        this.errorFens.clear();
        this.hintRequested = false;

        return { accepted: true, isEndOfTraversal: false };
    }

    /**
     * Advance through the plan to determine the next action.
     * Skips through opponent turns (autoplay) and determines the phase.
     */
    private advanceToNextAction(): EngineStatus {
        if (!this.plan || this.stepIndex >= this.plan.steps.length) {
            // If we finished a teaching pass, transition to recall instead of complete
            if (this._isTeachingPass) {
                const result = this.finishTeachingPass();
                // finishTeachingPass resets stepIndex; now advance from start of recall plan
                if (this.plan && this.stepIndex < this.plan.steps.length) {
                    return this.advanceToNextAction();
                }
                // If recall plan is also empty, complete
            }
            this.phase = 'complete';
            return this.getStatus();
        }

        const step = this.plan.steps[this.stepIndex];

        if (this._isTeachingPass) {
            if (!step.isUserTurn) {
                this.phase = 'autoplay';
            } else {
                this.phase = 'teaching';
            }
            return this.getStatus();
        }

        if (this.phase === 'recalling') {
            if (!step.isUserTurn) {
                this.phase = 'autoplay';
            } else {
                this.phase = 'recalling';
            }
            return this.getStatus();
        }

        // Preserve ahead-of-schedule mode through phase transitions
        if (this._isAheadOfSchedule) {
            if (!step.isUserTurn) {
                this.phase = 'autoplay';
            } else if (step.role === 'autoplay') {
                this.phase = 'autoplay';
            } else {
                this.phase = 'ahead_of_schedule';
            }
            return this.getStatus();
        }

        if (!step.isUserTurn) {
            this.phase = 'autoplay';
            return this.getStatus();
        }

        if (step.role === 'autoplay') {
            this.phase = 'autoplay';
            return this.getStatus();
        }

        this.phase = 'awaiting_user';
        return this.getStatus();
    }

    private getHintForStep(step: TraversalStep): { from: string; to: string; san: string } | undefined {
        try {
            const chess = new Chess();
            chess.load(step.fen);
            const move = chess.move(step.expectedMove);
            if (move) return { from: move.from, to: move.to, san: move.san };
        } catch { /* ignore */ }
        return undefined;
    }
}
