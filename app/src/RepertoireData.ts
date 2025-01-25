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

export class LocalStorageData {
    public static getHistoricalData(): RepertoireData {
        const data = localStorage.getItem('historicalData');
        if (data) {
            try {
                const parsedData = JSON.parse(data);
                if (parsedData.lastPlayedDate) {
                    parsedData.lastPlayedDate = new Date(parsedData.lastPlayedDate);
                }
                return parsedData;
            } catch (e) {
                console.error(`Failed to parse historical data from localStorage: '${e}' with data '${data}'`);
            }
        }
        return { data: [], currentEpoch: 0, lastPlayedDate: new Date(0) };
    }

    public static setHistoricalData(data: RepertoireData): void {
        localStorage.setItem('historicalData', JSON.stringify(data));
    }
}