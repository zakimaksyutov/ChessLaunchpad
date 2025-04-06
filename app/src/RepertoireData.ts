export interface OpeningVariantData {
    pgn: string;
    orientation: 'black' | 'white';
    classifications: string[];
    errorEMA: number;
    numberOfTimesPlayed: number;
    lastSucceededEpoch: number;
    successEMA: number;
}

export interface RepertoireData {
    data: OpeningVariantData[];
    currentEpoch: number;
    lastPlayedDate: Date;
    dailyPlayCount: number; // How many times user has played on the current date
}