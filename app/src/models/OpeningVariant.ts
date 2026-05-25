import { Chess, Move } from 'chess.js';
import { Annotation } from './Annotation';
import { extractAnnotations } from '../utils/AnnotationUtils';

export class OpeningVariant {

    public chess: Chess = new Chess();

    public annotations: { [fen: string]: Annotation[] } = {};
    public pgnWithoutAnnotations: string = '';

    public numberOfTimesPlayed: number = 0;

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
}
