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

describe('AuditService', () => {
    it('starts watching on Again with a non-New pre-call state', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        svc.onRate('k1', reviewCard(), Rating.Again, 1_700_000_000_000, 'target');

        expect(audit).toHaveLength(1);
        expect(audit[0].k).toBe('k1');
        expect(audit[0].events).toEqual([
            { ts: 1_700_000_000_000, r: Rating.Again, s: 'target' },
        ]);
        // before is the packed shape (length 10 because reviewCard has lastReview)
        expect(audit[0].before).toHaveLength(10);
    });

    it('does NOT watch the bootstrap Again on a New-state card', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        // Mirrors the recall-pass bootstrap in TrainingEngine: a freshly
        // created card is still in State.New when the recall-pass rates it
        // Again. The trigger rule filters that out.
        svc.onRate('k1', newCard(), Rating.Again, 1_700_000_000_000, 'learn');

        expect(audit).toEqual([]);
    });

    it('does NOT watch Again with no pre-call card', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        svc.onRate('k1', undefined, Rating.Again, 1_700_000_000_000, 'target');

        expect(audit).toEqual([]);
    });

    it('does NOT start watching on Good — only Again triggers a watch', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        svc.onRate('k1', reviewCard(), Rating.Good, 1_700_000_000_000, 'target');

        expect(audit).toEqual([]);
    });

    it('appends BOTH Again and Good events to an existing watched card', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        svc.onRate('k1', reviewCard(), Rating.Again, 1_000, 'target');
        // Subsequent Good — should be appended because k1 is watched
        svc.onRate('k1', learningCard(), Rating.Good, 2_000, 'target');
        // Subsequent Again on the recovering card — should be appended
        svc.onRate('k1', learningCard(), Rating.Again, 3_000, 'cooldown');

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
        const beforeData = reviewCard({ stability: 7.0, lapses: 0 });

        svc.onRate('k1', beforeData, Rating.Again, 1_000, 'target');
        const snapshot = [...audit[0].before];

        // Append more events — `before` must NOT change
        svc.onRate('k1', learningCard({ stability: 0.5, lapses: 1 }), Rating.Good, 2_000, 'target');

        expect(audit[0].before).toEqual(snapshot);
    });

    it('caps at AUDIT_MAX_ENTRIES; new triggers are dropped silently', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        for (let i = 0; i < AUDIT_MAX_ENTRIES; i++) {
            svc.onRate(`k${i}`, reviewCard(), Rating.Again, 1_000 + i, 'target');
        }
        expect(audit).toHaveLength(AUDIT_MAX_ENTRIES);

        // 11th trigger on an unwatched card — must be dropped
        svc.onRate('overflow', reviewCard(), Rating.Again, 9_999, 'target');
        expect(audit).toHaveLength(AUDIT_MAX_ENTRIES);
        expect(audit.find(e => e.k === 'overflow')).toBeUndefined();
    });

    it('continues accumulating events on existing watched entries after the cap is full', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);

        for (let i = 0; i < AUDIT_MAX_ENTRIES; i++) {
            svc.onRate(`k${i}`, reviewCard(), Rating.Again, 1_000 + i, 'target');
        }
        // Now append a Good to an existing watched card — must succeed
        svc.onRate('k0', learningCard(), Rating.Good, 99_999, 'cooldown');

        const k0 = audit.find(e => e.k === 'k0')!;
        expect(k0.events).toHaveLength(2);
        expect(k0.events[1]).toEqual({ ts: 99_999, r: Rating.Good, s: 'cooldown' });
    });

    it('rebuilds the watched-key index from a pre-existing audit array', () => {
        // Simulates loading from a persisted blob: events for the already-
        // watched card must continue to accumulate, even though the constructor
        // saw the array from a prior session.
        const existing: AuditEntry[] = [{
            k: 'k1',
            before: [1, 2, 3, 4, 5, 6, 7, 8, 2] as any,
            events: [{ ts: 1, r: Rating.Again, s: 'target' }],
        }];
        const svc = new AuditService(existing);

        svc.onRate('k1', learningCard(), Rating.Good, 2, 'target');

        expect(existing[0].events).toHaveLength(2);
        expect(existing[0].events[1]).toEqual({ ts: 2, r: Rating.Good, s: 'target' });
    });

    it('all six AuditEventSource values are accepted by onRate', () => {
        const audit: AuditEntry[] = [];
        const svc = new AuditService(audit);
        const sources = ['target', 'warmup', 'cooldown', 'branch', 'learn', 'ingest'] as const;

        let ts = 1_000;
        for (const s of sources) {
            // Use a unique key per source so each becomes a separate watched entry
            svc.onRate(`k-${s}`, reviewCard(), Rating.Again, ts++, s);
        }

        expect(audit).toHaveLength(sources.length);
        for (const s of sources) {
            const entry = audit.find(e => e.k === `k-${s}`);
            expect(entry?.events[0].s).toBe(s);
        }
    });

    describe('defensive entry handling (corrupt-blob tolerance)', () => {
        it('repairs an entry whose `events` field is missing (non-array)', () => {
            // Decode → normalize lets array-shaped audit through verbatim; an
            // entry with no `events` would crash `events.push` at the next
            // rate. The constructor must coerce it to `[]` so the bridge
            // tolerates corrupt persisted state.
            const corrupt = [{ k: 'k1' } as unknown as AuditEntry];
            const svc = new AuditService(corrupt);

            // Should not throw — and the subsequent append should land.
            expect(() => svc.onRate('k1', learningCard(), Rating.Good, 100, 'target'))
                .not.toThrow();
            expect(corrupt[0].events).toEqual([{ ts: 100, r: Rating.Good, s: 'target' }]);
        });

        it('repairs an entry whose `events` is a non-array value', () => {
            const corrupt = [{ k: 'k1', events: 'oops' } as unknown as AuditEntry];
            const svc = new AuditService(corrupt);

            expect(() => svc.onRate('k1', learningCard(), Rating.Again, 200, 'cooldown'))
                .not.toThrow();
            expect(corrupt[0].events).toEqual([{ ts: 200, r: Rating.Again, s: 'cooldown' }]);
        });

        it('skips entries with a missing/non-string `k` rather than throwing', () => {
            const corrupt = [
                { k: 'good', events: [] } as unknown as AuditEntry,
                { events: [] } as unknown as AuditEntry, // no k
                { k: 42, events: [] } as unknown as AuditEntry, // non-string k
            ];
            const svc = new AuditService(corrupt);

            // The good entry can still receive events
            expect(() => svc.onRate('good', learningCard(), Rating.Good, 1, 'target'))
                .not.toThrow();
            // A fresh trigger on a fresh key works normally
            expect(() => svc.onRate('fresh', reviewCard(), Rating.Again, 2, 'target'))
                .not.toThrow();

            // Both `good` and `fresh` are watched
            expect(corrupt.find(e => e.k === 'good')?.events).toHaveLength(1);
            expect(corrupt.find(e => e.k === 'fresh')?.events[0].ts).toBe(2);
        });

        it('survives constructor with non-array audit entries (e.g. null/undefined holes)', () => {
            // JSON.parse can't yield holes, but defensive null entries can
            // come from manual blob edits.
            const corrupt = [null, undefined, { k: 'ok', events: [] }] as unknown as AuditEntry[];
            expect(() => new AuditService(corrupt)).not.toThrow();
        });
    });
});
