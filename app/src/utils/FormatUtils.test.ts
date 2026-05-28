import { describe, it, expect } from 'vitest';
import { formatDuration, formatDateHeader, formatAccuracy, formatTimeUntil } from './FormatUtils';

describe('FormatUtils', () => {
    describe('formatDuration', () => {
        it('returns "< 1 min" for less than 60 seconds', () => {
            expect(formatDuration(0)).toBe('< 1 min');
            expect(formatDuration(30)).toBe('< 1 min');
            expect(formatDuration(59)).toBe('< 1 min');
        });

        it('formats minutes only', () => {
            expect(formatDuration(60)).toBe('1 min');
            expect(formatDuration(720)).toBe('12 min');
            expect(formatDuration(3540)).toBe('59 min');
        });

        it('formats hours and minutes', () => {
            expect(formatDuration(3900)).toBe('1 hr 5 min');
            expect(formatDuration(7500)).toBe('2 hr 5 min');
        });

        it('formats hours only when minutes are 0', () => {
            expect(formatDuration(3600)).toBe('1 hr');
            expect(formatDuration(7200)).toBe('2 hr');
        });
    });

    describe('formatDateHeader', () => {
        it('formats YYYY-MM-DD as "D MON YYYY"', () => {
            expect(formatDateHeader('2026-05-25')).toBe('25 MAY 2026');
            expect(formatDateHeader('2026-01-01')).toBe('1 JAN 2026');
            expect(formatDateHeader('2025-12-31')).toBe('31 DEC 2025');
        });
    });

    describe('formatAccuracy', () => {
        it('returns "—" for null', () => {
            expect(formatAccuracy(null)).toBe('—');
        });

        it('formats percentage', () => {
            expect(formatAccuracy(0.9)).toBe('90%');
            expect(formatAccuracy(1.0)).toBe('100%');
            expect(formatAccuracy(0.833)).toBe('83%');
        });
    });

    describe('formatTimeUntil', () => {
        const NOW = new Date('2026-05-27T12:00:00Z');
        const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

        const MIN = 60 * 1000;
        const HR = 60 * MIN;
        const DAY = 24 * HR;

        it('returns "now" when target is at or before now', () => {
            expect(formatTimeUntil(NOW, NOW)).toBe('now');
            expect(formatTimeUntil(at(-1000), NOW)).toBe('now');
            expect(formatTimeUntil(at(-DAY), NOW)).toBe('now');
        });

        it('returns "in < 1 min" for sub-minute futures', () => {
            expect(formatTimeUntil(at(1), NOW)).toBe('in < 1 min');
            expect(formatTimeUntil(at(30 * 1000), NOW)).toBe('in < 1 min');
            expect(formatTimeUntil(at(59 * 1000), NOW)).toBe('in < 1 min');
        });

        it('formats minutes only', () => {
            expect(formatTimeUntil(at(MIN), NOW)).toBe('in 1 min');
            expect(formatTimeUntil(at(15 * MIN), NOW)).toBe('in 15 min');
            expect(formatTimeUntil(at(59 * MIN), NOW)).toBe('in 59 min');
        });

        it('formats hours only when minutes are 0', () => {
            expect(formatTimeUntil(at(HR), NOW)).toBe('in 1 hr');
            expect(formatTimeUntil(at(3 * HR), NOW)).toBe('in 3 hr');
            expect(formatTimeUntil(at(23 * HR), NOW)).toBe('in 23 hr');
        });

        it('formats hours and minutes', () => {
            expect(formatTimeUntil(at(HR + 20 * MIN), NOW)).toBe('in 1 hr 20 min');
            expect(formatTimeUntil(at(5 * HR + 1 * MIN), NOW)).toBe('in 5 hr 1 min');
        });

        it('formats exactly 1 day', () => {
            expect(formatTimeUntil(at(DAY), NOW)).toBe('in 1 day');
        });

        it('formats days only when hours are 0', () => {
            expect(formatTimeUntil(at(2 * DAY), NOW)).toBe('in 2 days');
            expect(formatTimeUntil(at(10 * DAY), NOW)).toBe('in 10 days');
        });

        it('formats days and hours', () => {
            expect(formatTimeUntil(at(DAY + 4 * HR), NOW)).toBe('in 1 day 4 hr');
            expect(formatTimeUntil(at(3 * DAY + 7 * HR), NOW)).toBe('in 3 days 7 hr');
        });

        it('truncates sub-hour remainders when expressed in days', () => {
            // 2 days + 3 hr + 59 min → drops the 59 min (we only carry the next-larger unit)
            expect(formatTimeUntil(at(2 * DAY + 3 * HR + 59 * MIN), NOW)).toBe('in 2 days 3 hr');
        });
    });
});
