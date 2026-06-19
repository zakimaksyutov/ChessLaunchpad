import { describe, it, expect } from 'vitest';
import { Rating, State } from 'ts-fsrs';
import { AuditService } from './AuditService';
import { AuditEntry, AUDIT_MAX_ENTRIES } from '../models/AuditData';
import { FSRSCardData } from '../models/FSRSCardData';

function reviewCard(overrides: Partial<FSRSCardData> = {}): FSRSCardData {
    return {
        due: '2030-01-01T12:00:00.000Z',
        stability: 12.5,
        difficulty: 4.2,
        elapsedDays: 3,
        scheduledDays: 7,
        learningSteps: 0,
        reps: 8,
        lapses: 1,
        state: State.Review,
        lastReview: '2026-04-19T08:00:00.000Z',
        ...overrides,
    };
}

function learningCard(overrides: Partial<FSRSCardData> = {}): FSRSCardData {
    return reviewCard({ state: State.Learning, ...overrides });
}

function newCard(): FSRSCardData {
    return {
        due: '2026-01-01T00:00:00.000Z',
        stability: 0,
        difficulty: 0,
        elapsedDays: 0,
        scheduledDays: 0,
        learningSteps: 0,
        reps: 0,
        lapses: 0,
        state: State.New,
    };
}

const PACKED = [1, 2, 3, 4, 5, 6, 7, 8, 2] as unknown as AuditEntry['before'];

describe('AuditService', () => {
    describe('onRate (append-only; no auto-capture)', () => {
        it('is a no-op for an untracked card — entries are never auto-created', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            svc.onRate('k1', Rating.Again, 1_700_000_000_000, 'target');

            expect(audit).toEqual([]);
        });

        it('appends BOTH Again and Good events to a tracked card', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);
            svc.track('k1', reviewCard());

            svc.onRate('k1', Rating.Again, 1_000, 'target');
            svc.onRate('k1', Rating.Good, 2_000, 'target');
            svc.onRate('k1', Rating.Again, 3_000, 'cooldown');

            expect(audit).toHaveLength(1);
            expect(audit[0].events).toEqual([
                { ts: 1_000, r: Rating.Again, s: 'target' },
                { ts: 2_000, r: Rating.Good,  s: 'target' },
                { ts: 3_000, r: Rating.Again, s: 'cooldown' },
            ]);
        });

        it('preserves the `before` snapshot — later events do not overwrite it', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);
            svc.track('k1', reviewCard({ stability: 7.0, lapses: 0 }));
            const snapshot = [...audit[0].before];

            svc.onRate('k1', Rating.Good, 2_000, 'target');

            expect(audit[0].before).toEqual(snapshot);
        });

        it('continues appending to a tracked entry loaded from a prior session', () => {
            const existing: AuditEntry[] = [{
                k: 'k1',
                before: PACKED,
                events: [{ ts: 1, r: Rating.Again, s: 'target' }],
            }];
            const svc = new AuditService(existing);

            svc.onRate('k1', Rating.Good, 2, 'target');

            expect(existing[0].events).toHaveLength(2);
            expect(existing[0].events[1]).toEqual({ ts: 2, r: Rating.Good, s: 'target' });
        });

        it('accepts all six AuditEventSource values for a tracked card', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);
            svc.track('k1', reviewCard());
            const sources = ['target', 'warmup', 'cooldown', 'branch', 'learn', 'ingest'] as const;

            let ts = 1_000;
            for (const s of sources) {
                svc.onRate('k1', Rating.Again, ts++, s);
            }

            expect(audit[0].events.map(e => e.s)).toEqual([...sources]);
        });
    });

    describe('track', () => {
        it('starts an empty event log with a packed snapshot', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            const ok = svc.track('k1', reviewCard());

            expect(ok).toBe(true);
            expect(audit).toHaveLength(1);
            expect(audit[0].k).toBe('k1');
            expect(audit[0].events).toEqual([]);
            // before is the packed shape (length 10 because reviewCard has lastReview)
            expect(audit[0].before).toHaveLength(10);
            expect(svc.isTracked('k1')).toBe(true);
        });

        it('refuses to track a New-state card', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            expect(svc.track('k1', newCard())).toBe(false);
            expect(audit).toEqual([]);
        });

        it('refuses to track when there is no card to snapshot', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            expect(svc.track('k1', undefined)).toBe(false);
            expect(audit).toEqual([]);
        });

        it('refuses to track a card that is already tracked', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            expect(svc.track('k1', reviewCard())).toBe(true);
            expect(svc.track('k1', learningCard())).toBe(false);
            expect(audit).toHaveLength(1);
        });

        it('refuses to track once at capacity', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            for (let i = 0; i < AUDIT_MAX_ENTRIES; i++) {
                expect(svc.track(`k${i}`, reviewCard())).toBe(true);
            }
            expect(svc.isFull()).toBe(true);
            expect(svc.track('overflow', reviewCard())).toBe(false);
            expect(audit).toHaveLength(AUDIT_MAX_ENTRIES);
            expect(audit.find(e => e.k === 'overflow')).toBeUndefined();
        });
    });

    describe('untrack', () => {
        it('removes a tracked entry (snapshot + events) and frees a slot', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);
            svc.track('k1', reviewCard());
            svc.onRate('k1', Rating.Again, 1_000, 'target');

            expect(svc.untrack('k1')).toBe(true);
            expect(audit).toEqual([]);
            expect(svc.isTracked('k1')).toBe(false);
            expect(svc.isFull()).toBe(false);
        });

        it('returns false when the key was never tracked', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);

            expect(svc.untrack('nope')).toBe(false);
        });

        it('untracking frees a slot so a full audit can accept a new track', () => {
            const audit: AuditEntry[] = [];
            const svc = new AuditService(audit);
            for (let i = 0; i < AUDIT_MAX_ENTRIES; i++) {
                svc.track(`k${i}`, reviewCard());
            }
            expect(svc.track('new', reviewCard())).toBe(false);

            svc.untrack('k0');
            expect(svc.track('new', reviewCard())).toBe(true);
            expect(svc.isTracked('new')).toBe(true);
        });

        it('removes every entry matching the key (corrupt-blob duplicates)', () => {
            const dup: AuditEntry[] = [
                { k: 'k1', before: PACKED, events: [] },
                { k: 'k1', before: PACKED, events: [] },
                { k: 'k2', before: PACKED, events: [] },
            ];
            const svc = new AuditService(dup);

            expect(svc.untrack('k1')).toBe(true);
            expect(dup.map(e => e.k)).toEqual(['k2']);
        });
    });

    describe('defensive entry handling (corrupt-blob tolerance)', () => {
        it('repairs an entry whose `events` field is missing (non-array)', () => {
            const corrupt = [{ k: 'k1' } as unknown as AuditEntry];
            const svc = new AuditService(corrupt);

            expect(() => svc.onRate('k1', Rating.Good, 100, 'target')).not.toThrow();
            expect(corrupt[0].events).toEqual([{ ts: 100, r: Rating.Good, s: 'target' }]);
        });

        it('repairs an entry whose `events` is a non-array value', () => {
            const corrupt = [{ k: 'k1', events: 'oops' } as unknown as AuditEntry];
            const svc = new AuditService(corrupt);

            expect(() => svc.onRate('k1', Rating.Again, 200, 'cooldown')).not.toThrow();
            expect(corrupt[0].events).toEqual([{ ts: 200, r: Rating.Again, s: 'cooldown' }]);
        });

        it('skips entries with a missing/non-string `k` rather than throwing', () => {
            const corrupt = [
                { k: 'good', events: [] } as unknown as AuditEntry,
                { events: [] } as unknown as AuditEntry, // no k
                { k: 42, events: [] } as unknown as AuditEntry, // non-string k
            ];
            const svc = new AuditService(corrupt);

            expect(() => svc.onRate('good', Rating.Good, 1, 'target')).not.toThrow();
            expect(corrupt.find(e => e.k === 'good')?.events).toHaveLength(1);
        });

        it('survives constructor with non-array audit entries (e.g. null/undefined holes)', () => {
            const corrupt = [null, undefined, { k: 'ok', events: [] }] as unknown as AuditEntry[];
            expect(() => new AuditService(corrupt)).not.toThrow();
        });
    });
});
