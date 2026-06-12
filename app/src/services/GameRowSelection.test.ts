import { describe, it, expect } from 'vitest';
import { selectRenderableRows } from './GameRowSelection';
import { GameRecord, MastersTheoryVerdict } from '../models/RepertoireData';

function makeRecord(
    id: string,
    overrides: Partial<GameRecord> = {},
): GameRecord {
    return {
        id,
        p: 'l',
        t: 0,
        wa: 'alice',
        ba: 'bob',
        wr: 1500,
        br: 1500,
        m: 'e4',
        rt: 1,
        sp: 'blitz',
        tc: '5+3',
        res: 'w',
        ...overrides,
    } as GameRecord;
}

function keyOf(r: GameRecord): string {
    return `${r.p}:${r.id}`;
}

describe('selectRenderableRows', () => {
    it('returns annotated records as non-pending', () => {
        const a = makeRecord('a', { an: {} });
        const b = makeRecord('b', { an: {} });
        const rows = selectRenderableRows(
            [
                { record: a, userLower: 'alice' },
                { record: b, userLower: 'alice' },
            ],
            new Set(),
            new Map(),
            new Set(),
        );
        expect(rows).toEqual([
            { record: a, userLower: 'alice', pending: false },
            { record: b, userLower: 'alice', pending: false },
        ]);
    });

    it('filters out records without `an` that are neither re-annotating nor pending', () => {
        const a = makeRecord('a');
        const rows = selectRenderableRows(
            [{ record: a, userLower: 'alice' }],
            new Set(),
            new Map(),
            new Set(),
        );
        expect(rows).toEqual([]);
    });

    it('shows records queued for the current pass as skeleton (pending: true)', () => {
        const a = makeRecord('a');
        const rows = selectRenderableRows(
            [{ record: a, userLower: 'alice' }],
            new Set(),
            new Map(),
            new Set([keyOf(a)]),
        );
        expect(rows).toEqual([
            { record: a, userLower: 'alice', pending: true },
        ]);
    });

    it('shows re-annotating records via prior `an` overlay (cloned record)', () => {
        const a = makeRecord('a'); // an undefined
        const prior: MastersTheoryVerdict = {};
        const rows = selectRenderableRows(
            [{ record: a, userLower: 'alice' }],
            new Set([keyOf(a)]),
            new Map([[keyOf(a), prior]]),
            new Set(),
        );
        expect(rows.length).toBe(1);
        expect(rows[0].pending).toBe(false);
        expect(rows[0].userLower).toBe('alice');
        expect(rows[0].record.an).toBe(prior);
        // Must be a clone — must not mutate input record.
        expect(rows[0].record).not.toBe(a);
        expect(a.an).toBeUndefined();
    });

    it('omits re-annotating record when priorAn is missing (defensive)', () => {
        const a = makeRecord('a');
        const rows = selectRenderableRows(
            [{ record: a, userLower: 'alice' }],
            new Set([keyOf(a)]),
            new Map(), // no prior
            new Set(),
        );
        expect(rows).toEqual([]);
    });

    it('prefers re-annotation overlay over skeleton when a record is in both sets', () => {
        const a = makeRecord('a');
        const prior: MastersTheoryVerdict = {};
        const rows = selectRenderableRows(
            [{ record: a, userLower: 'alice' }],
            new Set([keyOf(a)]),
            new Map([[keyOf(a), prior]]),
            new Set([keyOf(a)]),
        );
        expect(rows.length).toBe(1);
        expect(rows[0].pending).toBe(false);
        expect(rows[0].record.an).toBe(prior);
    });

    it('mixed input: annotated + pending + filtered + re-annotated', () => {
        const a = makeRecord('a', { an: {} });
        const b = makeRecord('b'); // pending
        const c = makeRecord('c'); // not pending → filtered
        const d = makeRecord('d'); // re-annotating
        const priorD: MastersTheoryVerdict = {};
        const rows = selectRenderableRows(
            [
                { record: a, userLower: 'alice' },
                { record: b, userLower: 'alice' },
                { record: c, userLower: 'alice' },
                { record: d, userLower: 'alice' },
            ],
            new Set([keyOf(d)]),
            new Map([[keyOf(d), priorD]]),
            new Set([keyOf(b)]),
        );
        expect(rows.length).toBe(3);
        expect(rows[0]).toMatchObject({ record: a, pending: false });
        expect(rows[1].record.id).toBe('b');
        expect(rows[1].pending).toBe(true);
        expect(rows[2].record.id).toBe('d');
        expect(rows[2].pending).toBe(false);
        expect(rows[2].record.an).toBe(priorD);
    });
});
