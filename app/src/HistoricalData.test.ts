import { LocalStorageData, HistoricalData } from "./HistoricalData";

describe('LocalStorageData', () => {
    const mockData: HistoricalData = {
        data: [
            {
                pgn: '1. e4 e5 2. Nf3 Nc6',
                orientation: 'white',
                errorEMA: 0.5,
                numberOfTimesPlayed: 15,
                lastSucceededEpoch: 0,
                successEMA: 0
            },
        ],
        currentEpoch: 42,
        lastPlayedDate: new Date(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
    });

    it('should return default historical data if no data exists in localStorage', () => {
        jest.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);

        const result = LocalStorageData.getHistoricalData();

        expect(result).toEqual({ data: [], currentEpoch: 0, lastPlayedDate: new Date(0) });
    });

    it('should return parsed historical data if data exists in localStorage', () => {
        jest.spyOn(Storage.prototype, 'getItem').mockReturnValue(JSON.stringify(mockData));

        const result = LocalStorageData.getHistoricalData();

        expect(result).toEqual(mockData);
    });

    it('should save historical data to localStorage', () => {
        const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

        LocalStorageData.setHistoricalData(mockData);

        expect(setItemSpy).toHaveBeenCalledWith('historicalData', JSON.stringify(mockData));
    });

    it('should handle invalid JSON in localStorage gracefully', () => {
        jest.spyOn(Storage.prototype, 'getItem').mockReturnValue('invalid json');

        const result = LocalStorageData.getHistoricalData();

        expect(result).toEqual({ data: [], currentEpoch: 0, lastPlayedDate: new Date(0) });
    });
});