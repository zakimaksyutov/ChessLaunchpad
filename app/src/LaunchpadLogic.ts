import { Chess, Move } from 'chess.js';
import { OpeningVariant } from './OpeningVariant';
import { Annotation } from './Annotation';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { FSRSService } from './FSRSService';
import { FSRSCardData } from './FSRSCardData';

export interface FSRSMoveInfo {
    san: string;
    cardData: FSRSCardData | undefined;
    shouldAutoplay: boolean;
    retrievability: number | null;
}

export interface FSRSLookaheadEntry {
    fen: string;
    path: string;
    cardData: FSRSCardData | undefined;
    shouldAutoplay: boolean;
    retrievability: number | null;
}

export class LaunchpadLogic {

    private allVariants: OpeningVariant[];
    private fenToVariantMap: Map<string, OpeningVariant[]>;

    private ERROR_EMA_ALPHA = 0.7;
    public static SUCCESS_EMA_ALPHA = 0.6667; // Similar to averaging across three epochs.

    // Lookahead depth for autoplay: check this many user-turn positions ahead.
    // Depth 2 = current position + 1 future user-turn position.
    public static AUTOPLAY_LOOKAHEAD_DEPTH = 2;

    // Used to properly attribute a game to errorEMA and lastSucceededEpoch
    private hasErrors: boolean = false;

    // FSRS support
    private fsrsService: FSRSService;
    private fsrsErrorFens: Set<string> = new Set();

    constructor(variants: OpeningVariant[], fsrsCards: Record<string, FSRSCardData> = {}) {
        this.allVariants = variants;
        this.fenToVariantMap = new Map<string, OpeningVariant[]>();
        this.fsrsService = new FSRSService(fsrsCards);

        this.initializeFenToVariantMap();
    }

    public getAllVariants(): OpeningVariant[] {
        return this.allVariants;
    }

    public isValidVariant(fen: string): boolean {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        return this.fenToVariantMap.has(normalizedFen);
    }

    public isEndOfVariant(fen: string, moveIndex: number): boolean {
        const variants = this.getVariantsForFen(fen)!;

        for (const variant of variants) {
            const moves = variant.chess.history({ verbose: true });
            if (moves.length === moveIndex) {
                return true;
            }
        }

        return false;
    }

    public getAnnotations(fen: string): Annotation[] {
        // Merge annotations from all variants for the given FEN.
        const annotations: Annotation[] = [];
        const variants = this.getVariantsForFen(fen)!;
        if (variants) {
            for (const variant of variants) {
                const variantAnnotations = variant.annotations[fen];
                if (variantAnnotations) {
                    annotations.push(...variantAnnotations);
                }
            }
        }
        return annotations;
    }

    public markError(fen: string) {
        this.hasErrors = true;

        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        this.fsrsErrorFens.add(normalizedFen);

        const variants = this.getVariantsForFen(fen)!;

        for (const variant of variants) {
            variant.numberOfErrors += 1.0 / variants.length; // Distribute an error across all applicable variants.
        }
    }

    public hadErrors(): boolean {
        return this.hasErrors;
    }

    /**
     * Check if all valid user moves at this position can be autoplayed,
     * including a recursive lookahead into future user-turn positions.
     * When skipLookahead is true, only the current position is checked (depth 1).
     */
    public shouldAutoplayUserMove(fen: string, skipLookahead?: boolean): boolean {
        const now = new Date();
        const depth = skipLookahead ? 1 : LaunchpadLogic.AUTOPLAY_LOOKAHEAD_DEPTH;
        return this.isAutoplayableWithLookahead(fen, depth, now, true);
    }

    /**
     * Recursive check: every repertoire move at the position must pass FSRS autoplay,
     * and (if depth > 1) the next user-turn positions must also pass recursively.
     * isTopLevel differentiates "no repertoire moves = can't autoplay" (top) from
     * "variant ended = nothing weak ahead" (deeper levels).
     */
    private isAutoplayableWithLookahead(fen: string, depth: number, now: Date, isTopLevel: boolean): boolean {
        if (depth <= 0) return true;

        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        const chess = new Chess(fen);
        const possibleMoves = chess.moves({ verbose: true });

        let hasAnyRepertoireMove = false;

        for (const move of possibleMoves) {
            chess.move(move);
            const reachable = this.getVariantsForFen(chess.fen());
            chess.undo();

            if (reachable && reachable.length > 0) {
                hasAnyRepertoireMove = true;
                if (!this.fsrsService.shouldAutoplay(normalizedFen, move.san, now)) {
                    return false;
                }

                if (depth > 1) {
                    chess.move(move);
                    const nextUserFens = this.getNextUserTurnFens(chess.fen());
                    chess.undo();

                    for (const nextFen of nextUserFens) {
                        if (!this.isAutoplayableWithLookahead(nextFen, depth - 1, now, false)) {
                            return false;
                        }
                    }
                }
            }
        }

        return isTopLevel ? hasAnyRepertoireMove : true;
    }

    /**
     * Rate an FSRS card after the user plays a move.
     * Good if no prior error at this FEN, Again if there was an error.
     */
    public rateUserMove(fen: string, moveSan: string): void {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        const isCorrect = !this.fsrsErrorFens.has(normalizedFen);
        this.fsrsService.rateCard(normalizedFen, moveSan, isCorrect, new Date());
        // Clear error state after rating so the same FEN later in the
        // traversal gets a fresh first-try assessment.
        this.fsrsErrorFens.delete(normalizedFen);
    }

    public getFsrsCards(): Record<string, FSRSCardData> {
        return this.fsrsService.getCards();
    }

    public getRepertoireMovesAtPosition(fen: string): FSRSMoveInfo[] {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        const chess = new Chess(fen);
        const possibleMoves = chess.moves({ verbose: true });
        const now = new Date();
        const result: FSRSMoveInfo[] = [];
        const seen = new Set<string>();

        for (const move of possibleMoves) {
            chess.move(move);
            const reachable = this.getVariantsForFen(chess.fen());
            chess.undo();

            if (reachable && reachable.length > 0 && !seen.has(move.san)) {
                seen.add(move.san);
                result.push({
                    san: move.san,
                    cardData: this.fsrsService.getCardData(normalizedFen, move.san),
                    shouldAutoplay: this.fsrsService.shouldAutoplay(normalizedFen, move.san, now),
                    retrievability: this.fsrsService.getRetrievability(normalizedFen, move.san, now),
                });
            }
        }

        return result;
    }

    /**
     * Diagnostic: collect a flat table of all positions evaluated by the lookahead tree.
     * Each entry includes the SAN path from the current position.
     */
    public getLookaheadEvaluation(fen: string, skipLookahead?: boolean): FSRSLookaheadEntry[] {
        const now = new Date();
        const depth = skipLookahead ? 1 : LaunchpadLogic.AUTOPLAY_LOOKAHEAD_DEPTH;
        const entries: FSRSLookaheadEntry[] = [];
        this.collectLookaheadEntries(fen, depth, now, '', entries);
        return entries;
    }

    public getCardDataForMove(fen: string, moveSan: string): FSRSCardData | undefined {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        return this.fsrsService.getCardData(normalizedFen, moveSan);
    }

    public hasErrorAtPosition(fen: string): boolean {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        return this.fsrsErrorFens.has(normalizedFen);
    }

    public completeVariant(fen: string) {
        const variants = this.getVariantsForFen(fen)!;

        if (variants.length > 1) {
            throw new Error(`Cannot complete - more than one variant is availabe for FEN: '${fen}'. It means that exists two variants, one is a subvariant of another.`);
        } else if (variants.length === 0) {
            throw new Error(`Cannot complete - no variant is availabe for FEN: '${fen}'. It means that the variant is not valid for the given position.`);
        }

        const variant = variants[0];

        variant.numberOfTimesPlayed++;

        if (!this.hasErrors) {
            // Process this variant as a success.
            variant.lastSucceededEpoch = variant.currentEpoch;
            variant.errorEMA = variant.errorEMA * this.ERROR_EMA_ALPHA;
            variant.successEMA += (1 - LaunchpadLogic.SUCCESS_EMA_ALPHA) * 1;
        } else {
            // Process all other variants and apply errorEMA if there were errors.
            for (const variant of this.allVariants) {
                if (variant.numberOfErrors > 0) {
                    variant.errorEMA = variant.errorEMA * this.ERROR_EMA_ALPHA + variant.numberOfErrors;
                    variant.successEMA = 0;
                }
            }
        }
    }

    // This function is called only when isValidVariant is true and isEndOfVariant is false.
    // So, there is a guarantee that there is at least one variant with a move at the given index.
    public getNextMove(fen: string, moveIndex: number): Move {
        const applicableVariants = new Array<OpeningVariant>();

        // Variants which will have non-null move - the ones which were considered for picking the next move.
        for (const variant of this.allVariants) {
            variant.move = null;
            variant.isPicked = false;
        }

        const chess = new Chess(fen);
        const possibleMoves = chess.moves({ verbose: true });
        for (const move of possibleMoves) {
            chess.move(move);

            const variants = this.getVariantsForFen(chess.fen());
            if (variants) {
                for (const variant of variants) {
                    if (variant.move === null) {
                        variant.move = move; // Remember the move which resulted in this variant.
                        applicableVariants.push(variant);
                    }
                }
            }

            chess.undo();
        }

        if (applicableVariants.length === 0) {
            throw new Error('No next move available for the given FEN and move index.');
        }

        // Calculate weighted probability.
        for (const variant of applicableVariants) {
            variant.calculateWeight();
        }
        for (const variant of applicableVariants) {
            variant.weightedProbability = this.calculateProbability(variant.weight, applicableVariants);
        }

        // Randomly select a variant.
        const variant = this.pickVariantBasedOnWeightedProbability(applicableVariants);

        variant.isPicked = true;

        return variant.move!;
    }

    private pickVariantBasedOnWeightedProbability(variants: OpeningVariant[]): OpeningVariant {
        let random = Math.random();
        for (const variant of variants) {
            random -= variant.weightedProbability;
            if (random <= 0) {
                return variant;
            }
        }

        throw new Error('No variant selected based on weighted probability.');
    }

    private calculateProbability(weight: number, variants: OpeningVariant[]): number {
        const totalWeight = variants.reduce((sum, variant) => sum + variant.weight, 0);
        return weight / totalWeight;
    }

    private initializeFenToVariantMap() {
        for (const variant of this.allVariants) {
            try {
                const moves = variant.chess.history({ verbose: true });

                const chess = new Chess();

                // Initial position is valid for all variants
                this.addVariantToMap(chess.fen(), variant);

                for (const move of moves) {
                    chess.move(move);
                    this.addVariantToMap(chess.fen(), variant);
                };
            } catch (error) {
                console.error('Invalid PGN for variant: ' + variant.pgn + ' - ' + error);
                throw new Error('Invalid PGN for variant: ' + variant.pgn);
            }
        };
    }

    private addVariantToMap(fen: string, variant: OpeningVariant) {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        if (!this.fenToVariantMap.has(normalizedFen)) {
            this.fenToVariantMap.set(normalizedFen, []);
        }
        this.fenToVariantMap.get(normalizedFen)?.push(variant);
    }

    /**
     * Find all unique next user-turn positions reachable via opponent responses
     * that stay within the repertoire.
     */
    private getNextUserTurnFens(fenAfterUserMove: string): string[] {
        const chess = new Chess(fenAfterUserMove);
        const opponentMoves = chess.moves({ verbose: true });
        const result: string[] = [];
        const seen = new Set<string>();

        for (const move of opponentMoves) {
            chess.move(move);
            const fen = chess.fen();
            const normalizedFen = normalizeFenResetHalfmoveClock(fen);

            if (this.getVariantsForFen(fen) && !seen.has(normalizedFen)) {
                seen.add(normalizedFen);
                result.push(fen);
            }
            chess.undo();
        }

        return result;
    }

    private collectLookaheadEntries(
        fen: string,
        depth: number,
        now: Date,
        path: string,
        entries: FSRSLookaheadEntry[]
    ): void {
        if (depth <= 0) return;

        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        const chess = new Chess(fen);
        const possibleMoves = chess.moves({ verbose: true });

        for (const move of possibleMoves) {
            chess.move(move);
            const reachable = this.getVariantsForFen(chess.fen());
            chess.undo();

            if (reachable && reachable.length > 0) {
                const movePath = path ? `${path} … ${move.san}` : move.san;
                entries.push({
                    fen: normalizedFen,
                    path: movePath,
                    cardData: this.fsrsService.getCardData(normalizedFen, move.san),
                    shouldAutoplay: this.fsrsService.shouldAutoplay(normalizedFen, move.san, now),
                    retrievability: this.fsrsService.getRetrievability(normalizedFen, move.san, now),
                });

                if (depth > 1) {
                    chess.move(move);
                    const opponentMoves = chess.moves({ verbose: true });
                    const seen = new Set<string>();

                    for (const oppMove of opponentMoves) {
                        chess.move(oppMove);
                        const nextFen = chess.fen();
                        const nextNormalized = normalizeFenResetHalfmoveClock(nextFen);

                        if (this.getVariantsForFen(nextFen) && !seen.has(nextNormalized)) {
                            seen.add(nextNormalized);
                            const nextPath = `${movePath} ${oppMove.san}`;
                            this.collectLookaheadEntries(nextFen, depth - 1, now, nextPath, entries);
                        }
                        chess.undo();
                    }
                    chess.undo();
                }
            }
        }
    }

    private getVariantsForFen(fen: string): OpeningVariant[] | undefined {
        const normalizedFen = normalizeFenResetHalfmoveClock(fen);
        return this.fenToVariantMap.get(normalizedFen);
    }
}
