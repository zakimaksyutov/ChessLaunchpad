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

    getCards(): Record<string, FSRSCardData> {
        return this.cards;
    }

    getCardData(normalizedFen: string, moveSan: string): FSRSCardData | undefined {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);
        return this.cards[key];
    }

    getRetrievability(normalizedFen: string, moveSan: string, now: Date): number | null {
        const key = FSRSService.makeCardKey(normalizedFen, moveSan);
        const cardData = this.cards[key];
        if (!cardData || cardData.st !== State.Review) return null;
        const card = this.hydrate(cardData);
        return this.scheduler.get_retrievability(card, now, false);
    }

    private hydrate(data: FSRSCardData): Card {
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
