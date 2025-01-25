import { Chess, Move } from 'chess.js';

export class OpeningVariant {

    public chess: Chess = new Chess();

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

    // One-round values. They make sense only if returned as a part of getNextMove
    public isPicked: boolean = false;
    public move: Move | null = null;
    
    constructor(
        public pgn: string,
        public orientation: 'black' | 'white'
    ) {
        this.chess.loadPgn(pgn);
    }
}