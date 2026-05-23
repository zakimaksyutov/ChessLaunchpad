import { describe, it, expect } from 'vitest';
import { ReviewQueue } from './ReviewQueue';
import { FSRSService } from './FSRSService';
import { State } from 'ts-fsrs';

function buildServiceWithCards(): { service: FSRSService; keys: string[] } {
    const cards: Record<string, any> = {};
    const service = new FSRSService(cards);

    // Create some cards in different states
    // New card (never rated)
    service.ensureCard('pos1::e4');

    // Learning card (rated once, should be due soon)
    service.ensureCard('pos2::d4');
    service.rateCardByKey('pos2::d4', false, new Date(Date.now() - 3600_000));

    // Review card (rated correct many times, may or may not be due)
    service.ensureCard('pos3::Nf3');
    for (let i = 0; i < 5; i++) {
        service.rateCardByKey('pos3::Nf3', true, new Date(Date.now() - (10 - i) * 86400_000));
    }

    const keys = ['pos1::e4', 'pos2::d4', 'pos3::Nf3'];
    return { service, keys };
}

describe('ReviewQueue', () => {
    describe('build', () => {
        it('should include new cards', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4'], new Date());

            expect(queue.isEmpty()).toBe(false);
            expect(queue.size()).toBe(1);
            expect(queue.peek()!.state).toBe(State.New);
        });

        it('should be empty when no cards', () => {
            const service = new FSRSService({});
            const queue = new ReviewQueue();
            queue.build(service, [], new Date());
            expect(queue.isEmpty()).toBe(true);
        });

        it('should skip unknown card keys', () => {
            const service = new FSRSService({});
            const queue = new ReviewQueue();
            queue.build(service, ['unknown::key'], new Date());
            expect(queue.isEmpty()).toBe(true);
        });
    });

    describe('priority ordering', () => {
        it('should place new cards at lowest priority', () => {
            const { service, keys } = buildServiceWithCards();
            const queue = new ReviewQueue();
            queue.build(service, keys, new Date());

            // New cards should be last
            const entries = queue.getEntries();
            const newEntries = entries.filter(e => e.state === State.New);
            if (newEntries.length > 0 && entries.length > 1) {
                const lastNonNew = entries.findIndex(e => e.state !== State.New);
                const firstNew = entries.findIndex(e => e.state === State.New);
                if (lastNonNew !== -1 && firstNew !== -1) {
                    expect(lastNonNew).toBeLessThan(firstNew);
                }
            }
        });
    });

    describe('peek / pop', () => {
        it('peek should not remove entry', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4'], new Date());

            const first = queue.peek();
            const second = queue.peek();
            expect(first).toEqual(second);
            expect(queue.size()).toBe(1);
        });

        it('pop should remove entry', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4'], new Date());

            const entry = queue.pop();
            expect(entry).toBeDefined();
            expect(queue.isEmpty()).toBe(true);
        });

        it('peek on empty queue returns undefined', () => {
            const queue = new ReviewQueue();
            queue.build(new FSRSService({}), [], new Date());
            expect(queue.peek()).toBeUndefined();
        });
    });

    describe('remove', () => {
        it('should remove specific card from queue', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            service.ensureCard('fen2::d4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4', 'fen2::d4'], new Date());

            expect(queue.size()).toBe(2);
            queue.remove('fen1::e4');
            expect(queue.size()).toBe(1);
            expect(queue.peek()!.cardKey).toBe('fen2::d4');
        });

        it('should do nothing if card not in queue', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4'], new Date());

            queue.remove('nonexistent::key');
            expect(queue.size()).toBe(1);
        });
    });

    describe('peekIsNew', () => {
        it('should return true when next card is new', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4'], new Date());
            expect(queue.peekIsNew()).toBe(true);
        });

        it('should return false on empty queue', () => {
            const queue = new ReviewQueue();
            queue.build(new FSRSService({}), [], new Date());
            expect(queue.peekIsNew()).toBe(false);
        });
    });

    describe('dueCount / newCount', () => {
        it('should count new vs due cards', () => {
            const service = new FSRSService({});
            service.ensureCard('fen1::e4');
            service.ensureCard('fen2::d4');
            const queue = new ReviewQueue();
            queue.build(service, ['fen1::e4', 'fen2::d4'], new Date());

            // Both are new
            expect(queue.newCount()).toBe(2);
            expect(queue.dueCount()).toBe(0);
        });
    });
});
