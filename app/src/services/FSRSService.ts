import { createEmptyCard, fsrs, Rating, State, FSRS, Card, computeDecayFactor, default_w } from 'ts-fsrs';
import { FSRSCardData } from '../models/FSRSCardData';

// Decay/factor for our standalone interval math (`intervalFromStability`,
// `computeInterval`). These MUST stay in lockstep with the decay the scheduler
// uses for its forgetting curve — otherwise `dueAt` and `getRetrievability`
// disagree about when R crosses the retention target.
//
// The ts-fsrs scheduler binds its forgetting curve to `param.w[20]` (the
// per-user-learnable decay weight in FSRS-6). We don't customize `w` anywhere
// in this codebase, so the scheduler always uses the library's `default_w`,
// and we derive DECAY/FACTOR from the same source. `computeDecayFactor` reads
// `decayOrParams[20]` when given an array, so this is exactly the same
// computation the scheduler runs internally.
//
// If we ever start tuning `w` per user, the scheduler will need to be
// reconstructed with the new weights AND DECAY/FACTOR will need to be
// recomputed from those weights at the same time.
const { decay: DECAY, factor: FACTOR } = computeDecayFactor(default_w);

export type RetentionPreset = 'casual' | 'light' | 'standard' | 'sharp' | 'tournament';

export interface RetentionPresetConfig {
    id: RetentionPreset;
    label: string;
    retention: number;
    maxInterval: number;
}

// Ordered low→high intensity. Each preset controls BOTH retention and maxInterval.
// The Settings UI exposes only the preset; retention/maxInterval are derived from it.
export const RETENTION_PRESETS: readonly RetentionPresetConfig[] = [
    { id: 'casual',     label: 'Casual',     retention: 0.95, maxInterval: 180 },
    { id: 'light',      label: 'Light',      retention: 0.96, maxInterval: 120 },
    { id: 'standard',   label: 'Standard',   retention: 0.97, maxInterval: 90  },
    { id: 'sharp',      label: 'Sharp',      retention: 0.98, maxInterval: 45  },
    { id: 'tournament', label: 'Tournament', retention: 0.99, maxInterval: 30  },
] as const;

export const DEFAULT_RETENTION_PRESET: RetentionPreset = 'standard';

const DEFAULT_PRESET_CONFIG = RETENTION_PRESETS.find(p => p.id === DEFAULT_RETENTION_PRESET)!;
const DEFAULT_RETENTION = DEFAULT_PRESET_CONFIG.retention;
const DEFAULT_MAX_INTERVAL = DEFAULT_PRESET_CONFIG.maxInterval;

let _retention: number = DEFAULT_RETENTION;
let _maxInterval: number = DEFAULT_MAX_INTERVAL;

export class FSRSService {
    private scheduler: FSRS;
    private cards: Record<string, FSRSCardData>;

    constructor(cards: Record<string, FSRSCardData> = {}) {
        this.scheduler = fsrs({
            request_retention: FSRSService.getRetention(),
            maximum_interval: FSRSService.getMaxInterval(),
            enable_fuzz: true,
            enable_short_term: true
        });
        this.cards = cards;
    }

    static makeCardKey(normalizedFen: string, moveSan: string): string {
        return `${normalizedFen}::${moveSan}`;
    }

    static parseCardKey(key: string): { fen: string; san: string } {
        const idx = key.indexOf('::');
        return { fen: key.substring(0, idx), san: key.substring(idx + 2) };
    }

    rateCard(normalizedFen: string, moveSan: string, correct: boolean, now: Date): void {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);

        let card: Card;
        const existing = this.cards[key];
        if (existing) {
            card = this.hydrate(existing);
        } else {
            card = createEmptyCard(now);
        }

        const rating = correct ? Rating.Good : Rating.Again;
        const result = this.scheduler.next(card, now, rating);
        this.cards[key] = FSRSService.serialize(result.card);
    }

    rateCardByKey(key: string, correct: boolean, now: Date): void {
        const { fen, san } = FSRSService.parseCardKey(key);
        this.rateCard(fen, san, correct, now);
    }

    getCards(): Record<string, FSRSCardData> {
        return this.cards;
    }

    getRetrievability(normalizedFen: string, moveSan: string, now: Date): number | null {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);
        return this.getRetrievabilityByKey(key, now);
    }

    getRetrievabilityByKey(key: string, now: Date): number | null {
        const cardData = this.cards[key];
        if (!cardData || cardData.state !== State.Review) return null;
        const card = this.hydrate(cardData);
        return this.scheduler.get_retrievability(card, now, false);
    }

    // ─── v2 additions ──────────────────────────────────────────────────

    /**
     * Check if a card is due for review (exists and due date <= now).
     * Cards in New state are considered "due" for queue purposes.
     */
    isDue(key: string, now: Date): boolean {
        const cardData = this.cards[key];
        if (!cardData) return false;
        if (cardData.state === State.New) return true;
        const due = FSRSService.computeDueDate(cardData);
        return now >= due;
    }

    /**
     * Returns the FSRS state for a card, or undefined if no card exists.
     */
    getState(key: string): State | undefined {
        const cardData = this.cards[key];
        return cardData?.state as State | undefined;
    }

    /**
     * Create a new card in New state (for card reconciliation).
     * Does nothing if the card already exists.
     */
    ensureCard(key: string): void {
        if (this.cards[key]) return;
        const card = createEmptyCard();
        this.cards[key] = FSRSService.serialize(card);
    }

    /**
     * Delete a card (for card reconciliation when positions are removed).
     */
    deleteCard(key: string): void {
        delete this.cards[key];
    }

    /**
     * Returns all card keys in the store.
     */
    getAllCardKeys(): string[] {
        return Object.keys(this.cards);
    }

    /**
     * Compute overdueness for sorting the review queue.
     * Higher = more overdue = higher priority.
     * For due Review cards: (now - due) / scheduled_days.
     * For Learning/Relearning: days past due.
     * For New: 0.
     */
    getOverdueness(key: string, now: Date): number {
        const cardData = this.cards[key];
        if (!cardData) return 0;
        if (cardData.state === State.New) return 0;

        const due = FSRSService.computeDueDate(cardData);
        const msPastDue = now.getTime() - due.getTime();
        if (msPastDue <= 0) return 0;

        const daysPastDue = msPastDue / (1000 * 60 * 60 * 24);
        if (cardData.state === State.Review && cardData.scheduledDays > 0) {
            const scheduledDays = FSRSService.computeInterval(cardData) ?? cardData.scheduledDays;
            return daysPastDue / scheduledDays;
        }
        return daysPastDue;
    }

    /**
     * Returns cards with the lowest retrievability (for ahead-of-schedule mode).
     * Only includes Review-state cards that are NOT yet due.
     */
    getWeakestCards(keys: string[], now: Date, limit: number): string[] {
        const candidates: { key: string; R: number }[] = [];

        for (const key of keys) {
            const cardData = this.cards[key];
            if (!cardData) continue;
            if (cardData.state !== State.Review) continue;

            const due = FSRSService.computeDueDate(cardData);
            if (now >= due) continue; // already due, not ahead-of-schedule

            const card = this.hydrate(cardData);
            const R = this.scheduler.get_retrievability(card, now, false);
            candidates.push({ key, R });
        }

        candidates.sort((a, b) => a.R - b.R);
        return candidates.slice(0, limit).map(c => c.key);
    }

    hydrate(data: FSRSCardData): Card {
        const due = FSRSService.computeDueDate(data);
        const scheduledDays = FSRSService.computeInterval(data) ?? data.scheduledDays;
        return {
            due,
            stability: data.stability,
            difficulty: data.difficulty,
            elapsed_days: data.elapsedDays,
            scheduled_days: scheduledDays,
            learning_steps: data.learningSteps,
            reps: data.reps,
            lapses: data.lapses,
            state: data.state as State,
            last_review: data.lastReview ? new Date(data.lastReview) : undefined
        };
    }

    static serialize(card: Card): FSRSCardData {
        const result: FSRSCardData = {
            due: card.due.toISOString(),
            stability: card.stability,
            difficulty: card.difficulty,
            elapsedDays: card.elapsed_days,
            scheduledDays: card.scheduled_days,
            learningSteps: card.learning_steps,
            reps: card.reps,
            lapses: card.lapses,
            state: card.state
        };
        if (card.last_review) {
            result.lastReview = card.last_review instanceof Date
                ? card.last_review.toISOString()
                : String(card.last_review);
        }
        return result;
    }

    // ─── Settings (localStorage) ────────────────────────────────────────

    static getRetention(): number {
        return _retention;
    }

    static setRetention(value: number): void {
        _retention = Math.max(0.80, Math.min(0.99, value));
    }

    static getMaxInterval(): number {
        return _maxInterval;
    }

    static setMaxInterval(value: number): void {
        _maxInterval = Math.max(7, Math.min(365, Math.round(value)));
    }

    /**
     * Find the preset whose retention is closest to the given value.
     * Ties break to the lower-intensity (earlier) preset.
     */
    static getPresetForRetention(retention: number): RetentionPreset {
        let best = RETENTION_PRESETS[0];
        let bestDist = Math.abs(retention - best.retention);
        for (let i = 1; i < RETENTION_PRESETS.length; i++) {
            const p = RETENTION_PRESETS[i];
            const d = Math.abs(retention - p.retention);
            if (d < bestDist) {
                best = p;
                bestDist = d;
            }
        }
        return best.id;
    }

    static getPresetConfig(id: RetentionPreset): RetentionPresetConfig {
        return RETENTION_PRESETS.find(p => p.id === id) ?? DEFAULT_PRESET_CONFIG;
    }

    /**
     * Compute the FSRS scheduling interval (days) for a given stability,
     * target retention, and max-interval cap.
     *
     * This must match what the ts-fsrs scheduler produces, so that
     * `computeDueDate` agrees with the stored `card.due` whenever the retention
     * hasn't changed (and stays close to what ts-fsrs *would* have produced
     * when the retention does change).
     *
     * The base formula `(R^(1/decay) - 1) / factor × S` is the inverse of the
     * forgetting curve and matches `FSRSAlgorithm.next_interval`. On top of
     * that, the short-term Review scheduler enforces
     * `good_interval ≥ hard_interval + 1`, with `hard_interval ≥ 1`, so a
     * Good rating in Review state is always scheduled at least 2 days out.
     * Since this helper is only ever called for Review-state cards
     * (see `computeInterval` and `estimateDailyLoad`), we apply the same
     * 2-day floor.
     *
     * Note: ts-fsrs's exact `good_interval` also depends on the hypothetical
     * `hard_stability` of the same review (which depends on the *pre-review*
     * stability we don't store), so for stabilities where `round(hard_S × mod)`
     * lifts to ≥ 2 the scheduler bumps Good to `hard_interval + 1`. We can't
     * reproduce that without pre-review state; the residual error is bounded
     * to ±1 day in a narrow stability band and converges to zero for both
     * small (≤ ~6) and large (≥ ~15) stabilities.
     */
    static intervalFromStability(stability: number, retention: number, maxInterval: number): number {
        const raw = Math.round((stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1));
        return Math.min(Math.max(raw, 2), maxInterval);
    }

    /**
     * Estimate steady-state daily review load for the supplied cards at the given
     * retention and maxInterval. Only mature Review-state cards with positive
     * stability contribute. Learning, Relearning, and New cards add short-term
     * volume not modeled here, so this is a lower-bound estimate that best
     * reflects a "steady state" repertoire.
     *
     * `mistakesPerDay = reviewsPerDay × (1 − R)` — the FSRS contract is that
     * a card has probability R of being recalled when it is reviewed at its
     * scheduled due time, so 1 − R is the expected per-review miss rate.
     */
    static estimateDailyLoad(
        cards: Record<string, FSRSCardData>,
        retention: number,
        maxInterval: number,
    ): { reviewsPerDay: number; mistakesPerDay: number } {
        let reviewsPerDay = 0;
        for (const c of Object.values(cards)) {
            if (c.state !== State.Review || c.stability <= 0) continue;
            reviewsPerDay += 1 / FSRSService.intervalFromStability(c.stability, retention, maxInterval);
        }
        return {
            reviewsPerDay,
            mistakesPerDay: reviewsPerDay * (1 - retention),
        };
    }

    /**
     * Compute the interval (in days) for a Review-state card using current settings.
     * Returns null for non-Review cards or cards without last_review.
     */
    static computeInterval(card: FSRSCardData): number | null {
        if (card.state !== State.Review || !card.lastReview) return null;
        return FSRSService.intervalFromStability(
            card.stability,
            FSRSService.getRetention(),
            FSRSService.getMaxInterval(),
        );
    }

    /**
     * Compute the due date for a card using current settings.
     * Review cards: recomputed from last_review + interval(stability, retention, maxInterval).
     * New/Learning/Relearning: stored step-based due date.
     */
    static computeDueDate(card: FSRSCardData): Date {
        const interval = FSRSService.computeInterval(card);
        if (interval !== null && card.lastReview) {
            return new Date(new Date(card.lastReview).getTime() + interval * 24 * 60 * 60 * 1000);
        }
        return new Date(card.due);
    }
}
