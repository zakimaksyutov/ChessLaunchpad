import { describe, it, expect } from 'vitest';
import { formatDueRelative, formatLastReviewed, formatElapsed } from './ExplorerRelativeTime';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date('2026-06-18T12:00:00.000Z');

function ago(ms: number): Date {
    return new Date(NOW.getTime() - ms);
}

function ahead(ms: number): Date {
    return new Date(NOW.getTime() + ms);
}

describe('ExplorerRelativeTime', () => {
    describe('formatLastReviewed', () => {
        it('shows "just now" for a sub-minute-old review (regression: no longer clamps to "last 1d ago")', () => {
            expect(formatLastReviewed(NOW, NOW)).toBe('just now');
            expect(formatLastReviewed(ago(SECOND), NOW)).toBe('just now');
            expect(formatLastReviewed(ago(59 * SECOND), NOW)).toBe('just now');
        });

        it('formats recent reviews in minutes', () => {
            expect(formatLastReviewed(ago(MINUTE), NOW)).toBe('last 1 min ago');
            expect(formatLastReviewed(ago(5 * MINUTE), NOW)).toBe('last 5 min ago');
            expect(formatLastReviewed(ago(59 * MINUTE), NOW)).toBe('last 59 min ago');
        });

        it('formats reviews in hours up to 48h', () => {
            expect(formatLastReviewed(ago(2 * HOUR), NOW)).toBe('last 2h ago');
            // 12h ago used to round up to "last 1d ago"; now it stays in hours.
            expect(formatLastReviewed(ago(12 * HOUR), NOW)).toBe('last 12h ago');
            expect(formatLastReviewed(ago(47 * HOUR), NOW)).toBe('last 47h ago');
        });

        it('formats reviews in days at and beyond 48h', () => {
            expect(formatLastReviewed(ago(2 * DAY), NOW)).toBe('last 2d ago');
            expect(formatLastReviewed(ago(5 * DAY), NOW)).toBe('last 5d ago');
            expect(formatLastReviewed(ago(22 * DAY), NOW)).toBe('last 22d ago');
        });

        it('formats reviews in months and years', () => {
            expect(formatLastReviewed(ago(90 * DAY), NOW)).toBe('last 3 mo ago');
            expect(formatLastReviewed(ago(800 * DAY), NOW)).toBe('last 2.2 yr ago');
        });

        it('treats future timestamps defensively as "just now"', () => {
            expect(formatLastReviewed(ahead(HOUR), NOW)).toBe('just now');
        });
    });

    describe('formatElapsed', () => {
        it('shows "just now" for a sub-minute-old event', () => {
            expect(formatElapsed(NOW, NOW)).toBe('just now');
            expect(formatElapsed(ago(59 * SECOND), NOW)).toBe('just now');
        });

        it('formats minute, hour, day, month and year ranges without a "last" prefix', () => {
            expect(formatElapsed(ago(5 * MINUTE), NOW)).toBe('5 min ago');
            expect(formatElapsed(ago(12 * HOUR), NOW)).toBe('12h ago');
            expect(formatElapsed(ago(3 * DAY), NOW)).toBe('3d ago');
            expect(formatElapsed(ago(90 * DAY), NOW)).toBe('3 mo ago');
            expect(formatElapsed(ago(800 * DAY), NOW)).toBe('2.2 yr ago');
        });

        it('treats future timestamps defensively as "just now"', () => {
            expect(formatElapsed(ahead(HOUR), NOW)).toBe('just now');
        });
    });

    describe('formatDueRelative', () => {
        it('returns "due now" at or before now', () => {
            expect(formatDueRelative(NOW, NOW)).toBe('due now');
            expect(formatDueRelative(ago(HOUR), NOW)).toBe('due now');
        });

        it('formats sub-minute, minute and hour ranges', () => {
            expect(formatDueRelative(ahead(30 * SECOND), NOW)).toBe('due in < 1 min');
            expect(formatDueRelative(ahead(15 * MINUTE), NOW)).toBe('due in 15 min');
            expect(formatDueRelative(ahead(3 * HOUR), NOW)).toBe('due in 3h');
        });

        it('formats day, month and year ranges', () => {
            expect(formatDueRelative(ahead(14 * DAY), NOW)).toBe('due in 14d');
            expect(formatDueRelative(ahead(90 * DAY), NOW)).toBe('due in 3 mo');
            expect(formatDueRelative(ahead(800 * DAY), NOW)).toBe('due in 2.2 yr');
        });
    });
});
