export interface OpeningVariantData {
    pgn: string;
    orientation: 'black' | 'white';
    errorEMA: number;
    numberOfTimesPlayed: number;
    lastSucceededEpoch: number;
    successEMA: number;
}

export interface RepertoireData {
    data: OpeningVariantData[];
    currentEpoch: number;
    lastPlayedDate: Date;
}