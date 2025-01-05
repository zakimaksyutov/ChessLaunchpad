import { HistoricalDataUtils } from "./HistoricalDataUtils";
import { OpeningVariant } from "./OpeningVariant";
import { HistoricalData } from "./HistoricalData";

describe('HistoricalDataUtils', () => {
    describe('applyHistoricalData', () => {
        it('should apply historical data to the variants correctly', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('varian1', '1. e4', 'white'),
                new OpeningVariant('varian2', '1. d4', 'black'),
            ];

            const historicalData: HistoricalData = {
                currentEpoch: 5,
                lastPlayedDate: HistoricalDataUtils.getCurrnetDateOnly(),
                data: [
                    { pgn: '1. e4', orientation: 'white', errorEMA: 1.5, lastSucceededEpoch: 3, numberOfTimesPlayed: 1, successEMA: 0 },
                    { pgn: '1. d4', orientation: 'black', errorEMA: 2.0, lastSucceededEpoch: 4, numberOfTimesPlayed: 2, successEMA: 0 }
                ]
            };

            HistoricalDataUtils.applyHistoricalData(variants, historicalData);

            expect(variants[0].errorEMA).toBe(1.5);
            expect(variants[0].lastSucceededEpoch).toBe(3);
            expect(variants[0].numberOfErrors).toBe(0);
            expect(variants[0].currentEpoch).toBe(5);

            expect(variants[1].errorEMA).toBe(2.0);
            expect(variants[1].lastSucceededEpoch).toBe(4);
            expect(variants[1].numberOfErrors).toBe(0);
            expect(variants[1].currentEpoch).toBe(5);
        });

        it('should account for orientation in addition to PGN', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('varian1', '1. e4', 'white'),
                new OpeningVariant('varian2', '1. e4', 'black'),
            ];

            const historicalData: HistoricalData = {
                currentEpoch: 5,
                lastPlayedDate: HistoricalDataUtils.getCurrnetDateOnly(),
                data: [
                    { pgn: '1. e4', orientation: 'black', errorEMA: 2.0, lastSucceededEpoch: 4, numberOfTimesPlayed: 2, successEMA: 0 }
                ]
            };

            HistoricalDataUtils.applyHistoricalData(variants, historicalData);

            expect(variants[0].errorEMA).toBe(0);
            expect(variants[0].lastSucceededEpoch).toBe(0);
            expect(variants[0].numberOfErrors).toBe(0);
            expect(variants[0].currentEpoch).toBe(5);

            expect(variants[1].errorEMA).toBe(2.0);
            expect(variants[1].lastSucceededEpoch).toBe(4);
            expect(variants[1].numberOfErrors).toBe(0);
            expect(variants[1].currentEpoch).toBe(5);
        });

        it('should not modify variants if no matching historical data is found', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('varian1', '1. e4', 'white')
            ];

            const historicalData: HistoricalData = {
                currentEpoch: 5,
                lastPlayedDate: HistoricalDataUtils.getCurrnetDateOnly(),
                data: [
                    { pgn: 'd4', orientation: 'black', errorEMA: 2.0, lastSucceededEpoch: 4, numberOfTimesPlayed: 1, successEMA: 0 }
                ]
            };

            HistoricalDataUtils.applyHistoricalData(variants, historicalData);

            expect(variants[0].errorEMA).toBe(0);
            expect(variants[0].lastSucceededEpoch).toBe(0);
            expect(variants[0].numberOfErrors).toBe(0);
            expect(variants[0].currentEpoch).toBe(5);
        });

        it('epoch is not incremented if already played this date', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('varian1', '1. e4', 'white'),
            ];

            const historicalData: HistoricalData = {
                currentEpoch: 1,
                lastPlayedDate: HistoricalDataUtils.getCurrnetDateOnly(),
                data: [
                    { pgn: '1. e4', orientation: 'white', errorEMA: 1.5, lastSucceededEpoch: 3, numberOfTimesPlayed: 1, successEMA: 0 },
                ]
            };

            HistoricalDataUtils.applyHistoricalData(variants, historicalData);

            expect(variants[0].currentEpoch).toBe(1); // not incremented
        });

        it('epoch is incremented if this is a new date', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('varian1', '1. e4', 'white'),
            ];

            const yesterday = HistoricalDataUtils.getCurrnetDateOnly();
            yesterday.setDate(yesterday.getDate() - 1);

            const historicalData: HistoricalData = {
                currentEpoch: 1,
                lastPlayedDate: yesterday,
                data: [
                    { pgn: '1. e4', orientation: 'white', errorEMA: 1.5, lastSucceededEpoch: 3, numberOfTimesPlayed: 1, successEMA: 0 },
                ]
            };

            HistoricalDataUtils.applyHistoricalData(variants, historicalData);

            expect(variants[0].currentEpoch).toBe(2); // incremented
        });
    });
});