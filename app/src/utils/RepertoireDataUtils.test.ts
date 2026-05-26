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
            expect(repertoireData.lastPlayedDate?.getTime()).toBe(RepertoireDataUtils.getCurrentDateOnly().getTime());
        });

        it('should update lastPlayedDate on new day', () => {
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

            // lastPlayedDate updated to today (local midnight)
            const expectedDate = RepertoireDataUtils.getCurrentDateOnly();
            expect(repertoireData.lastPlayedDate?.getTime()).toBe(expectedDate.getTime());
        });

        it('should NOT update lastPlayedDate if current date has not changed', () => {
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
            expect(repertoireData.lastPlayedDate?.getTime()).toBe(RepertoireDataUtils.getCurrentDateOnly().getTime());

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
            const result = RepertoireDataUtils.convertToRepertoireData(variants);

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
            // No activity provided → dailyPlayCount defaults to 0
            expect(result.dailyPlayCount).toBe(0);

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

            const result = RepertoireDataUtils.convertToRepertoireData(variants, fsrsCards);

            expect(result.fsrsCards).toBe(fsrsCards);
        });

        it('should default fsrsCards to empty object when not provided', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', [])
            ];

            const result = RepertoireDataUtils.convertToRepertoireData(variants);

            expect(result.fsrsCards).toEqual({});
        });

        it('should preserve activity from existing data', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', [])
            ];

            const existingData: RepertoireData = {
                data: [],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 5,
                fsrsCards: {},
                activity: {
                    practiceLog: [{ date: '2026-05-25', reviewed: 10, mistakes: 2, learned: 1, traversals: 3, timeSeconds: 300 }],
                    lifetime: { reviewed: 100, mistakes: 20, learned: 10, traversals: 50, timeSeconds: 5000 },
                },
            };

            const result = RepertoireDataUtils.convertToRepertoireData(variants, {}, null, existingData);

            expect(result.activity).toBeDefined();
            expect(result.activity!.practiceLog).toHaveLength(1);
            expect(result.activity!.practiceLog[0].reviewed).toBe(10);
            expect(result.activity!.lifetime.reviewed).toBe(100);
        });

        it('should have undefined activity when no existing data provided', () => {
            const variants: OpeningVariant[] = [
                new OpeningVariant('1. e4 e5', 'white', [])
            ];

            const result = RepertoireDataUtils.convertToRepertoireData(variants);

            expect(result.activity).toBeUndefined();
        });
    });

    describe('normalize — activity initialization', () => {
        it('initializes activity on data without it (no eager today entry)', () => {
            const data: RepertoireData = {
                data: [{ pgn: '1. e4 e5', orientation: 'white', classifications: [], numberOfTimesPlayed: 0, errorEMA: 0, lastSucceededEpoch: 0, successEMA: 0 }],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                fsrsCards: {},
            };

            RepertoireDataUtils.normalize(data);

            expect(data.activity).toBeDefined();
            // No eager today entry — practice log starts empty
            expect(data.activity!.practiceLog.length).toBe(0);
            expect(data.activity!.lifetime).toBeDefined();
        });

        it('strips blank entries during normalization', () => {
            const data: RepertoireData = {
                data: [{ pgn: '1. e4 e5', orientation: 'white', classifications: [], numberOfTimesPlayed: 0, errorEMA: 0, lastSucceededEpoch: 0, successEMA: 0 }],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                fsrsCards: {},
                activity: {
                    practiceLog: [
                        { date: '2026-05-20', reviewed: 5, mistakes: 1, learned: 0, traversals: 2, timeSeconds: 120 },
                        { date: '2026-05-21', reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
                        { date: '2026-05-22', reviewed: 3, mistakes: 0, learned: 1, traversals: 1, timeSeconds: 60 },
                    ],
                    lifetime: { reviewed: 8, mistakes: 1, learned: 1, traversals: 3, timeSeconds: 180 },
                },
            };

            RepertoireDataUtils.normalize(data);

            // Blank entry for May 21 should be stripped
            expect(data.activity!.practiceLog.length).toBe(2);
            expect(data.activity!.practiceLog[0].date).toBe('2026-05-20');
            expect(data.activity!.practiceLog[1].date).toBe('2026-05-22');
        });

        it('preserves existing activity during normalization', () => {
            const data: RepertoireData = {
                data: [{ pgn: '1. e4 e5', orientation: 'white', classifications: [], numberOfTimesPlayed: 0, errorEMA: 0, lastSucceededEpoch: 0, successEMA: 0 }],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 3,
                fsrsCards: {},
                activity: {
                    practiceLog: [{ date: '2026-05-25', reviewed: 5, mistakes: 1, learned: 0, traversals: 2, timeSeconds: 120 }],
                    lifetime: { reviewed: 50, mistakes: 10, learned: 5, traversals: 20, timeSeconds: 3000 },
                },
            };

            RepertoireDataUtils.normalize(data);

            expect(data.activity!.lifetime.reviewed).toBe(50);
        });
    });
});
