import { RepertoireDataUtils } from "./RepertoireDataUtils";
import { RepertoireData, OpeningVariantData } from "./RepertoireData";
import { OpeningVariant } from "./OpeningVariant";

// --- Mocks ---
jest.mock('./LaunchpadLogic', () => ({
    LaunchpadLogic: {
        SUCCESS_EMA_ALPHA: 0.5
    }
}));

describe('RepertoireDataUtils', () => {
    beforeEach(() => {
        jest.resetAllMocks();

        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-23T17:08:34.159Z').getTime());
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('normalize', () => {
        it('should not add any variants', () => {
            // Prepare
            const repertoireData: Partial<RepertoireData> = {};

            // Act
            RepertoireDataUtils.normalize(repertoireData as RepertoireData);

            // Assert
            expect(repertoireData.data).toBeDefined();
            expect(repertoireData.data).toHaveLength(0);
        });

        it('should set default fields if they are missing', () => {
            // Prepare
            const repertoireData: Partial<RepertoireData> = {
                data: [
                    { pgn: '1. e4 e5', orientation: 'white' } as unknown as OpeningVariantData
                ]
            };

            // Act
            RepertoireDataUtils.normalize(repertoireData as RepertoireData);

            // Assert
            expect(repertoireData.data).toBeDefined();
            expect(repertoireData.data).toHaveLength(1);
            expect(repertoireData.data![0].errorEMA).toBe(0);
            expect(repertoireData.data![0].successEMA).toBe(0);
            expect(repertoireData.data![0].lastSucceededEpoch).toBe(0);
            expect(repertoireData.data![0].numberOfTimesPlayed).toBe(0);
            expect(repertoireData.data![0].pgn).toBe('1. e4 e5');
            expect(repertoireData.data![0].orientation).toBe('white');
            expect(repertoireData.currentEpoch).toBe(1);
            expect(repertoireData.lastPlayedDate?.toISOString()).toBe('2025-01-23T00:00:00.000Z');
        });

        it('should increment epoch and adjust success EMA if current date > lastPlayedDate (next day)', () => {
            // Prepare
            const yesterday = RepertoireDataUtils.getCurrentDateOnly();
            yesterday.setDate(yesterday.getDate() - 1); // set to "yesterday"

            const repertoireData: RepertoireData = {
                data: [
                    {
                        pgn: '1. e4 e5',
                        orientation: 'white',
                        classifications: [],
                        errorEMA: 1,
                        numberOfTimesPlayed: 1,
                        lastSucceededEpoch: 0,
                        successEMA: 10
                    }
                ],
                currentEpoch: 5,
                lastPlayedDate: yesterday
            };

            // Act
            RepertoireDataUtils.normalize(repertoireData);

            // Assert
            expect(repertoireData.currentEpoch).toBe(6);

            // Also check that lastPlayedDate has been updated to today's date only
            expect(repertoireData.lastPlayedDate?.toISOString()).toBe('2025-01-23T00:00:00.000Z');

            // Validate that successEMA has been adjusted
            expect(repertoireData.data[0].successEMA).toBe(10 * 0.5);
        });

        it('should NOT increment epoch and adjust success EMA if current date has not changed', () => {
            // Prepare
            const yesterday = RepertoireDataUtils.getCurrentDateOnly();
            yesterday.setDate(yesterday.getDate() - 1); // set to "yesterday"

            const repertoireData: RepertoireData = {
                data: [
                    {
                        pgn: '1. e4 e5',
                        orientation: 'white',
                        classifications: [],
                        errorEMA: 1,
                        numberOfTimesPlayed: 1,
                        lastSucceededEpoch: 0,
                        successEMA: 10
                    }
                ],
                currentEpoch: 5,
                lastPlayedDate: RepertoireDataUtils.getCurrentDateOnly()
            };

            // Act
            RepertoireDataUtils.normalize(repertoireData);

            // Assert
            expect(repertoireData.currentEpoch).toBe(5);

            // Also check that lastPlayedDate has been updated to today's date only
            expect(repertoireData.lastPlayedDate?.toISOString()).toBe('2025-01-23T00:00:00.000Z');

            // Validate that successEMA has NOT been adjusted
            expect(repertoireData.data[0].successEMA).toBe(10);
        });
    });

    describe('convertToVariantData', () => {
        it('should convert RepertoireData to an array of OpeningVariant objects', () => {
            // Prepare
            const repertoireData: RepertoireData = {
                data: [
                    {
                        pgn: '1. e4 e5',
                        orientation: 'white',
                        classifications: [],
                        errorEMA: 2,
                        numberOfTimesPlayed: 5,
                        lastSucceededEpoch: 3,
                        successEMA: 1.5
                    },
                    {
                        pgn: '1. d4 d5',
                        orientation: 'white',
                        classifications: [],
                        errorEMA: 0,
                        numberOfTimesPlayed: 10,
                        lastSucceededEpoch: 2,
                        successEMA: 2
                    },
                ],
                currentEpoch: 10,
                lastPlayedDate: new Date()
            };

            // Act
            const variants = RepertoireDataUtils.convertToVariantData(repertoireData);

            // Assert
            expect(variants).toHaveLength(2);

            // Sort order is by pgn.localeCompare => "1. d4 d5" < "1. e4 e5"
            expect(variants[0].pgn).toBe('1. d4 d5');
            expect(variants[1].pgn).toBe('1. e4 e5');

            // Check properties
            expect(variants[0].errorEMA).toBe(0);
            expect(variants[0].numberOfTimesPlayed).toBe(10);
            expect(variants[0].lastSucceededEpoch).toBe(2);
            expect(variants[0].successEMA).toBe(2);
            expect(variants[0].currentEpoch).toBe(10);

            expect(variants[1].errorEMA).toBe(2);
            expect(variants[1].numberOfTimesPlayed).toBe(5);
            expect(variants[1].lastSucceededEpoch).toBe(3);
            expect(variants[1].successEMA).toBe(1.5);
            expect(variants[1].currentEpoch).toBe(10);
        });
    });

    describe('convertToRepertoireData', () => {
        it('should convert an array of OpeningVariant objects into RepertoireData', () => {
            // Prepare
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', []),
                new OpeningVariant('1. d4 d5', 'white', [])
            ];

            // Modify some fields
            variants[0].errorEMA = 3;
            variants[0].successEMA = 5;
            variants[0].lastSucceededEpoch = 2;
            variants[0].numberOfTimesPlayed = 10;
            variants[0].currentEpoch = 7;

            variants[1].errorEMA = 1;
            variants[1].successEMA = 2;
            variants[1].lastSucceededEpoch = 5;
            variants[1].numberOfTimesPlayed = 20;
            variants[1].currentEpoch = 9; // bigger than first

            // Act
            const result = RepertoireDataUtils.convertToRepertoireData(variants);

            // Assert
            expect(result.data).toHaveLength(2);

            // Data should be in the same order as variants array
            expect(result.data[0].pgn).toBe('1. e4 e5');
            expect(result.data[0].errorEMA).toBe(3);
            expect(result.data[0].successEMA).toBe(5);
            expect(result.data[0].lastSucceededEpoch).toBe(2);
            expect(result.data[0].numberOfTimesPlayed).toBe(10);

            expect(result.data[1].pgn).toBe('1. d4 d5');
            expect(result.data[1].errorEMA).toBe(1);
            expect(result.data[1].successEMA).toBe(2);
            expect(result.data[1].lastSucceededEpoch).toBe(5);
            expect(result.data[1].numberOfTimesPlayed).toBe(20);

            // currentEpoch should be the max among the variants
            expect(result.currentEpoch).toBe(9);

            // lastPlayedDate should be "today"
            const today = RepertoireDataUtils.getCurrentDateOnly();
            expect(result.lastPlayedDate.getFullYear()).toBe(today.getFullYear());
            expect(result.lastPlayedDate.getMonth()).toBe(today.getMonth());
            expect(result.lastPlayedDate.getDate()).toBe(today.getDate());
        });
    });
});