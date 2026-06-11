import { describe, it, expect } from 'vitest';
import { orderRowsSticky, OrderableRow } from './GameRowOrdering';

type Row = OrderableRow<string>;

function row(key: string, t: number): Row {
    return { key, t, payload: key };
}

function keysOf(rows: Row[]): string[] {
    return rows.map(r => r.key);
}

function runRenders(renders: Row[][]): { outputs: string[][]; sessionOrder: Map<string, number> } {
    const sessionOrder = new Map<string, number>();
    const outputs: string[][] = [];
    for (const renderable of renders) {
        const ordered = orderRowsSticky(renderable, sessionOrder);
        outputs.push(keysOf(ordered));
    }
    return { outputs, sessionOrder };
}

describe('orderRowsSticky', () => {
    it('first render: all rows are fresh and sorted newest-first', () => {
        const r = [row('a', 100), row('b', 300), row('c', 200)];
        const { outputs, sessionOrder } = runRenders([r]);
        expect(outputs[0]).toEqual(['b', 'c', 'a']);
        expect(sessionOrder.get('b')).toBe(0);
        expect(sessionOrder.get('c')).toBe(1);
        expect(sessionOrder.get('a')).toBe(2);
    });

    it('known rows keep their slot across renders when nothing changes', () => {
        const r = [row('a', 300), row('b', 200), row('c', 100)];
        const { outputs } = runRenders([r, r, r]);
        expect(outputs[0]).toEqual(['a', 'b', 'c']);
        expect(outputs[1]).toEqual(['a', 'b', 'c']);
        expect(outputs[2]).toEqual(['a', 'b', 'c']);
    });

    // ---- Regression: the reported /games sync bug ----

    it('regression: a single newly-analyzed game stays at the top across the next render', () => {
        const olds = [row('old-a', 300), row('old-b', 200), row('old-c', 100)];
        const withG1 = [row('g1', 500), ...olds];
        const { outputs } = runRenders([olds, withG1, withG1]);
        expect(outputs[0]).toEqual(['old-a', 'old-b', 'old-c']);
        expect(outputs[1]).toEqual(['g1', 'old-a', 'old-b', 'old-c']);
        expect(outputs[2]).toEqual(['g1', 'old-a', 'old-b', 'old-c']);
    });

    it('regression: two newly-analyzed games landing in sequence both stay at the top', () => {
        // Reproduces the user-reported sequence: G1 lands, then G2 lands;
        // on the stabilization render both must remain at the top.
        const olds = [row('old-a', 300), row('old-b', 200), row('old-c', 100)];
        const withG1 = [row('g1', 500), ...olds];
        const withG2 = [row('g2', 600), ...withG1];
        const { outputs } = runRenders([olds, withG1, withG2, withG2]);
        expect(outputs[0]).toEqual(['old-a', 'old-b', 'old-c']);
        expect(outputs[1]).toEqual(['g1', 'old-a', 'old-b', 'old-c']);
        expect(outputs[2]).toEqual(['g2', 'g1', 'old-a', 'old-b', 'old-c']);
        expect(outputs[3]).toEqual(['g2', 'g1', 'old-a', 'old-b', 'old-c']);
    });

    it('regression: known rows stay in time order after the rebuild', () => {
        let renderable: Row[] = [row('a', 100)];
        const renders: Row[][] = [renderable];
        for (let i = 2; i <= 5; i++) {
            renderable = [row(`a${i}`, 100 * i), ...renderable];
            renders.push(renderable);
        }
        renders.push(renderable);
        const { outputs } = runRenders(renders);
        expect(outputs[outputs.length - 1]).toEqual(['a5', 'a4', 'a3', 'a2', 'a']);
    });

    // ---- Spec cases ----

    it('late-arriving older sync games go to the bottom and stay there', () => {
        const olds = [row('a', 300), row('b', 200), row('c', 100)];
        const withOlder = [...olds, row('older', 50)];
        const { outputs } = runRenders([olds, withOlder, withOlder]);
        expect(outputs[1]).toEqual(['a', 'b', 'c', 'older']);
        expect(outputs[2]).toEqual(['a', 'b', 'c', 'older']);
    });

    it('mid-range fresh rows insert by timestamp', () => {
        const olds = [row('a', 400), row('b', 200)];
        const withMid = [row('mid', 300), ...olds];
        const { outputs } = runRenders([olds, withMid, withMid]);
        expect(outputs[1]).toEqual(['a', 'mid', 'b']);
        expect(outputs[2]).toEqual(['a', 'mid', 'b']);
    });

    it('mixed batch: front + middle + back fresh rows on the same render', () => {
        const olds = [row('a', 400), row('b', 200)];
        const mixed = [
            row('newer', 500),
            row('mid', 300),
            row('older', 100),
            ...olds,
        ];
        const { outputs } = runRenders([olds, mixed, mixed]);
        expect(outputs[1]).toEqual(['newer', 'a', 'mid', 'b', 'older']);
        expect(outputs[2]).toEqual(['newer', 'a', 'mid', 'b', 'older']);
    });

    it('row that disappears from renderable is GC\'d from sessionOrder', () => {
        const before = [row('a', 300), row('b', 200), row('c', 100)];
        const after = [row('a', 300), row('c', 100)];
        const { outputs, sessionOrder } = runRenders([before, after]);
        expect(outputs[0]).toEqual(['a', 'b', 'c']);
        expect(outputs[1]).toEqual(['a', 'c']);
        expect(sessionOrder.has('b')).toBe(false);
    });

    it('row reappearing after disappearance is treated as fresh and re-placed by timestamp', () => {
        const r1 = [row('a', 300), row('b', 200), row('c', 100)];
        const r2 = [row('a', 300), row('c', 100)];
        const r3 = [row('a', 300), row('b', 200), row('c', 100)];
        const { outputs } = runRenders([r1, r2, r3]);
        expect(outputs[2]).toEqual(['a', 'b', 'c']);
    });

    it('fresh row equal in timestamp to the head goes to front', () => {
        const olds = [row('a', 300), row('b', 200)];
        const tied = [row('tie', 300), ...olds];
        const { outputs } = runRenders([olds, tied, tied]);
        expect(outputs[1]).toEqual(['tie', 'a', 'b']);
        expect(outputs[2]).toEqual(['tie', 'a', 'b']);
    });

    it('fresh row equal in timestamp to the tail goes to back', () => {
        const olds = [row('a', 300), row('b', 100)];
        const tied = [...olds, row('tie', 100)];
        const { outputs } = runRenders([olds, tied, tied]);
        expect(outputs[1]).toEqual(['a', 'b', 'tie']);
        expect(outputs[2]).toEqual(['a', 'b', 'tie']);
    });

    it('empty renderable produces empty output and clears sessionOrder', () => {
        const before = [row('a', 300), row('b', 200)];
        const { outputs, sessionOrder } = runRenders([before, []]);
        expect(outputs[0]).toEqual(['a', 'b']);
        expect(outputs[1]).toEqual([]);
        expect(sessionOrder.size).toBe(0);
    });

    it('sessionOrder always mirrors the most recent visual order', () => {
        const olds = [row('a', 300), row('b', 200), row('c', 100)];
        const withG1 = [row('g1', 500), ...olds];
        const sessionOrder = new Map<string, number>();
        orderRowsSticky(olds, sessionOrder);
        expect(sessionOrder.get('a')).toBe(0);
        expect(sessionOrder.get('b')).toBe(1);
        expect(sessionOrder.get('c')).toBe(2);
        orderRowsSticky(withG1, sessionOrder);
        expect(sessionOrder.get('g1')).toBe(0);
        expect(sessionOrder.get('a')).toBe(1);
        expect(sessionOrder.get('b')).toBe(2);
        expect(sessionOrder.get('c')).toBe(3);
    });
});
