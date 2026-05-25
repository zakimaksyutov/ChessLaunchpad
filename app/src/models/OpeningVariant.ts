export class OpeningVariant {

    public numberOfTimesPlayed: number = 0;

    constructor(
        public pgn: string,
        public orientation: 'black' | 'white',
        public classifications: string[]
    ) {}
}
