import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeTracker } from './TimeTracker';

describe('TimeTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Mock document.hidden as false (tab visible)
        Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('tracks elapsed time', () => {
        const tracker = new TimeTracker();
        tracker.start();

        vi.advanceTimersByTime(5000);

        const elapsed = tracker.getElapsedSeconds();
        expect(elapsed).toBeCloseTo(5, 0);
        tracker.destroy();
    });

    it('pauses when tab is hidden', () => {
        const tracker = new TimeTracker();
        tracker.start();

        vi.advanceTimersByTime(3000);

        // Simulate tab hidden
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        vi.advanceTimersByTime(5000); // should not count

        // Simulate tab visible
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        vi.advanceTimersByTime(2000);

        const elapsed = tracker.getElapsedSeconds();
        expect(elapsed).toBeCloseTo(5, 0); // 3 + 2, not 10
        tracker.destroy();
    });

    it('consumeElapsed returns time and resets', () => {
        const tracker = new TimeTracker();
        tracker.start();

        vi.advanceTimersByTime(5000);

        const consumed = tracker.consumeElapsed();
        expect(consumed).toBeCloseTo(5, 0);

        vi.advanceTimersByTime(3000);
        const next = tracker.getElapsedSeconds();
        expect(next).toBeCloseTo(3, 0);

        tracker.destroy();
    });

    it('stop prevents further accumulation', () => {
        const tracker = new TimeTracker();
        tracker.start();

        vi.advanceTimersByTime(2000);
        tracker.stop();

        vi.advanceTimersByTime(5000);

        const elapsed = tracker.getElapsedSeconds();
        expect(elapsed).toBeCloseTo(2, 0);
        tracker.destroy();
    });

    it('reset clears accumulated time', () => {
        const tracker = new TimeTracker();
        tracker.start();

        vi.advanceTimersByTime(5000);
        tracker.reset();

        vi.advanceTimersByTime(2000);
        const elapsed = tracker.getElapsedSeconds();
        expect(elapsed).toBeCloseTo(2, 0);
        tracker.destroy();
    });

    it('stop while hidden does not count hidden time', () => {
        const tracker = new TimeTracker();
        tracker.start();

        vi.advanceTimersByTime(3000);

        // Tab goes hidden
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        vi.advanceTimersByTime(5000); // hidden time

        // Stop while still hidden
        tracker.stop();

        const elapsed = tracker.getElapsedSeconds();
        expect(elapsed).toBeCloseTo(3, 0); // only visible time
        tracker.destroy();
    });
});
