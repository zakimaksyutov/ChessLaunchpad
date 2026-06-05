import { RepertoireDataUtils } from "./RepertoireDataUtils";
import { RepertoireData, OpeningVariantData } from "../models/RepertoireData";
import { FSRSCardData } from "../models/FSRSCardData";
import { FSRSService } from "../services/FSRSService";
import { Chess } from "chess.js";
import { normalizeFenResetHalfmoveClock } from "./FenUtils";

function legacyVariant(pgn: string, orientation: 'white' | 'black'): OpeningVariantData {
    return {
        pgn,
        orientation,
        classifications: [],
        numberOfTimesPlayed: 0,
        errorEMA: 0,
        lastSucceededEpoch: 0,
        successEMA: 0,
    };
}

function startFen(): string {
    return normalizeFenResetHalfmoveClock(new Chess().fen());
}

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

    describe('normalize — bootstrap from legacy shape', () => {
        it('seeds both White and Black entries even with no variants', () => {
            const data: Partial<RepertoireData> = {};
            RepertoireDataUtils.normalize(data as RepertoireData);

            expect(data.repertoires).toBeDefined();
            expect(data.repertoires).toHaveLength(2);
            expect(data.repertoires!.map(r => r.orientation).sort()).toEqual(['black', 'white']);
            // Legacy field stripped after migration.
            expect(data.data).toBeUndefined();
            // Flat card view present and empty.
            expect(data.fsrsCards).toEqual({});
        });

        it('migrates legacy white variant into the White repertoire', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };
            RepertoireDataUtils.normalize(data);

            const white = data.repertoires!.find(r => r.orientation === 'white')!;
            const black = data.repertoires!.find(r => r.orientation === 'black')!;

            expect(Object.keys(white.positions).length).toBeGreaterThan(0);
            expect(Object.keys(black.positions)).toHaveLength(0);

            // After 1.e4 there should be a position whose user-turn move is on white's side.
            const root = startFen();
            expect(white.positions[root]).toBeDefined();
            expect(white.positions[root].moves['e4']).toBeDefined();
            // First move is white (user) → card should be ensured in the flat map.
            const cardKey = FSRSService.makeCardKey(root, 'e4');
            expect(data.fsrsCards![cardKey]).toBeDefined();
            // After prepareDataForSave, the card is projected back into the dict.
            const blob = RepertoireDataUtils.prepareDataForSave(data);
            const blobWhite = blob.repertoires!.find(r => r.orientation === 'white')!;
            expect(blobWhite.positions[root].moves['e4'].card).toBeDefined();
        });

        it('hydrates fsrsCards from legacy fsrsCards map', () => {
            const after_e4_fen = (() => {
                const c = new Chess(); c.move('e4');
                return normalizeFenResetHalfmoveClock(c.fen());
            })();
            const card: FSRSCardData = { d: '2026-05-01T00:00:00.000Z', s: 10, di: 5, e: 1, sd: 7, ls: 0, r: 5, l: 0, st: 2 };
            const legacyKey = FSRSService.makeCardKey(startFen(), 'e4');
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                fsrsCards: { [legacyKey]: card },
            };
            RepertoireDataUtils.normalize(data);

            const white = data.repertoires!.find(r => r.orientation === 'white')!;
            expect(white.positions[startFen()].moves['e4'].card).toEqual(card);
            // Flat-map view also contains the card.
            expect(data.fsrsCards![legacyKey]).toEqual(card);
            // Opponent move (1.e4 by white means e5 by black) has NO card.
            expect(white.positions[after_e4_fen].moves['e5'].card).toBeUndefined();
        });

        it('is idempotent when `repertoires` is already present', () => {
            const data: RepertoireData = {
                repertoires: [
                    { name: 'White', orientation: 'white', positions: {} },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };
            RepertoireDataUtils.normalize(data);
            expect(data.repertoires).toHaveLength(2);
            expect(data.data).toBeUndefined();
        });

        it('drops the legacy `data` field after bootstrap', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };
            RepertoireDataUtils.normalize(data);
            expect(data.data).toBeUndefined();
        });

        it('updates lastPlayedDate on new day', () => {
            const yesterday = RepertoireDataUtils.getCurrentDateOnly();
            yesterday.setDate(yesterday.getDate() - 1);
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 5,
                lastPlayedDate: yesterday,
                dailyPlayCount: 5,
            };
            RepertoireDataUtils.normalize(data);
            expect(data.lastPlayedDate.getTime()).toBe(RepertoireDataUtils.getCurrentDateOnly().getTime());
        });

        describe('preset recalibration', () => {
            afterEach(async () => {
                const { FSRSService } = await import('../services/FSRSService');
                FSRSService.setRetention(0.97);
                FSRSService.setMaxInterval(90);
            });

            it('snaps stored retention/maxInterval to the closest preset on hydrate', async () => {
                const { FSRSService } = await import('../services/FSRSService');
                const data: Partial<RepertoireData> = {
                    settings: { retention: 0.974, maxInterval: 300 },
                } as unknown as Partial<RepertoireData>;
                RepertoireDataUtils.normalize(data as RepertoireData);
                expect(FSRSService.getRetention()).toBe(0.97);
                expect(FSRSService.getMaxInterval()).toBe(90);
            });

            it('low retention snaps to Casual', async () => {
                const { FSRSService } = await import('../services/FSRSService');
                const data: Partial<RepertoireData> = {
                    settings: { retention: 0.85, maxInterval: 30 },
                } as unknown as Partial<RepertoireData>;
                RepertoireDataUtils.normalize(data as RepertoireData);
                expect(FSRSService.getRetention()).toBe(0.95);
                expect(FSRSService.getMaxInterval()).toBe(180);
            });
        });
    });

    describe('prepareDataForSave', () => {
        it('emits `repertoires` and strips legacy `data` / `fsrsCards`', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };
            RepertoireDataUtils.normalize(data);
            const blob = RepertoireDataUtils.prepareDataForSave(data);

            expect(blob.repertoires).toBeDefined();
            expect(blob.repertoires).toHaveLength(2);
            // No legacy fields in the persisted blob.
            expect('data' in blob).toBe(false);
            expect('fsrsCards' in blob).toBe(false);
        });

        it('projects in-memory fsrsCards back into the position dict', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };
            RepertoireDataUtils.normalize(data);

            // Mutate a card on the flat map (simulating FSRSService.rateCard).
            const cardKey = FSRSService.makeCardKey(startFen(), 'e4');
            const fresh: FSRSCardData = { d: '2030-01-01T00:00:00.000Z', s: 99, di: 1, e: 0, sd: 1, ls: 0, r: 1, l: 0, st: 1 };
            data.fsrsCards![cardKey] = fresh;

            const blob = RepertoireDataUtils.prepareDataForSave(data);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            expect(white.positions[startFen()].moves['e4'].card).toEqual(fresh);
        });

        it('preserves activity, games, and settings (incl. linkedAccounts)', () => {
            const data: RepertoireData = {
                data: [],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                activity: {
                    practiceLog: [{ date: '2026-05-25', reviewed: 10, mistakes: 2, learned: 1, traversals: 3, timeSeconds: 300 }],
                    lifetime: { reviewed: 100, mistakes: 20, learned: 10, traversals: 50, timeSeconds: 5000 },
                },
                games: { 'lichess:foo': { watermarkMs: 1234, recentIds: [] } },
                settings: { contextDepth: 4, retention: 0.97 },
            };
            RepertoireDataUtils.normalize(data);

            const blob = RepertoireDataUtils.prepareDataForSave(data);
            expect(blob.activity?.practiceLog).toHaveLength(1);
            expect(blob.games?.['lichess:foo'].watermarkMs).toBe(1234);
            expect(blob.settings?.contextDepth).toBeDefined();
        });

        it('preserves inline cards when called on an un-normalized new-shape blob (importer regression)', () => {
            // Reproduces the import-wipes-cards bug: an imported file in the
            // new shape has `repertoires` but no top-level `fsrsCards` —
            // prepareDataForSave must NOT delete the inline cards.
            const root = startFen();
            const reviewCard: FSRSCardData = { d: '2030-01-01T00:00:00.000Z', s: 50, di: 2, e: 5, sd: 30, ls: 0, r: 10, l: 1, st: 2 };
            const importedBlob: RepertoireData = {
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: { [root]: { moves: { e4: { card: reviewCard } } } },
                    },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };

            const blob = RepertoireDataUtils.prepareDataForSave(importedBlob);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            expect(white.positions[root].moves['e4'].card).toEqual(reviewCard);
        });

        it('preserves draft settings written into existing.settings (SettingsPage save regression)', () => {
            // SettingsPage writes draft contextDepth/retention to current.settings
            // BEFORE calling prepareDataForSave. Those drafts must survive even
            // though the live module vars haven't been updated yet.
            const data: RepertoireData = {
                repertoires: [
                    { name: 'White', orientation: 'white', positions: {} },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                fsrsCards: {},
                settings: { contextDepth: 7, retention: 0.99, maxInterval: 30, linkedAccounts: [{ platform: 'lichess', username: 'someone' }] },
            };

            const blob = RepertoireDataUtils.prepareDataForSave(data);
            expect(blob.settings?.contextDepth).toBe(7);
            expect(blob.settings?.retention).toBe(0.99);
            expect(blob.settings?.maxInterval).toBe(30);
            expect(blob.settings?.linkedAccounts).toEqual([{ platform: 'lichess', username: 'someone' }]);
        });

        it('defensively bootstraps legacy `data` if `repertoires` is missing', () => {
            // Footgun protection: if a caller hands a raw legacy blob to
            // prepareDataForSave (without going through normalize), we should
            // migrate it rather than silently emit an empty repertoire.
            const root = startFen();
            const cardKey = FSRSService.makeCardKey(root, 'e4');
            const card: FSRSCardData = { d: '2030-01-01T00:00:00.000Z', s: 50, di: 2, e: 5, sd: 30, ls: 0, r: 10, l: 1, st: 2 };
            const legacyBlob: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                fsrsCards: { [cardKey]: card },
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };

            const blob = RepertoireDataUtils.prepareDataForSave(legacyBlob);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            expect(Object.keys(white.positions).length).toBeGreaterThan(0);
            expect(white.positions[root].moves['e4'].card).toEqual(card);
        });

        it('migrates legacy `trainingSettings` to `settings` on save (importer compat)', () => {
            // Old blobs used `trainingSettings` instead of `settings`.
            // `normalize()` migrates the field name; the import flow goes
            // through normalize before prepareDataForSave so the imported
            // settings should survive.
            const data: RepertoireData = {
                data: [],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                trainingSettings: { contextDepth: 5, retention: 0.96, linkedAccounts: [{ platform: 'lichess', username: 'imported' }] },
            };
            RepertoireDataUtils.normalize(data);
            const blob = RepertoireDataUtils.prepareDataForSave(data);
            expect(blob.settings?.contextDepth).toBe(5);
            expect(blob.settings?.linkedAccounts).toEqual([{ platform: 'lichess', username: 'imported' }]);
        });

        it('persists New-state cards synthesized by normalize for legacy variants with no fsrsCards', () => {
            // Legacy import with PGN moves but no fsrsCards map.
            // normalize() calls ensureCard for each user-turn edge — those
            // New-state cards must end up in the saved blob's repertoires dict,
            // not get dropped on the projection round-trip.
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
                // No fsrsCards — simulates a legacy export from a user who
                // never reviewed a card.
            };
            RepertoireDataUtils.normalize(data);
            const blob = RepertoireDataUtils.prepareDataForSave(data);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            const root = startFen();
            expect(white.positions[root].moves['e4'].card).toBeDefined();
            // ensureCard creates cards in State.New (st: 0).
            expect(white.positions[root].moves['e4'].card!.st).toBe(0);
        });
    });

    describe('normalize — activity initialization', () => {
        it('initializes activity on data without it (no eager today entry)', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
            };
            RepertoireDataUtils.normalize(data);
            expect(data.activity).toBeDefined();
            expect(data.activity!.practiceLog).toHaveLength(0);
        });

        it('strips blank entries during normalization', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
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
            expect(data.activity!.practiceLog).toHaveLength(2);
            expect(data.activity!.practiceLog[0].date).toBe('2026-05-20');
            expect(data.activity!.practiceLog[1].date).toBe('2026-05-22');
        });

        it('preserves existing activity during normalization', () => {
            const data: RepertoireData = {
                data: [legacyVariant('1. e4 e5', 'white')],
                currentEpoch: 0,
                lastPlayedDate: new Date(),
                dailyPlayCount: 0,
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
