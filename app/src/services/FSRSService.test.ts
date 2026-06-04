import { FSRSService, RETENTION_PRESETS, DEFAULT_RETENTION_PRESET } from './FSRSService';
import { FSRSCardData } from '../models/FSRSCardData';
import { fsrs, State } from 'ts-fsrs';

describe('FSRSService', () => {

    describe('makeCardKey', () => {
        it('should join FEN and SAN with :: separator', () => {
            const key = FSRSService.makeCardKey(
                'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                'e5'
            );
            expect(key).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1::e5');
        });
    });

    describe('serialize / hydrate round-trip', () => {
        it('should produce identical card after serialize then hydrate via rateCard', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            // Rate a new card as Good
            service.rateCard('fen1', 'e4', true, now);
            const cards = service.getCards();
            const cardData = cards['fen1::e4'];

            expect(cardData).toBeDefined();
            expect(cardData.st).toBe(State.Learning); // New → Learning after first Good with short-term enabled
            expect(cardData.r).toBe(1);
            expect(cardData.l).toBe(0);
            expect(cardData.lr).toBe(now.toISOString());

            // Rate again to advance the card
            const due = new Date(cardData.d);
            service.rateCard('fen1', 'e4', true, due);
            const updated = cards['fen1::e4'];
            expect(updated.r).toBe(2);
        });

        it('should preserve last_review as ISO string', () => {
            const now = new Date('2026-04-20T12:00:00Z');
            const service = new FSRSService();
            service.rateCard('fen1', 'Nf3', true, now);

            const card = service.getCards()['fen1::Nf3'];
            expect(card.lr).toBe('2026-04-20T12:00:00.000Z');
        });
    });

    describe('rateCard', () => {
        it('should create a new card on first encounter and rate as Good', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            service.rateCard('fen1', 'e4', true, now);
            const card = service.getCards()['fen1::e4'];

            expect(card).toBeDefined();
            expect(card.r).toBe(1);
            expect(card.l).toBe(0);
        });

        it('should create a new card on first encounter and rate as Again', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            service.rateCard('fen1', 'e4', false, now);
            const card = service.getCards()['fen1::e4'];

            expect(card).toBeDefined();
            expect(card.r).toBe(1);
            // Again on a New card produces lower stability and higher difficulty than Good
            expect(card.s).toBeLessThan(1);
            expect(card.di).toBeGreaterThan(5);
        });

        it('should update existing card state', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            // First review
            service.rateCard('fen1', 'e4', true, now);
            const after1 = service.getCards()['fen1::e4'];

            // Second review at due time
            const due = new Date(after1.d);
            service.rateCard('fen1', 'e4', true, due);
            const after2 = service.getCards()['fen1::e4'];

            expect(after2.r).toBe(2);
            expect(after2.s).toBeGreaterThanOrEqual(after1.s); // Stability preserved or increases on transition
        });

        it('should mutate the shared cards map in-place', () => {
            const sharedCards: Record<string, FSRSCardData> = {};
            const service = new FSRSService(sharedCards);

            service.rateCard('fen1', 'e4', true, new Date());

            // The shared map should have the card
            expect(sharedCards['fen1::e4']).toBeDefined();
        });
    });

    describe('Retention presets', () => {
        afterEach(() => {
            // Reset to default preset to avoid leaking state between tests.
            const def = RETENTION_PRESETS.find(p => p.id === DEFAULT_RETENTION_PRESET)!;
            FSRSService.setRetention(def.retention);
            FSRSService.setMaxInterval(def.maxInterval);
        });

        it('exposes five ordered presets (Casual → Tournament)', () => {
            expect(RETENTION_PRESETS.map(p => p.id)).toEqual([
                'casual', 'light', 'standard', 'sharp', 'tournament'
            ]);
            expect(RETENTION_PRESETS.map(p => p.retention)).toEqual([0.95, 0.96, 0.97, 0.98, 0.99]);
            // maxInterval should monotonically decrease as intensity rises.
            for (let i = 1; i < RETENTION_PRESETS.length; i++) {
                expect(RETENTION_PRESETS[i].maxInterval).toBeLessThan(RETENTION_PRESETS[i - 1].maxInterval);
            }
        });

        it('Standard is the default preset and matches historical defaults (0.97, 90d)', () => {
            expect(DEFAULT_RETENTION_PRESET).toBe('standard');
            const cfg = FSRSService.getPresetConfig('standard');
            expect(cfg.retention).toBe(0.97);
            expect(cfg.maxInterval).toBe(90);
        });

        describe('getPresetForRetention', () => {
            it('returns exact preset for the canonical values', () => {
                expect(FSRSService.getPresetForRetention(0.95)).toBe('casual');
                expect(FSRSService.getPresetForRetention(0.96)).toBe('light');
                expect(FSRSService.getPresetForRetention(0.97)).toBe('standard');
                expect(FSRSService.getPresetForRetention(0.98)).toBe('sharp');
                expect(FSRSService.getPresetForRetention(0.99)).toBe('tournament');
            });

            it('snaps in-between values to nearest preset', () => {
                expect(FSRSService.getPresetForRetention(0.944)).toBe('casual');
                expect(FSRSService.getPresetForRetention(0.965)).toBe('light');
                expect(FSRSService.getPresetForRetention(0.974)).toBe('standard');
                expect(FSRSService.getPresetForRetention(0.985)).toBe('sharp');
                expect(FSRSService.getPresetForRetention(0.992)).toBe('tournament');
            });

            it('maps legacy low retentions to Casual (lowest preset)', () => {
                expect(FSRSService.getPresetForRetention(0.85)).toBe('casual');
                expect(FSRSService.getPresetForRetention(0.80)).toBe('casual');
                expect(FSRSService.getPresetForRetention(0.50)).toBe('casual');
            });

            it('caps retentions above the highest preset to Tournament', () => {
                expect(FSRSService.getPresetForRetention(0.999)).toBe('tournament');
                expect(FSRSService.getPresetForRetention(1.0)).toBe('tournament');
            });

            it('ties break to the lower-intensity preset', () => {
                // exactly halfway between Casual (0.95) and Light (0.96)
                expect(FSRSService.getPresetForRetention(0.955)).toBe('casual');
                // exactly halfway between Standard (0.97) and Sharp (0.98)
                expect(FSRSService.getPresetForRetention(0.975)).toBe('standard');
            });
        });

        describe('estimateDailyLoad', () => {
            const makeCard = (s: number, st: State = State.Review, lr: string | undefined = '2026-01-01T00:00:00Z'): FSRSCardData => ({
                d: '2026-02-01T00:00:00Z',
                s,
                di: 5,
                e: 0,
                sd: 10,
                ls: 0,
                r: 1,
                l: 0,
                st,
                lr,
            });

            it('returns zero for an empty deck', () => {
                const result = FSRSService.estimateDailyLoad({}, 0.97, 90);
                expect(result.reviewsPerDay).toBe(0);
                expect(result.mistakesPerDay).toBe(0);
            });

            it('counts only Review-state cards with positive stability', () => {
                const cards: Record<string, FSRSCardData> = {
                    a: makeCard(10, State.Review),
                    b: makeCard(10, State.Learning),
                    c: makeCard(10, State.Relearning),
                    d: makeCard(10, State.New),
                    e: makeCard(0, State.Review),
                    f: makeCard(-1, State.Review),
                };
                const result = FSRSService.estimateDailyLoad(cards, 0.97, 90);
                // Only card 'a' contributes; daily contribution = 1/interval(10, 0.97, 90).
                const expectedInterval = FSRSService.intervalFromStability(10, 0.97, 90);
                expect(result.reviewsPerDay).toBeCloseTo(1 / expectedInterval, 10);
            });

            it('mistakesPerDay = reviewsPerDay × (1 − R)', () => {
                const cards: Record<string, FSRSCardData> = {
                    a: makeCard(50),
                    b: makeCard(20),
                    c: makeCard(100),
                };
                for (const R of [0.95, 0.97, 0.99]) {
                    const result = FSRSService.estimateDailyLoad(cards, R, 90);
                    expect(result.mistakesPerDay).toBeCloseTo(result.reviewsPerDay * (1 - R), 10);
                }
            });

            it('respects the maxInterval cap (shorter cap → more reviews)', () => {
                const cards: Record<string, FSRSCardData> = {
                    a: makeCard(200),
                    b: makeCard(300),
                };
                const loose = FSRSService.estimateDailyLoad(cards, 0.95, 180);
                const tight = FSRSService.estimateDailyLoad(cards, 0.95, 30);
                expect(tight.reviewsPerDay).toBeGreaterThan(loose.reviewsPerDay);
            });

            it('higher retention produces more daily reviews', () => {
                const cards: Record<string, FSRSCardData> = {
                    a: makeCard(50),
                    b: makeCard(20),
                    c: makeCard(100),
                };
                const casual = FSRSService.estimateDailyLoad(cards, 0.95, 180);
                const tournament = FSRSService.estimateDailyLoad(cards, 0.99, 30);
                expect(tournament.reviewsPerDay).toBeGreaterThan(casual.reviewsPerDay);
            });
        });

        describe('intervalFromStability', () => {
            it('matches computeInterval for Review-state cards under the global settings', () => {
                FSRSService.setRetention(0.97);
                FSRSService.setMaxInterval(90);
                const card: FSRSCardData = {
                    d: '2026-02-01T00:00:00Z',
                    s: 25,
                    di: 5,
                    e: 0,
                    sd: 10,
                    ls: 0,
                    r: 1,
                    l: 0,
                    st: State.Review,
                    lr: '2026-01-01T00:00:00Z',
                };
                const fromComputeInterval = FSRSService.computeInterval(card);
                const fromHelper = FSRSService.intervalFromStability(card.s, 0.97, 90);
                expect(fromComputeInterval).toBe(fromHelper);
            });

            it('floors interval at 1 day for very low stability', () => {
                expect(FSRSService.intervalFromStability(0.001, 0.99, 365)).toBe(1);
            });

            it('caps interval at maxInterval for very high stability', () => {
                expect(FSRSService.intervalFromStability(10000, 0.95, 21)).toBe(21);
            });

            // ── Decay/forgetting-curve consistency ──────────────────────────
            //
            // Regression guard for the FSRS-5/FSRS-6 decay mismatch we hit in
            // June 2026. The contract of FSRS is: an interval is the time for
            // retrievability to drop from 1.0 to the request_retention. If
            // `intervalFromStability` and the scheduler's forgetting curve use
            // different decay constants, `dueAt` and `getRetrievability` drift
            // apart — a card can read "due in 3d" while R has already fallen
            // below target, producing a contradictory "Due · due in 3d" pill.
            //
            // The invariant: at exactly `lastReview + intervalFromStability(s, R, …)`
            // days, the scheduler's R(t) must equal the request_retention up
            // to small rounding noise. Under the bug R landed ~0.004–0.006
            // below target across realistic stability/retention ranges, well
            // outside the integer-day rounding noise (~0.0003) that remains
            // under the fix.
            it.each([
                { stability: 50,  target: 0.95 },
                { stability: 200, target: 0.95 },
                { stability: 100, target: 0.97 },
                { stability: 94,  target: 0.98 },
                { stability: 200, target: 0.98 },
            ])(
                'intervalFromStability lands on the target retention at the computed dueAt (s=$stability, R=$target)',
                ({ stability, target }) => {
                    const lr = new Date('2026-01-01T00:00:00Z');
                    const maxInterval = 365;

                    const intervalDays = FSRSService.intervalFromStability(stability, target, maxInterval);
                    const dueAt = new Date(lr.getTime() + intervalDays * 24 * 60 * 60 * 1000);

                    // Build a scheduler that mirrors the one FSRSService uses, then
                    // ask it for R at the dueAt we just computed.
                    const scheduler = fsrs({
                        request_retention: target,
                        maximum_interval: maxInterval,
                        enable_fuzz: true,
                        enable_short_term: true,
                    });
                    const card = {
                        due: dueAt,
                        stability,
                        difficulty: 5,
                        elapsed_days: intervalDays,
                        scheduled_days: intervalDays,
                        learning_steps: 0,
                        reps: 1,
                        lapses: 0,
                        state: State.Review,
                        last_review: lr,
                    };
                    const R = scheduler.get_retrievability(card, dueAt, false) as number;

                    // Tolerance covers integer-day rounding (~0.0003). The bug
                    // produced ~0.004–0.006 of drift, so ±0.002 cleanly catches
                    // any decay-constant mismatch while accepting normal noise.
                    expect(Math.abs(R - target)).toBeLessThan(0.002);
                },
            );
        });
    });
});
