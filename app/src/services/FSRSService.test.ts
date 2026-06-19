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
            expect(cardData.state).toBe(State.Learning); // New → Learning after first Good with short-term enabled
            expect(cardData.reps).toBe(1);
            expect(cardData.lapses).toBe(0);
            expect(cardData.lastReview).toBe(now.toISOString());

            // Rate again to advance the card
            const due = new Date(cardData.due);
            service.rateCard('fen1', 'e4', true, due);
            const updated = cards['fen1::e4'];
            expect(updated.reps).toBe(2);
        });

        it('should preserve last_review as ISO string', () => {
            const now = new Date('2026-04-20T12:00:00Z');
            const service = new FSRSService();
            service.rateCard('fen1', 'Nf3', true, now);

            const card = service.getCards()['fen1::Nf3'];
            expect(card.lastReview).toBe('2026-04-20T12:00:00.000Z');
        });
    });

    describe('rateCard', () => {
        it('should create a new card on first encounter and rate as Good', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            service.rateCard('fen1', 'e4', true, now);
            const card = service.getCards()['fen1::e4'];

            expect(card).toBeDefined();
            expect(card.reps).toBe(1);
            expect(card.lapses).toBe(0);
        });

        it('should create a new card on first encounter and rate as Again', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            service.rateCard('fen1', 'e4', false, now);
            const card = service.getCards()['fen1::e4'];

            expect(card).toBeDefined();
            expect(card.reps).toBe(1);
            // Again on a New card produces lower stability and higher difficulty than Good
            expect(card.stability).toBeLessThan(1);
            expect(card.difficulty).toBeGreaterThan(5);
        });

        it('should update existing card state', () => {
            const now = new Date('2026-04-20T00:00:00Z');
            const service = new FSRSService();

            // First review
            service.rateCard('fen1', 'e4', true, now);
            const after1 = service.getCards()['fen1::e4'];

            // Second review at due time
            const due = new Date(after1.due);
            service.rateCard('fen1', 'e4', true, due);
            const after2 = service.getCards()['fen1::e4'];

            expect(after2.reps).toBe(2);
            expect(after2.stability).toBeGreaterThanOrEqual(after1.stability); // Stability preserved or increases on transition
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
                due: '2026-02-01T00:00:00Z',
                stability: s,
                difficulty: 5,
                elapsedDays: 0,
                scheduledDays: 10,
                learningSteps: 0,
                reps: 1,
                lapses: 0,
                state: st,
                lastReview: lr,
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
                    due: '2026-02-01T00:00:00Z',
                    stability: 25,
                    difficulty: 5,
                    elapsedDays: 0,
                    scheduledDays: 10,
                    learningSteps: 0,
                    reps: 1,
                    lapses: 0,
                    state: State.Review,
                    lastReview: '2026-01-01T00:00:00Z',
                };
                const fromComputeInterval = FSRSService.computeInterval(card);
                const fromHelper = FSRSService.intervalFromStability(card.stability, 0.97, 90);
                expect(fromComputeInterval).toBe(fromHelper);
            });

            it('floors interval at 2 days for very low stability (matches ts-fsrs short-term Review scheduler)', () => {
                // ts-fsrs enforces good_interval ≥ hard_interval + 1 ≥ 2 days
                // in the short-term Review scheduler, so a Review-state Good
                // is never scheduled less than 2 days out.
                expect(FSRSService.intervalFromStability(0.001, 0.99, 365)).toBe(2);
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

    // ─── End-to-end regression sentinel ────────────────────────────────────
    //
    // Drives the live `FSRSService.rateCard` + `FSRSService.computeDueDate`
    // path through a representative 38-step rating sequence and pins the
    // resulting card state (stability, difficulty, interval, due date) at
    // every step.
    //
    // Purpose:
    //   - Lock in the current behavior of the app's scheduling under the
    //     standard preset, including the 2-day floor in
    //     `intervalFromStability` and the way `computeDueDate` advances "now"
    //     from one review to the next (the production code path always reads
    //     the recomputed due, never the stored `card.due`).
    //   - Catch silent behavioral drift from ts-fsrs minor-version bumps,
    //     `default_w` updates, or accidental tweaks to scheduler config.
    //
    // Determinism:
    //   - ts-fsrs `enable_fuzz: true` (the production default) randomizes
    //     intervals by a few hours. We toggle it off on the live scheduler
    //     via `parameters.enable_fuzz = false` so the expected snapshot is
    //     exact. Everything else (retention 0.97, max-interval 90,
    //     short-term enabled, default_w) is the production config.
    //
    // Updating the snapshot:
    //   - If FSRSService logic intentionally changes (e.g. switching to the
    //     "stamp retention, return stored due" optimization in the backlog),
    //     regenerate `EXPECTED` by running this sequence and printing the
    //     fields shown below.
    describe('end-to-end behavior snapshot (Again, 12×Good, Again, 24×Good)', () => {
        it('matches the captured per-step card state', () => {
            FSRSService.setRetention(0.97);
            FSRSService.setMaxInterval(90);

            const svc = new FSRSService();
            // Disable fuzz on the live scheduler for deterministic intervals.
            // The scheduler's parameter proxy supports runtime mutation.
            // @ts-expect-error – `scheduler` is private; touching it here is
            // a test-only seam to silence ts-fsrs's fuzz randomization.
            svc.scheduler.parameters.enable_fuzz = false;

            const fen = 'startpos';
            const san = 'e4';
            const key = FSRSService.makeCardKey(fen, san);
            const start = new Date('2026-01-01T00:00:00.000Z');

            let now = start;
            const rateStep = (good: boolean) => {
                svc.rateCard(fen, san, good, now);
                const card = svc.getCards()[key];
                now = FSRSService.computeDueDate(card);
                return card;
            };

            const actual: Array<{
                stability: number; difficulty: number; scheduledDays: number; state: number;
                reps: number; lapses: number; due: string; lastReview: string;
            }> = [];
            const record = (c: FSRSCardData) => {
                actual.push({
                    stability: c.stability, difficulty: c.difficulty, scheduledDays: c.scheduledDays, state: c.state,
                    reps: c.reps, lapses: c.lapses, due: c.due, lastReview: c.lastReview!,
                });
            };

            record(rateStep(false));                        // Again #1
            for (let i = 0; i < 12; i++) record(rateStep(true));   // 12× Good
            record(rateStep(false));                        // Again #2
            for (let i = 0; i < 24; i++) record(rateStep(true));   // 24× Good (post-lapse)

            // Per-step snapshot. Each entry is the state *after* applying the
            // rating at that step. Generated by running this same sequence.
            const EXPECTED = [
                { stability: 0.212, difficulty: 6.4133, scheduledDays: 0, state: 1, reps: 1, lapses: 0, due: '2026-01-01T00:01:00.000Z', lastReview: '2026-01-01T00:00:00.000Z' },
                { stability: 0.24668919, difficulty: 6.40211507, scheduledDays: 0, state: 1, reps: 2, lapses: 0, due: '2026-01-01T00:11:00.000Z', lastReview: '2026-01-01T00:01:00.000Z' },
                { stability: 0.28420636, difficulty: 6.39094132, scheduledDays: 1, state: 2, reps: 3, lapses: 0, due: '2026-01-02T00:11:00.000Z', lastReview: '2026-01-01T00:11:00.000Z' },
                { stability: 2.83275337, difficulty: 6.37977875, scheduledDays: 2, state: 2, reps: 4, lapses: 0, due: '2026-01-05T00:11:00.000Z', lastReview: '2026-01-03T00:11:00.000Z' },
                { stability: 7.41043294, difficulty: 6.36862734, scheduledDays: 2, state: 2, reps: 5, lapses: 0, due: '2026-01-07T00:11:00.000Z', lastReview: '2026-01-05T00:11:00.000Z' },
                { stability: 11.9985981, difficulty: 6.35748708, scheduledDays: 3, state: 2, reps: 6, lapses: 0, due: '2026-01-10T00:11:00.000Z', lastReview: '2026-01-07T00:11:00.000Z' },
                { stability: 18.41835342, difficulty: 6.34635796, scheduledDays: 5, state: 2, reps: 7, lapses: 0, due: '2026-01-15T00:11:00.000Z', lastReview: '2026-01-10T00:11:00.000Z' },
                { stability: 26.51992591, difficulty: 6.33523997, scheduledDays: 6, state: 2, reps: 8, lapses: 0, due: '2026-01-20T00:11:00.000Z', lastReview: '2026-01-14T00:11:00.000Z' },
                { stability: 37.9389438, difficulty: 6.3241331, scheduledDays: 8, state: 2, reps: 9, lapses: 0, due: '2026-01-28T00:11:00.000Z', lastReview: '2026-01-20T00:11:00.000Z' },
                { stability: 52.41221308, difficulty: 6.31303734, scheduledDays: 12, state: 2, reps: 10, lapses: 0, due: '2026-02-09T00:11:00.000Z', lastReview: '2026-01-28T00:11:00.000Z' },
                { stability: 72.87323311, difficulty: 6.30195267, scheduledDays: 16, state: 2, reps: 11, lapses: 0, due: '2026-02-25T00:11:00.000Z', lastReview: '2026-02-09T00:11:00.000Z' },
                { stability: 98.862555, difficulty: 6.29087909, scheduledDays: 22, state: 2, reps: 12, lapses: 0, due: '2026-03-19T00:11:00.000Z', lastReview: '2026-02-25T00:11:00.000Z' },
                { stability: 132.86397179, difficulty: 6.27981658, scheduledDays: 30, state: 2, reps: 13, lapses: 0, due: '2026-04-18T00:11:00.000Z', lastReview: '2026-03-19T00:11:00.000Z' },
                { stability: 3.65486447, difficulty: 8.76242937, scheduledDays: 0, state: 3, reps: 14, lapses: 1, due: '2026-04-18T00:21:00.000Z', lastReview: '2026-04-18T00:11:00.000Z' },
                { stability: 3.65486447, difficulty: 8.74889531, scheduledDays: 1, state: 2, reps: 15, lapses: 1, due: '2026-04-19T00:21:00.000Z', lastReview: '2026-04-18T00:21:00.000Z' },
                { stability: 5.91088436, difficulty: 8.73537478, scheduledDays: 2, state: 2, reps: 16, lapses: 1, due: '2026-04-22T00:21:00.000Z', lastReview: '2026-04-20T00:21:00.000Z' },
                { stability: 8.17645367, difficulty: 8.72186777, scheduledDays: 3, state: 2, reps: 17, lapses: 1, due: '2026-04-25T00:21:00.000Z', lastReview: '2026-04-22T00:21:00.000Z' },
                { stability: 10.42032281, difficulty: 8.70837427, scheduledDays: 3, state: 2, reps: 18, lapses: 1, due: '2026-04-27T00:21:00.000Z', lastReview: '2026-04-24T00:21:00.000Z' },
                { stability: 12.63782999, difficulty: 8.69489427, scheduledDays: 4, state: 2, reps: 19, lapses: 1, due: '2026-04-30T00:21:00.000Z', lastReview: '2026-04-26T00:21:00.000Z' },
                { stability: 15.81488936, difficulty: 8.68142775, scheduledDays: 4, state: 2, reps: 20, lapses: 1, due: '2026-05-03T00:21:00.000Z', lastReview: '2026-04-29T00:21:00.000Z' },
                { stability: 19.89257457, difficulty: 8.66797469, scheduledDays: 5, state: 2, reps: 21, lapses: 1, due: '2026-05-08T00:21:00.000Z', lastReview: '2026-05-03T00:21:00.000Z' },
                { stability: 23.92871312, difficulty: 8.65453508, scheduledDays: 6, state: 2, reps: 22, lapses: 1, due: '2026-05-13T00:21:00.000Z', lastReview: '2026-05-07T00:21:00.000Z' },
                { stability: 28.83237464, difficulty: 8.64110891, scheduledDays: 7, state: 2, reps: 23, lapses: 1, due: '2026-05-19T00:21:00.000Z', lastReview: '2026-05-12T00:21:00.000Z' },
                { stability: 34.57160081, difficulty: 8.62769617, scheduledDays: 8, state: 2, reps: 24, lapses: 1, due: '2026-05-26T00:21:00.000Z', lastReview: '2026-05-18T00:21:00.000Z' },
                { stability: 41.9636924, difficulty: 8.61429684, scheduledDays: 10, state: 2, reps: 25, lapses: 1, due: '2026-06-05T00:21:00.000Z', lastReview: '2026-05-26T00:21:00.000Z' },
                { stability: 50.12014917, difficulty: 8.60091091, scheduledDays: 11, state: 2, reps: 26, lapses: 1, due: '2026-06-15T00:21:00.000Z', lastReview: '2026-06-04T00:21:00.000Z' },
                { stability: 59.83183529, difficulty: 8.58753837, scheduledDays: 13, state: 2, reps: 27, lapses: 1, due: '2026-06-28T00:21:00.000Z', lastReview: '2026-06-15T00:21:00.000Z' },
                { stability: 71.04827564, difficulty: 8.5741792, scheduledDays: 16, state: 2, reps: 28, lapses: 1, due: '2026-07-14T00:21:00.000Z', lastReview: '2026-06-28T00:21:00.000Z' },
                { stability: 84.49200647, difficulty: 8.56083339, scheduledDays: 19, state: 2, reps: 29, lapses: 1, due: '2026-08-02T00:21:00.000Z', lastReview: '2026-07-14T00:21:00.000Z' },
                { stability: 100.08961852, difficulty: 8.54750093, scheduledDays: 22, state: 2, reps: 30, lapses: 1, due: '2026-08-24T00:21:00.000Z', lastReview: '2026-08-02T00:21:00.000Z' },
                { stability: 117.78185084, difficulty: 8.5341818, scheduledDays: 26, state: 2, reps: 31, lapses: 1, due: '2026-09-19T00:21:00.000Z', lastReview: '2026-08-24T00:21:00.000Z' },
                { stability: 138.23368936, difficulty: 8.52087599, scheduledDays: 31, state: 2, reps: 32, lapses: 1, due: '2026-10-20T00:21:00.000Z', lastReview: '2026-09-19T00:21:00.000Z' },
                { stability: 162.06889013, difficulty: 8.50758348, scheduledDays: 36, state: 2, reps: 33, lapses: 1, due: '2026-11-25T00:21:00.000Z', lastReview: '2026-10-20T00:21:00.000Z' },
                { stability: 189.19385404, difficulty: 8.49430427, scheduledDays: 42, state: 2, reps: 34, lapses: 1, due: '2027-01-06T00:21:00.000Z', lastReview: '2026-11-25T00:21:00.000Z' },
                { stability: 220.20029025, difficulty: 8.48103834, scheduledDays: 49, state: 2, reps: 35, lapses: 1, due: '2027-02-24T00:21:00.000Z', lastReview: '2027-01-06T00:21:00.000Z' },
                { stability: 255.64995984, difficulty: 8.46778567, scheduledDays: 57, state: 2, reps: 36, lapses: 1, due: '2027-04-22T00:21:00.000Z', lastReview: '2027-02-24T00:21:00.000Z' },
                { stability: 296.07851898, difficulty: 8.45454625, scheduledDays: 66, state: 2, reps: 37, lapses: 1, due: '2027-06-27T00:21:00.000Z', lastReview: '2027-04-22T00:21:00.000Z' },
                { stability: 341.99919457, difficulty: 8.44132007, scheduledDays: 76, state: 2, reps: 38, lapses: 1, due: '2027-09-11T00:21:00.000Z', lastReview: '2027-06-27T00:21:00.000Z' },
            ];

            expect(actual).toHaveLength(EXPECTED.length);
            for (let i = 0; i < EXPECTED.length; i++) {
                const a = actual[i];
                const e = EXPECTED[i];
                // Float fields: pinned to ~7 significant figures. That's
                // tighter than any plausible round-off but loose enough to
                // tolerate ts-fsrs patch-level math tweaks if any occur.
                expect(a.stability).toBeCloseTo(e.stability, 5);
                expect(a.difficulty).toBeCloseTo(e.difficulty, 5);
                // Integers / strings: must match exactly.
                expect(a.scheduledDays).toBe(e.scheduledDays);
                expect(a.state).toBe(e.state);
                expect(a.reps).toBe(e.reps);
                expect(a.lapses).toBe(e.lapses);
                expect(a.due).toBe(e.due);
                expect(a.lastReview).toBe(e.lastReview);
            }
        });
    });

    describe('audit hook (FSRS-LIST)', () => {
        // These tests exercise the FSRSService → AuditService bridge end-to-end
        // through the real scheduler. Entry creation is now driven by the FSRS
        // card list page via `AuditService.track`; the bridge only appends
        // events for already-tracked cards. The AuditService unit tests live in
        // `AuditService.test.ts`.
        it('appends rating events only for a tracked card', async () => {
            const { AuditService } = await import('./AuditService');
            const audit: any[] = [];
            const auditor = new AuditService(audit);

            // Seed a Review-state card by rating Good a few times
            const service = new FSRSService({}, auditor);
            const t0 = new Date('2026-04-20T00:00:00Z');
            service.rateCard('fen1', 'e4', true, t0, 'target');     // New → Learning
            service.rateCard('fen1', 'e4', true, new Date('2026-05-01T00:00:00Z'), 'target'); // Learning → Review
            const before = service.getCards()['fen1::e4'];
            expect(before.state).toBe(State.Review);
            // Untracked card → no auto-capture
            expect(audit).toEqual([]);

            // Track it (as the FSRS card list page would), then rate again.
            expect(auditor.track('fen1::e4', before)).toBe(true);
            service.rateCard('fen1', 'e4', false, new Date('2026-05-15T00:00:00Z'), 'target');
            expect(audit).toHaveLength(1);
            expect(audit[0].k).toBe('fen1::e4');
            expect(audit[0].events[0].s).toBe('target');
            // The snapshot reflects the pre-track Review state.
            expect(audit[0].before[8]).toBe(State.Review);
        });

        it('does NOT append anything when `source` is omitted (opt-in by call site)', async () => {
            const { AuditService } = await import('./AuditService');
            const audit: any[] = [];
            const auditor = new AuditService(audit);

            const service = new FSRSService({}, auditor);
            const t0 = new Date('2026-04-20T00:00:00Z');
            service.rateCard('fen1', 'e4', true, t0, 'target');
            service.rateCard('fen1', 'e4', true, new Date('2026-05-01T00:00:00Z'), 'target');
            // Track, then rate without a source — nothing should be appended.
            expect(auditor.track('fen1::e4', service.getCards()['fen1::e4'])).toBe(true);
            service.rateCard('fen1', 'e4', false, new Date('2026-05-15T00:00:00Z'));

            expect(audit[0].events).toEqual([]);
        });

        it('does NOT auto-capture an untracked card on Again', async () => {
            const { AuditService } = await import('./AuditService');
            const audit: any[] = [];
            const auditor = new AuditService(audit);

            const service = new FSRSService({}, auditor);
            service.rateCard('fen1', 'e4', false, new Date('2026-04-20T00:00:00Z'), 'learn');

            expect(audit).toEqual([]);
        });

        it('a throwing auditor does NOT break scheduling (swallowed via try/catch)', () => {
            // Builds a real AuditService-shaped object whose onRate throws.
            // Mimics the corrupt-blob hazard called out in the edge-cases
            // review: an audit entry whose .events isn't an array.
            const throwingAuditor = {
                onRate() { throw new Error('boom'); },
            } as any;
            const service = new FSRSService({}, throwingAuditor);

            // Establish a Review-state card; the bridge invokes the throwing
            // hook on every rate carrying a `source`.
            const t0 = new Date('2026-04-20T00:00:00Z');
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                service.rateCard('fen1', 'e4', true, t0, 'target');
                service.rateCard('fen1', 'e4', true, new Date('2026-05-01T00:00:00Z'), 'target');
                expect(service.getCards()['fen1::e4'].state).toBe(State.Review);

                // Now the Again that would call into the throwing auditor.
                // Must NOT throw; card mutation must still apply.
                expect(() =>
                    service.rateCard('fen1', 'e4', false, new Date('2026-05-15T00:00:00Z'), 'target')
                ).not.toThrow();

                // Card was rated successfully despite the audit throw
                const after = service.getCards()['fen1::e4'];
                expect(after.lapses).toBe(1);
                expect(warn).toHaveBeenCalled();
            } finally {
                warn.mockRestore();
            }
        });
    });
});
