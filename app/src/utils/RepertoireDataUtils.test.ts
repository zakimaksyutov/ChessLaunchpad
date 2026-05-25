import { RepertoireDataUtils } from "./RepertoireDataUtils";
import { RepertoireData, OpeningVariantData } from "../models/RepertoireData";
import { OpeningVariant } from "../models/OpeningVariant";
import { FSRSCardData } from "../models/FSRSCardData";

describe('RepertoireDataUtils', () => {
    beforeEach(() => {
        vi.resetAllMocks();

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-23T17:08:34.159Z').getTime());
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
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
            expect(repertoireData.fsrsCards).toEqual({});
            expect(repertoireData.currentEpoch).toBe(0);
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
            // V1 stubs always 0
            expect(repertoireData.data![0].errorEMA).toBe(0);
            expect(repertoireData.data![0].successEMA).toBe(0);
            expect(repertoireData.data![0].lastSucceededEpoch).toBe(0);
            expect(repertoireData.data![0].numberOfTimesPlayed).toBe(0);
            expect(repertoireData.data![0].pgn).toBe('1. e4 e5');
            expect(repertoireData.data![0].orientation).toBe('white');
            expect(repertoireData.currentEpoch).toBe(0);
            expect(repertoireData.lastPlayedDate?.toISOString()).toBe('2025-01-23T00:00:00.000Z');
        });

        it('should reset dailyPlayCount on new day', () => {
            // Prepare
            const yesterday = RepertoireDataUtils.getCurrentDateOnly();
            yesterday.setDate(yesterday.getDate() - 1); // set to "yesterday"

            const repertoireData: RepertoireData = {
                data: [
                    {
                        pgn: '1. e4 e5',
                        orientation: 'white',
                        classifications: [],
                        numberOfTimesPlayed: 1,
                        errorEMA: 1,
                        lastSucceededEpoch: 0,
                        successEMA: 10
                    }
                ],
                currentEpoch: 5,
                lastPlayedDate: yesterday,
                dailyPlayCount: 5,
            };

            // Act
            RepertoireDataUtils.normalize(repertoireData);

            // Assert — V1 stubs always reset to 0
            expect(repertoireData.currentEpoch).toBe(0);
            expect(repertoireData.data[0].errorEMA).toBe(0);
            expect(repertoireData.data[0].successEMA).toBe(0);
            expect(repertoireData.data[0].lastSucceededEpoch).toBe(0);

            // lastPlayedDate updated to today
            expect(repertoireData.lastPlayedDate?.toISOString()).toBe('2025-01-23T00:00:00.000Z');

            // Check dailyPlayCount gets reset on new day
            expect(repertoireData.dailyPlayCount).toBe(0);
        });

        it('should NOT reset dailyPlayCount if current date has not changed', () => {
            // Prepare
            const repertoireData: RepertoireData = {
                data: [
                    {
                        pgn: '1. e4 e5',
                        orientation: 'white',
                        classifications: [],
                        numberOfTimesPlayed: 1,
                        errorEMA: 1,
                        lastSucceededEpoch: 0,
                        successEMA: 10
                    }
                ],
                currentEpoch: 5,
                lastPlayedDate: RepertoireDataUtils.getCurrentDateOnly(),
                dailyPlayCount: 5,
            };

            // Act
            RepertoireDataUtils.normalize(repertoireData);

            // Assert
            expect(repertoireData.lastPlayedDate?.toISOString()).toBe('2025-01-23T00:00:00.000Z');

            // Confirm dailyPlayCount remains unchanged if the day hasn't changed
            expect(repertoireData.dailyPlayCount).toBe(5);

            // V1 stubs still 0
            expect(repertoireData.currentEpoch).toBe(0);
            expect(repertoireData.data[0].errorEMA).toBe(0);
            expect(repertoireData.data[0].successEMA).toBe(0);
        });

        it('should reconcile fsrsCards during normalization (remove stale, keep valid)', () => {
            const cards: Record<string, FSRSCardData> = {
                'fen1::e4': { d: '2026-05-01T00:00:00.000Z', s: 10, di: 5, e: 1, sd: 7, ls: 0, r: 5, l: 0, st: 2 }
            };
            const repertoireData: RepertoireData = {
                data: [],
                currentEpoch: 5,
                lastPlayedDate: RepertoireDataUtils.getCurrentDateOnly(),
                dailyPlayCount: 0,
                fsrsCards: cards
            };

            RepertoireDataUtils.normalize(repertoireData);

            // With no variants, the stale card should be removed by reconciliation
            expect(repertoireData.fsrsCards).toBeDefined();
            expect(Object.keys(repertoireData.fsrsCards!)).toHaveLength(0);
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
                        numberOfTimesPlayed: 5,
                        errorEMA: 0,
                        lastSucceededEpoch: 0,
                        successEMA: 0,
                    },
                    {
                        pgn: '1. d4 d5',
                        orientation: 'white',
                        classifications: [],
                        numberOfTimesPlayed: 10,
                        errorEMA: 0,
                        lastSucceededEpoch: 0,
                        successEMA: 0,
                    },
                ],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };

            // Act
            const variants = RepertoireDataUtils.convertToVariantData(repertoireData);

            // Assert
            expect(variants).toHaveLength(2);

            // Sort order is by pgn.localeCompare => "1. d4 d5" < "1. e4 e5"
            expect(variants[0].pgn).toBe('1. d4 d5');
            expect(variants[1].pgn).toBe('1. e4 e5');

            // Only numberOfTimesPlayed is carried over
            expect(variants[0].numberOfTimesPlayed).toBe(10);
            expect(variants[1].numberOfTimesPlayed).toBe(5);
        });
    });

    describe('convertToRepertoireData', () => {
        it('should convert an array of OpeningVariant objects into RepertoireData', () => {
            // Prepare
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', []),
                new OpeningVariant('1. d4 d5', 'white', [])
            ];

            variants[0].numberOfTimesPlayed = 10;
            variants[1].numberOfTimesPlayed = 20;

            // Act
            const result = RepertoireDataUtils.convertToRepertoireData(variants, 3);

            // Assert
            expect(result.data).toHaveLength(2);

            // Data should be in the same order as variants array
            expect(result.data[0].pgn).toBe('1. e4 e5');
            expect(result.data[0].numberOfTimesPlayed).toBe(10);
            // V1 stubs always 0
            expect(result.data[0].errorEMA).toBe(0);
            expect(result.data[0].successEMA).toBe(0);
            expect(result.data[0].lastSucceededEpoch).toBe(0);

            expect(result.data[1].pgn).toBe('1. d4 d5');
            expect(result.data[1].numberOfTimesPlayed).toBe(20);
            expect(result.data[1].errorEMA).toBe(0);
            expect(result.data[1].successEMA).toBe(0);
            expect(result.data[1].lastSucceededEpoch).toBe(0);

            expect(result.currentEpoch).toBe(0);
            expect(result.dailyPlayCount).toBe(3);

            // lastPlayedDate should be "today"
            const today = RepertoireDataUtils.getCurrentDateOnly();
            expect(result.lastPlayedDate.getFullYear()).toBe(today.getFullYear());
            expect(result.lastPlayedDate.getMonth()).toBe(today.getMonth());
            expect(result.lastPlayedDate.getDate()).toBe(today.getDate());
        });

        it('should include fsrsCards when provided', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', [])
            ];

            const fsrsCards: Record<string, FSRSCardData> = {
                'fen1::e4': { d: '2026-05-01T00:00:00.000Z', s: 10, di: 5, e: 1, sd: 7, ls: 0, r: 5, l: 0, st: 2 }
            };

            const result = RepertoireDataUtils.convertToRepertoireData(variants, 1, fsrsCards);

            expect(result.fsrsCards).toBe(fsrsCards);
        });

        it('should default fsrsCards to empty object when not provided', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', [])
            ];

            const result = RepertoireDataUtils.convertToRepertoireData(variants, 1);

            expect(result.fsrsCards).toEqual({});
        });
    });
});
