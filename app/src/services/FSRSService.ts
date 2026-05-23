import { createEmptyCard, fsrs, Rating, State, FSRS, Card } from 'ts-fsrs';
import { FSRSCardData } from '../models/FSRSCardData';

const AUTOPLAY_RETRIEVABILITY_THRESHOLD = 0.97;

export class FSRSService {
    private scheduler: FSRS;
    private cards: Record<string, FSRSCardData>;

    constructor(cards: Record<string, FSRSCardData> = {}) {
        this.scheduler = fsrs({
            request_retention: 0.9,
            maximum_interval: 365,
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

    shouldAutoplay(normalizedFen: string, moveSan: string, now: Date): boolean {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);
        const cardData = this.cards[key];
        if (!cardData) return false;

        // Must be in Review state
        if (cardData.st !== State.Review) return false;

        // Must not be due
        const due = new Date(cardData.d);
        if (now >= due) return false;

        // Retrievability must be >= threshold
        const card = this.hydrate(cardData);
        const R = this.scheduler.get_retrievability(card, now, false);
        if (R < AUTOPLAY_RETRIEVABILITY_THRESHOLD) return false;

        return true;
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

    getCardData(normalizedFen: string, moveSan: string): FSRSCardData | undefined {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);
        return this.cards[key];
    }

    getCardDataByKey(key: string): FSRSCardData | undefined {
        return this.cards[key];
    }

    getRetrievability(normalizedFen: string, moveSan: string, now: Date): number | null {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);
        return this.getRetrievabilityByKey(key, now);
    }

    getRetrievabilityByKey(key: string, now: Date): number | null {
        const cardData = this.cards[key];
        if (!cardData || cardData.st !== State.Review) return null;
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
        if (cardData.st === State.New) return true;
        const due = new Date(cardData.d);
        return now >= due;
    }

    /**
     * Returns the FSRS state for a card, or undefined if no card exists.
     */
    getState(key: string): State | undefined {
        const cardData = this.cards[key];
        return cardData?.st as State | undefined;
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
        if (cardData.st === State.New) return 0;

        const due = new Date(cardData.d);
        const msPastDue = now.getTime() - due.getTime();
        if (msPastDue <= 0) return 0;

        const daysPastDue = msPastDue / (1000 * 60 * 60 * 24);
        if (cardData.st === State.Review && cardData.sd > 0) {
            return daysPastDue / cardData.sd;
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
            if (cardData.st !== State.Review) continue;

            const due = new Date(cardData.d);
            if (now >= due) continue; // already due, not ahead-of-schedule

            const card = this.hydrate(cardData);
            const R = this.scheduler.get_retrievability(card, now, false);
            candidates.push({ key, R });
        }

        candidates.sort((a, b) => a.R - b.R);
        return candidates.slice(0, limit).map(c => c.key);
    }

    hydrate(data: FSRSCardData): Card {
        return {
            due: new Date(data.d),
            stability: data.s,
            difficulty: data.di,
            elapsed_days: data.e,
            scheduled_days: data.sd,
            learning_steps: data.ls,
            reps: data.r,
            lapses: data.l,
            state: data.st as State,
            last_review: data.lr ? new Date(data.lr) : undefined
        };
    }

    static serialize(card: Card): FSRSCardData {
        const result: FSRSCardData = {
            d: card.due.toISOString(),
            s: card.stability,
            di: card.difficulty,
            e: card.elapsed_days,
            sd: card.scheduled_days,
            ls: card.learning_steps,
            r: card.reps,
            l: card.lapses,
            st: card.state
        };
        if (card.last_review) {
            result.lr = card.last_review instanceof Date
                ? card.last_review.toISOString()
                : String(card.last_review);
        }
        return result;
    }
}
