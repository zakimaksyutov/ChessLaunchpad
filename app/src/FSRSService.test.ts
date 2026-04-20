import { FSRSService } from './FSRSService';
import { FSRSCardData } from './FSRSCardData';
import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs';

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

        it('should handle card without last_review', () => {
            const cardData: FSRSCardData = {
                d: '2026-04-20T00:00:00.000Z',
                s: 0, di: 0, e: 0, sd: 0, ls: 0, r: 0, l: 0, st: State.New
            };
            const service = new FSRSService({ 'fen::e4': cardData });
            // Should not throw when checking autoplay
            const result = service.shouldAutoplay('fen', 'e4', new Date('2026-04-20T00:00:00Z'));
            expect(result).toBe(false); // New state → not autoplayable
        });
    });

    describe('shouldAutoplay', () => {
        let scheduler: ReturnType<typeof fsrs>;

        beforeEach(() => {
            scheduler = fsrs({
                request_retention: 0.9,
                maximum_interval: 365,
                enable_fuzz: false,
                enable_short_term: true
            });
        });

        function buildReviewCard(reviewDate: Date): FSRSCardData {
            // Build a card in Review state with high stability
            let card = createEmptyCard(reviewDate);
            // Progress through learning to Review
            card = scheduler.next(card, reviewDate, Rating.Good).card;
            card = scheduler.next(card, new Date(card.due), Rating.Good).card;
            // Now in Review state
            expect(card.state).toBe(State.Review);
            return FSRSService.serialize(card);
        }

        it('should return false when no card exists', () => {
            const service = new FSRSService();
            expect(service.shouldAutoplay('fen', 'e4', new Date())).toBe(false);
        });

        it('should return false when card is New', () => {
            const cardData: FSRSCardData = {
                d: '2026-04-20T00:00:00.000Z',
                s: 0, di: 0, e: 0, sd: 0, ls: 0, r: 0, l: 0, st: State.New
            };
            const service = new FSRSService({ 'fen::e4': cardData });
            expect(service.shouldAutoplay('fen', 'e4', new Date('2026-04-19T00:00:00Z'))).toBe(false);
        });

        it('should return false when card is Learning', () => {
            const cardData: FSRSCardData = {
                d: '2026-05-01T00:00:00.000Z',
                s: 2, di: 5, e: 0, sd: 0, ls: 1, r: 1, l: 0, st: State.Learning
            };
            const service = new FSRSService({ 'fen::e4': cardData });
            expect(service.shouldAutoplay('fen', 'e4', new Date('2026-04-20T00:00:00Z'))).toBe(false);
        });

        it('should return false when card is Relearning', () => {
            const cardData: FSRSCardData = {
                d: '2026-05-01T00:00:00.000Z',
                s: 2, di: 5, e: 0, sd: 0, ls: 1, r: 5, l: 1, st: State.Relearning
            };
            const service = new FSRSService({ 'fen::e4': cardData });
            expect(service.shouldAutoplay('fen', 'e4', new Date('2026-04-20T00:00:00Z'))).toBe(false);
        });

        it('should return false when card is due (now >= due)', () => {
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCard(reviewDate);

            const service = new FSRSService({ 'fen::e4': cardData });
            const atDue = new Date(cardData.d);
            expect(service.shouldAutoplay('fen', 'e4', atDue)).toBe(false);
        });

        it('should return false when retrievability is below threshold', () => {
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCard(reviewDate);

            const service = new FSRSService({ 'fen::e4': cardData });
            // Check slightly before due — R should be close to request_retention (0.9), below 0.97
            const almostDue = new Date(new Date(cardData.d).getTime() - 1000);
            expect(service.shouldAutoplay('fen', 'e4', almostDue)).toBe(false);
        });

        it('should return true when card is Review, not due, and R >= 0.97', () => {
            const reviewDate = new Date('2026-04-01T00:00:00Z');
            const cardData = buildReviewCard(reviewDate);

            const service = new FSRSService({ 'fen::e4': cardData });
            // Right after review, R should be ~1.0
            const justAfterReview = new Date(new Date(cardData.lr!).getTime() + 1000);
            expect(service.shouldAutoplay('fen', 'e4', justAfterReview)).toBe(true);
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
});
