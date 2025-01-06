import { Chess, Move } from 'chess.js';
import { OpeningVariant } from './OpeningVariant';

export class LaunchpadLogic {

    private variants: OpeningVariant[];
    private fenToVariantMap: Map<string, OpeningVariant[]>;

    private ERROR_EMA_ALPHA = 0.7;
    public static SUCCESS_EMA_ALPHA = 0.6667; // Similar to averaging across three epochs.

    // Used to properly attribute a game to errorEMA and lastSucceededEpoch
    private hasErrors: boolean = false;

    constructor(variants: OpeningVariant[]) {
        this.variants = variants;
        this.fenToVariantMap = new Map<string, OpeningVariant[]>();

        this.initializeFenToVariantMap();
    }

    public isValidVariant(fen: string): boolean {
        return this.fenToVariantMap.has(fen);
    }

    public isEndOfVariant(fen: string, moveIndex: number): boolean {
        const variants = this.fenToVariantMap.get(fen)!;

        for (const variant of variants) {
            const moves = variant.chess.history({ verbose: true });
            if (moves.length === moveIndex) {
                return true;
            }
        }

        return false;
    }

    public markError(fen: string) {
        this.hasErrors = true;

        const variants = this.fenToVariantMap.get(fen)!;

        for (const variant of variants) {
            variant.numberOfErrors += 1.0 / variants.length; // Distribute an error across all applicable variants.
        }
    }

    public completeVariant(fen: string) {
        const variants = this.fenToVariantMap.get(fen)!;

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
            for (const variant of this.variants) {
                if (variant.numberOfErrors > 0) {
                    variant.errorEMA = variant.errorEMA * this.ERROR_EMA_ALPHA + variant.numberOfErrors;
                    variant.successEMA = 0;
                }
            }
        }
    }

    public getApplicableVariants(fen: string, moveIndex: number): OpeningVariant[] {
        return this.fenToVariantMap.get(fen)!;
    }

    // This function is called only when isValidVariant is true and isEndOfVariant is false.
    // So, there is a guarantee that there is at least one variant with a move at the given index.
    public getNextMove(fen: string, moveIndex: number): Move {
        const variants = this.fenToVariantMap.get(fen)!;

        // Calculate weighted probability.
        for (const variant of variants) {
            this.calculateWeight(variant);
        }
        for (const variant of variants) {
            variant.weightedProbability = this.calculateProbability(variant.weight, variants);
        }

        // Reset isPicked
        for (const variant of variants) {
            variant.isPicked = false;
        }

        // Randomly select a variant.
        const variant = this.pickVariantBasedOnWeightedProbability(variants);
        
        variant.isPicked = true;

        const moves = variant.chess.history({ verbose: true });

        if (moves.length <= moveIndex) {
            throw new Error(`No next move available for the given FEN and move index. FEN: '${fen}', Move Index: '${moveIndex}'. Variant '${variant.name}' has only ${moves.length} moves: '${variant.pgn}'`);
        }

        return moves[moveIndex];
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

    private initializeFenToVariantMap() {
        this.variants.forEach(variant => {
            try {
                const moves = variant.chess.history({ verbose: true });

                const chess = new Chess();

                // Initial position is valid for all variants
                this.addVariantToMap(chess.fen(), variant, 0);

                moves.forEach((move, index) => {
                    chess.move(move);
                    this.addVariantToMap(chess.fen(), variant, index + 1);
                });
            } catch (error) {
                console.error('Invalid PGN for variant: ' + variant.name + ' - ' + error);
                throw new Error('Invalid PGN for variant: ' + variant.name);
            }
        });
    }

    private addVariantToMap(fen: string, variant: OpeningVariant, moveIndex: number) {
        if (!this.fenToVariantMap.has(fen)) {
            this.fenToVariantMap.set(fen, []);
        }
        this.fenToVariantMap.get(fen)?.push(variant);
    }
}
