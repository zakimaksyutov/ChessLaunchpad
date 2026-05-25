import { describe, it, expect } from 'vitest';
import { formatDuration, formatDateHeader, formatAccuracy } from './FormatUtils';

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
});
