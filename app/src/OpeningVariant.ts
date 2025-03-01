import { Chess, Move } from 'chess.js';
import { Annotation } from './Annotation';
import { extractAnnotations } from './AnnotationUtils';

export class OpeningVariant {

    public chess: Chess = new Chess();

    public annotations: { [fen: string]: Annotation[] } = {};
    public pgnWithoutAnnotations: string = '';

    public numberOfTimesPlayed: number = 0; // Not used in probability calculation.

    //=============================================================================
    // Below fields are used to calculate probability of a variant.
    //-----------------------------------------------------------------------------
    // It is used to calculate recency factor.
    public lastSucceededEpoch: number = 0;

    // This represents error decay rather than EMA (should rename it to reflect it).
    // It is used to calculate error factor.
    public errorEMA: number = 0;

    // It is used to calculate frequency factor. Its calculation is spread across two places.
    // Upon loading from storage, if a new epoch has started, it is multiplied by LaunchpadLogic.SUCCESS_EMA_ALPHA.
    // Upon successfully completing a variant it is multiplied by (1 - LaunchpadLogic.SUCCESS_EMA_ALPHA again).
    // Above reprents EMA formula.
    // On top of it, if there was an error playing a variant, then successEMA is set to 0.
    public successEMA: number = 0;
    //=============================================================================

    public currentEpoch: number = 1;

    // Used to update errorEMA at the end of a round. Note, one error might be attributed to multiple variants (if they share a move).
    public numberOfErrors: number = 0;

    // Debug information (shown in a table below the chessboard)
    public weight: number = 0.0;
    public weightedProbability: number = 0.0;
    public recencyFactor: number = 0.0;
    public frequencyFactor: number = 0.0;
    public errorFactor: number = 0.0;
    public newnessFactor: number = 0.0;

    // One-round values. They make sense only if returned as a part of getNextMove
    public isPicked: boolean = false;
    public move: Move | null = null;

    constructor(
        public pgn: string,
        public orientation: 'black' | 'white',
        public classifications: string[]
    ) {
        // PGN might have comments. We should initialize chess.js with a provided PGN,
        // parse comments and convert to annotations.
        // After that, we should remove comments from the PGN (so, they wouldn't appear in places which cannot handle them).
        this.chess.loadPgn(pgn);

        this.chess.getComments().forEach(comment => {
            const fen = comment.fen;
            const fenAnnotations = extractAnnotations(comment.comment);
            this.annotations[fen] = fenAnnotations;
        });
        this.chess.deleteComments();

        this.pgnWithoutAnnotations = this.chess.pgn();
    }

    public calculateWeight(): void {
        // Increase weight if it hasn't been played for a while.
        // For newly added variants this will immediately result in a big weight.
        this.recencyFactor = 1 + (this.currentEpoch - this.lastSucceededEpoch);

        // If we successfully played a variant, decreate its weight.
        // We use EMA to calculate successEMA (see above).
        this.frequencyFactor = 1.0 / Math.pow(1 + this.successEMA, 2);

        // If there were errors while playing a variant, increase its weight.
        this.errorFactor = Math.pow(1.0 + this.errorEMA, 2);

        // If a variant is played less than 7 times, increase its weight.
        this.newnessFactor = Math.pow(1.0 + Math.max(7 - this.numberOfTimesPlayed, 0), 2);

        this.weight = this.errorFactor * this.recencyFactor * this.frequencyFactor * this.newnessFactor;
    }
}