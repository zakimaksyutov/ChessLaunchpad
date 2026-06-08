import { RepertoireDataUtils } from "./RepertoireDataUtils";
import { RepertoireData } from "../models/RepertoireData";
import { FSRSCardData } from "../models/FSRSCardData";
import { FSRSService } from "../services/FSRSService";
import { Chess } from "chess.js";
import { normalizeFenResetHalfmoveClock } from "./FenUtils";
import { pgnToRepertoires } from "../test-utils/repertoireBuilders";

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

    describe('normalize — seed and hydration', () => {
        it('seeds both White and Black entries when `repertoires` is missing', () => {
            const data: Partial<RepertoireData> = {};
            RepertoireDataUtils.normalize(data as RepertoireData);

            expect(data.repertoires).toBeDefined();
            expect(data.repertoires).toHaveLength(2);
            expect(data.repertoires!.map(r => r.orientation).sort()).toEqual(['black', 'white']);
            // Flat card view present and empty.
            expect(data.fsrsCards).toEqual({});
        });

        it('synthesizes New-state cards for every user-turn edge', () => {
            const data: RepertoireData = {
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
            };
            RepertoireDataUtils.normalize(data);

            const white = data.repertoires!.find(r => r.orientation === 'white')!;
            const black = data.repertoires!.find(r => r.orientation === 'black')!;

            expect(Object.keys(white.positions).length).toBeGreaterThan(0);
            expect(Object.keys(black.positions)).toHaveLength(0);

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

        it('keeps pre-existing inline cards on user-turn moves', () => {
            const root = startFen();
            const card: FSRSCardData = { due: '2026-05-01T00:00:00.000Z', stability: 10, difficulty: 5, elapsedDays: 1, scheduledDays: 7, learningSteps: 0, reps: 5, lapses: 0, state: 2 };
            const cardKey = FSRSService.makeCardKey(root, 'e4');
            const reps = pgnToRepertoires(
                [{ pgn: '1. e4 e5', orientation: 'white' }],
                { [cardKey]: card },
            );
            const data: RepertoireData = { repertoires: reps };
            RepertoireDataUtils.normalize(data);

            const white = data.repertoires!.find(r => r.orientation === 'white')!;
            expect(white.positions[root].moves['e4'].card).toEqual(card);
            // Flat-map view also contains the card.
            expect(data.fsrsCards![cardKey]).toEqual(card);
            // Opponent move (1.e4 by white means e5 by black) has NO card.
            const afterE4 = (() => {
                const c = new Chess(); c.move('e4');
                return normalizeFenResetHalfmoveClock(c.fen());
            })();
            expect(white.positions[afterE4].moves['e5'].card).toBeUndefined();
        });

        it('is idempotent when `repertoires` is already present', () => {
            const data: RepertoireData = {
                repertoires: [
                    { name: 'White', orientation: 'white', positions: {} },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
            };
            RepertoireDataUtils.normalize(data);
            expect(data.repertoires).toHaveLength(2);
            expect(data.fsrsCards).toEqual({});
        });

        describe('FSRS audit seed', () => {
            it('seeds `audit` to an empty array when missing', () => {
                const data: RepertoireData = {
                    repertoires: [
                        { name: 'White', orientation: 'white', positions: {} },
                        { name: 'Black', orientation: 'black', positions: {} },
                    ],
                };
                RepertoireDataUtils.normalize(data);
                expect(data.audit).toEqual([]);
            });

            it('preserves an existing `audit` array verbatim (no clobber)', () => {
                const existing = [
                    {
                        k: 'fen::e4',
                        before: [1, 2, 3, 4, 5, 6, 7, 8, 2] as [number, number, number, number, number, number, number, number, number],
                        events: [{ ts: 1, r: 1, s: 'target' as const }],
                    },
                ];
                const data: RepertoireData = {
                    repertoires: [
                        { name: 'White', orientation: 'white', positions: {} },
                        { name: 'Black', orientation: 'black', positions: {} },
                    ],
                    audit: existing,
                };
                RepertoireDataUtils.normalize(data);
                // Same reference (not replaced) — AuditService relies on this
                expect(data.audit).toBe(existing);
                expect(data.audit).toEqual(existing);
            });
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
        it('emits `repertoires` and never includes `fsrsCards` on the wire', () => {
            const data: RepertoireData = {
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
            };
            RepertoireDataUtils.normalize(data);
            const blob = RepertoireDataUtils.prepareDataForSave(data);

            expect(blob.repertoires).toBeDefined();
            expect(blob.repertoires).toHaveLength(2);
            // The flat in-memory map is never written to the persisted blob.
            expect('fsrsCards' in blob).toBe(false);
        });

        it('projects in-memory fsrsCards back into the position dict', () => {
            const data: RepertoireData = {
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
            };
            RepertoireDataUtils.normalize(data);

            // Mutate a card on the flat map (simulating FSRSService.rateCard).
            const cardKey = FSRSService.makeCardKey(startFen(), 'e4');
            const fresh: FSRSCardData = { due: '2030-01-01T00:00:00.000Z', stability: 99, difficulty: 1, elapsedDays: 0, scheduledDays: 1, learningSteps: 0, reps: 1, lapses: 0, state: 1 };
            data.fsrsCards![cardKey] = fresh;

            const blob = RepertoireDataUtils.prepareDataForSave(data);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            expect(white.positions[startFen()].moves['e4'].card).toEqual(fresh);
        });

        it('preserves activity, games, and settings (incl. linkedAccounts)', () => {
            const data: RepertoireData = {
                repertoires: [
                    { name: 'White', orientation: 'white', positions: {} },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
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

        it('preserves inline cards when called on an un-normalized blob (importer regression)', () => {
            // Reproduces the import-wipes-cards bug: an imported file has
            // `repertoires` but no top-level `fsrsCards` — prepareDataForSave
            // must NOT delete the inline cards.
            const root = startFen();
            const reviewCard: FSRSCardData = { due: '2030-01-01T00:00:00.000Z', stability: 50, difficulty: 2, elapsedDays: 5, scheduledDays: 30, learningSteps: 0, reps: 10, lapses: 1, state: 2 };
            const importedBlob: RepertoireData = {
                repertoires: [
                    {
                        name: 'White', orientation: 'white',
                        positions: { [root]: { moves: { e4: { card: reviewCard } } } },
                    },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
            };

            const blob = RepertoireDataUtils.prepareDataForSave(importedBlob);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            expect(white.positions[root].moves['e4'].card).toEqual(reviewCard);
        });

        it('passes the `audit` array reference through to the save blob', () => {
            const auditArr = [
                {
                    k: 'fen::e4',
                    before: [1, 2, 3, 4, 5, 6, 7, 8, 2] as [number, number, number, number, number, number, number, number, number],
                    events: [{ ts: 100, r: 1, s: 'target' as const }],
                },
            ];
            const data: RepertoireData = {
                repertoires: [
                    { name: 'White', orientation: 'white', positions: {} },
                    { name: 'Black', orientation: 'black', positions: {} },
                ],
                audit: auditArr,
            };
            RepertoireDataUtils.normalize(data);
            const blob = RepertoireDataUtils.prepareDataForSave(data);
            // Same reference — the encoder later decides whether to ship it
            expect(blob.audit).toBe(auditArr);
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
                fsrsCards: {},
                settings: { contextDepth: 7, retention: 0.99, maxInterval: 30, linkedAccounts: [{ platform: 'lichess', username: 'someone' }] },
            };

            const blob = RepertoireDataUtils.prepareDataForSave(data);
            expect(blob.settings?.contextDepth).toBe(7);
            expect(blob.settings?.retention).toBe(0.99);
            expect(blob.settings?.maxInterval).toBe(30);
            expect(blob.settings?.linkedAccounts).toEqual([{ platform: 'lichess', username: 'someone' }]);
        });

        it('persists New-state cards synthesized by normalize for variants with no fsrsCards', () => {
            // PGN-derived repertoire with no pre-existing cards.
            // normalize() calls ensureCard for each user-turn edge — those
            // New-state cards must end up in the saved blob's repertoires dict,
            // not get dropped on the projection round-trip.
            const data: RepertoireData = {
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
            };
            RepertoireDataUtils.normalize(data);
            const blob = RepertoireDataUtils.prepareDataForSave(data);
            const white = blob.repertoires!.find(r => r.orientation === 'white')!;
            const root = startFen();
            expect(white.positions[root].moves['e4'].card).toBeDefined();
            // ensureCard creates cards in State.New (state: 0).
            expect(white.positions[root].moves['e4'].card!.state).toBe(0);
        });
    });

    describe('normalize — activity initialization', () => {
        it('initializes activity on data without it (no eager today entry)', () => {
            const data: RepertoireData = {
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
            };
            RepertoireDataUtils.normalize(data);
            expect(data.activity).toBeDefined();
            expect(data.activity!.practiceLog).toHaveLength(0);
        });

        it('strips blank entries during normalization', () => {
            const data: RepertoireData = {
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
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
                repertoires: pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]),
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
