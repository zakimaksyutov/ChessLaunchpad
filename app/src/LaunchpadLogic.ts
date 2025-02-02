import { Chess, Move } from 'chess.js';
import { OpeningVariant } from './OpeningVariant';
import { Annotation } from './Annotation';

export class LaunchpadLogic {

    private allVariants: OpeningVariant[];
    private fenToVariantMap: Map<string, OpeningVariant[]>;

    private ERROR_EMA_ALPHA = 0.7;
    public static SUCCESS_EMA_ALPHA = 0.6667; // Similar to averaging across three epochs.

    // Used to properly attribute a game to errorEMA and lastSucceededEpoch
    private hasErrors: boolean = false;

    constructor(variants: OpeningVariant[]) {
        this.allVariants = variants;
        this.fenToVariantMap = new Map<string, OpeningVariant[]>();

        this.initializeFenToVariantMap();
    }

    public getAllVariants(): OpeningVariant[] {
        return this.allVariants;
    }

    public isValidVariant(fen: string): boolean {
        const normalizedFen = this.resetHalfmoveClock(fen);
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
        const variants = this.getVariantsForFen(fen)!;
        const annotations: Annotation[] = [];
        for (const variant of variants) {
            const variantAnnotations = variant.annotations[fen];
            if (variantAnnotations) {
                annotations.push(...variantAnnotations);
            }
        }
        return annotations;
    }

    public markError(fen: string) {
        this.hasErrors = true;

        const variants = this.getVariantsForFen(fen)!;

        for (const variant of variants) {
            variant.numberOfErrors += 1.0 / variants.length; // Distribute an error across all applicable variants.
        }
    }

    public hadErrors(): boolean {
        return this.hasErrors;
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
            this.calculateWeight(variant);
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

    public calculateWeight(variant: OpeningVariant): void {
        // Increase weight if it hasn't been played for a while.
        // For newly added variants this will immediately result in a big weight.
        variant.recencyFactor = 1 + (variant.currentEpoch - variant.lastSucceededEpoch);

        // If we successfully played a variant, decreate its weight.
        // We use EMA to calculate successEMA (see above).
        variant.frequencyFactor = 1.0 / Math.pow(1 + variant.successEMA, 2);

        // If there were errors while playing a variant, increase its weight.
        variant.errorFactor = Math.pow(1.0 + variant.errorEMA, 2);

        variant.weight = variant.errorFactor * variant.recencyFactor * variant.frequencyFactor;
    }

    private calculateProbability(weight: number, variants: OpeningVariant[]): number {
        const totalWeight = variants.reduce((sum, variant) => sum + variant.weight, 0);
        return weight / totalWeight;
    }

    // We use FEN as a key. And in order to be able to jump from one variant to another, we need to reset halfmove clock.
    // This clock is used to determine if a draw can be claimed by the fifty-move rule. Since this app focuses on openings - it is not relevant.
    // Example:
    // 1. e4 c5 2. Nf3 e6  3. d4 cxd4 4. Nxd4 Nc6 => r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5
    // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6  => r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 0 5
    private resetHalfmoveClock(fen: string): string {
        const parts = fen.split(" ");
        parts[4] = "0"; // parts[4] is the halfmove clock field
        return parts.join(" ");
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
        const normalizedFen = this.resetHalfmoveClock(fen);
        if (!this.fenToVariantMap.has(normalizedFen)) {
            this.fenToVariantMap.set(normalizedFen, []);
        }
        this.fenToVariantMap.get(normalizedFen)?.push(variant);
    }

    private getVariantsForFen(fen: string): OpeningVariant[] | undefined {
        const normalizedFen = this.resetHalfmoveClock(fen);
        return this.fenToVariantMap.get(normalizedFen);
    }
}
