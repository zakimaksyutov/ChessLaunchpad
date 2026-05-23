import { RepertoireGraph, GraphEdge } from './RepertoireGraph';
import { FSRSService } from './FSRSService';

export type StepRole = 'autoplay' | 'warm-up' | 'target' | 'cool-down';

export interface TraversalStep {
    fen: string;          // normalized FEN at this position (before the move)
    destFen: string;      // normalized FEN after the move (for annotation lookup)
    expectedMove: string; // SAN of the expected move
    cardKey: string;      // FSRS card key for this edge
    role: StepRole;       // how this step should be treated
    isUserTurn: boolean;  // whether this is a user-turn move
}

export interface TraversalPlan {
    steps: TraversalStep[];
    orientation: 'white' | 'black';
    targetCardKeys: string[];  // card keys that are targets in this traversal
    isTeachingPlan: boolean;   // true if this is a teach-then-recall plan for new cards
    newCardKeys: string[];     // card keys being taught (for teaching plans)
}

/**
 * Computes a traversal plan from root to target card(s).
 * Marks each step as autoplay, warm-up, target, or cool-down.
 */
export class PathPlanner {
    constructor(
        private graph: RepertoireGraph,
        private fsrsService: FSRSService,
        private contextDepth: number = 2
    ) {}

    /**
     * Plan a regular traversal to a due card.
     */
    planTraversal(targetCardKey: string, dueCardKeys: Set<string>): TraversalPlan | null {
        const { fen: targetFen, san: targetSan } = FSRSService.parseCardKey(targetCardKey);
        const orientation = this.graph.getOrientationForCard(targetCardKey);

        // Find best path from root to the target edge
        const paths = this.graph.getPathsToEdge(
            targetFen,
            targetSan,
            (key) => dueCardKeys.has(key)
        );

        if (paths.length === 0) return null;
        let path = paths[0];

        // Extend path beyond target if there are more due cards deeper
        path = this.extendPath(path, dueCardKeys, orientation);

        // Build traversal steps with role assignments
        const steps = this.assignRoles(path, dueCardKeys, orientation);

        const targetKeys = steps
            .filter(s => s.role === 'target')
            .map(s => s.cardKey);

        return {
            steps,
            orientation,
            targetCardKeys: [...new Set(targetKeys)],
            isTeachingPlan: false,
            newCardKeys: [],
        };
    }

    /**
     * Plan a teach-then-recall traversal for new cards.
     * Groups consecutive new cards on the same branch.
     */
    planTeachRecall(newCardKey: string, allNewCardKeys: Set<string>): TraversalPlan | null {
        const { fen: targetFen, san: targetSan } = FSRSService.parseCardKey(newCardKey);
        const orientation = this.graph.getOrientationForCard(newCardKey);

        const paths = this.graph.getPathsToEdge(targetFen, targetSan);
        if (paths.length === 0) return null;
        let path = paths[0];

        // Extend to include consecutive new cards deeper on the same branch
        path = this.extendForNewCards(path, allNewCardKeys, orientation);

        // All steps are autoplay (system shows the move, user plays it)
        const newCardKeysInPlan: string[] = [];
        const steps: TraversalStep[] = path.map(edge => {
            const isUser = PathPlanner.isUserTurnForOrientation(edge.from, orientation);
            const isNew = isUser && allNewCardKeys.has(edge.cardKey);
            if (isNew) newCardKeysInPlan.push(edge.cardKey);
            return {
                fen: edge.from,
                destFen: edge.to,
                expectedMove: edge.san,
                cardKey: edge.cardKey,
                role: 'target' as StepRole, // all user-turn steps in teach plan are targets
                isUserTurn: isUser,
            };
        });

        return {
            steps,
            orientation,
            targetCardKeys: newCardKeysInPlan,
            isTeachingPlan: true,
            newCardKeys: newCardKeysInPlan,
        };
    }

    // ─── Private ───────────────────────────────────────────────────────

    /**
     * Extend the path beyond the last edge if there are more due cards deeper.
     */
    private extendPath(path: GraphEdge[], dueCardKeys: Set<string>, orientation: 'white' | 'black'): GraphEdge[] {
        const extended = [...path];
        let currentFen = path[path.length - 1].to;
        const visited = new Set<string>(path.map(e => e.from));

        // Keep extending while there are due cards ahead
        for (let safety = 0; safety < 200; safety++) {
            const edges = this.graph.getEdges(currentFen);
            if (edges.length === 0) break;

            // For opponent turns, pick the branch with the most due descendants
            const isUserTurnHere = PathPlanner.isUserTurnForOrientation(currentFen, orientation);
            const opponentEdges = isUserTurnHere ? [] : edges;
            const userEdges = isUserTurnHere ? edges : [];

            if (!isUserTurnHere && edges.length > 0) {
                // Opponent move: pick branch with most due cards
                const bestOpponent = this.pickBranchWithMostDue(edges, dueCardKeys);
                if (!bestOpponent || visited.has(bestOpponent.to)) break;
                visited.add(bestOpponent.from);
                extended.push(bestOpponent);
                currentFen = bestOpponent.to;
                continue;
            }

            if (isUserTurnHere && edges.length > 0) {
                // Find any due card among user edges
                const dueEdge = edges.find(e => dueCardKeys.has(e.cardKey));
                if (dueEdge && !visited.has(dueEdge.to)) {
                    visited.add(dueEdge.from);
                    extended.push(dueEdge);
                    currentFen = dueEdge.to;
                    continue;
                }

                // No more due cards, but add cool-down edges
                const anyEdge = edges[0];
                if (!visited.has(anyEdge.to)) {
                    visited.add(anyEdge.from);
                    extended.push(anyEdge);
                    currentFen = anyEdge.to;

                    // Check if we've gone far enough past the last due card (user-turn edges only)
                    const lastDueIndex = this.findLastDueIndex(extended, dueCardKeys, orientation);
                    const userStepsAfterDue = extended.slice(lastDueIndex + 1)
                        .filter(e => PathPlanner.isUserTurnForOrientation(e.from, orientation)).length;
                    if (userStepsAfterDue >= this.contextDepth) break;
                    continue;
                }
            }

            break;
        }

        return extended;
    }

    /**
     * Extend path to include consecutive new cards deeper on the same branch.
     */
    private extendForNewCards(path: GraphEdge[], newCardKeys: Set<string>, orientation: 'white' | 'black'): GraphEdge[] {
        const extended = [...path];
        let currentFen = path[path.length - 1].to;

        for (let safety = 0; safety < 200; safety++) {
            const edges = this.graph.getEdges(currentFen);
            if (edges.length === 0) break;

            const isUserTurnHere = PathPlanner.isUserTurnForOrientation(currentFen, orientation);

            if (!isUserTurnHere && edges.length > 0) {
                // Opponent turn: pick any branch with new cards
                const branchWithNew = edges.find(e => {
                    const descendants = this.graph.getDescendantCardKeys(e.to);
                    return descendants.some(k => newCardKeys.has(k));
                });
                if (branchWithNew) {
                    extended.push(branchWithNew);
                    currentFen = branchWithNew.to;
                    continue;
                }
                break;
            }

            if (isUserTurnHere && edges.length > 0) {
                const newEdge = edges.find(e => newCardKeys.has(e.cardKey));
                if (newEdge) {
                    extended.push(newEdge);
                    currentFen = newEdge.to;
                    continue;
                }
            }

            break;
        }

        return extended;
    }

    /**
     * Determine if a step is a user turn based on the FEN's active color and plan orientation.
     * This is authoritative — graph edges may have stale isUserTurn from a different orientation.
     */
    private static isUserTurnForOrientation(fen: string, orientation: 'white' | 'black'): boolean {
        const parts = fen.split(' ');
        const activeColor = parts.length > 1 ? parts[1] : 'w';
        const isWhiteToMove = activeColor === 'w';
        return (orientation === 'white' && isWhiteToMove) || (orientation === 'black' && !isWhiteToMove);
    }

    /**
     * Assign roles to path edges based on target positions and context depth.
     */
    private assignRoles(path: GraphEdge[], dueCardKeys: Set<string>, orientation: 'white' | 'black'): TraversalStep[] {
        const steps: TraversalStep[] = path.map(edge => ({
            fen: edge.from,
            destFen: edge.to,
            expectedMove: edge.san,
            cardKey: edge.cardKey,
            role: 'autoplay' as StepRole,
            isUserTurn: PathPlanner.isUserTurnForOrientation(edge.from, orientation),
        }));

        // Find all target indices (user-turn edges with due cards)
        const targetIndices: number[] = [];
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].isUserTurn && dueCardKeys.has(steps[i].cardKey)) {
                targetIndices.push(i);
            }
        }

        if (targetIndices.length === 0) {
            // No targets — all user-turn steps are cool-down
            for (const step of steps) {
                if (step.isUserTurn) step.role = 'cool-down';
            }
            return steps;
        }

        // Compute user-turn indices for context depth calculation
        const userTurnIndices: number[] = [];
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].isUserTurn) userTurnIndices.push(i);
        }

        // Mark targets
        for (const idx of targetIndices) {
            steps[idx].role = 'target';
        }

        // Mark warm-up and cool-down zones based on context depth
        const firstTargetIdx = targetIndices[0];
        const lastTargetIdx = targetIndices[targetIndices.length - 1];

        for (let i = 0; i < steps.length; i++) {
            if (!steps[i].isUserTurn) continue;
            if (steps[i].role === 'target') continue;

            const userIdx = userTurnIndices.indexOf(i);
            const firstTargetUserIdx = userTurnIndices.indexOf(firstTargetIdx);
            const lastTargetUserIdx = userTurnIndices.indexOf(lastTargetIdx);

            if (userIdx < firstTargetUserIdx) {
                // Before first target
                const distance = firstTargetUserIdx - userIdx;
                if (distance <= this.contextDepth) {
                    steps[i].role = 'warm-up';
                }
                // Otherwise stays autoplay
            } else if (userIdx > lastTargetUserIdx) {
                // After last target
                const distance = userIdx - lastTargetUserIdx;
                if (distance <= this.contextDepth) {
                    steps[i].role = 'cool-down';
                }
                // Otherwise we shouldn't have this step (path extension handles)
            } else {
                // Between targets — always user-played (merged zones)
                steps[i].role = 'warm-up';
            }
        }

        return steps;
    }

    private pickBranchWithMostDue(edges: GraphEdge[], dueCardKeys: Set<string>): GraphEdge | null {
        if (edges.length === 0) return null;

        let best: GraphEdge | null = null;
        let bestCount = -1;

        for (const edge of edges) {
            const descendants = this.graph.getDescendantCardKeys(edge.to);
            const count = descendants.filter(k => dueCardKeys.has(k)).length;
            if (count > bestCount || (count === bestCount && Math.random() < 0.5)) {
                best = edge;
                bestCount = count;
            }
        }

        return best;
    }

    private findLastDueIndex(path: GraphEdge[], dueCardKeys: Set<string>, orientation: 'white' | 'black'): number {
        for (let i = path.length - 1; i >= 0; i--) {
            if (PathPlanner.isUserTurnForOrientation(path[i].from, orientation) && dueCardKeys.has(path[i].cardKey)) {
                return i;
            }
        }
        return -1;
    }
}
