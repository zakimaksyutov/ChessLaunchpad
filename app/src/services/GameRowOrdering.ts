/**
 * Sticky-session ordering for the /games page row list.
 *
 * Known rows (seen on a prior render) keep their slot. Fresh rows are
 * placed by timestamp relative to the current bounds: newer-than-head
 * goes to front, older-than-tail to back, otherwise inserted by `t`.
 *
 * After each call, `sessionOrder` is rebuilt to mirror the visual
 * order — so the slot index of any key is its position in the most
 * recent render. This is the invariant that keeps a fresh row sticky
 * at the top: on the next render it is the front-most `known` row.
 */

export interface OrderableRow<T> {
    readonly key: string;
    /** Sort timestamp (epoch ms). Newer = larger. */
    readonly t: number;
    readonly payload: T;
}

export function orderRowsSticky<T>(
    renderable: ReadonlyArray<OrderableRow<T>>,
    sessionOrder: Map<string, number>,
    _reannotatingKeys: ReadonlySet<string> = new Set(),
): OrderableRow<T>[] {
    const known: OrderableRow<T>[] = [];
    const fresh: OrderableRow<T>[] = [];
    for (const row of renderable) {
        if (sessionOrder.has(row.key)) {
            known.push(row);
        } else {
            fresh.push(row);
        }
    }
    known.sort((a, b) => sessionOrder.get(a.key)! - sessionOrder.get(b.key)!);
    fresh.sort((a, b) => b.t - a.t);

    let combined: OrderableRow<T>[];
    if (known.length === 0) {
        combined = fresh;
    } else {
        const headT = known[0].t;
        const tailT = known[known.length - 1].t;
        const front: OrderableRow<T>[] = [];
        const back: OrderableRow<T>[] = [];
        const middle: OrderableRow<T>[] = [];
        for (const row of fresh) {
            if (row.t >= headT) front.push(row);
            else if (row.t <= tailT) back.push(row);
            else middle.push(row);
        }
        const merged: OrderableRow<T>[] = [];
        let mi = 0;
        for (const k of known) {
            while (mi < middle.length && middle[mi].t > k.t) {
                merged.push(middle[mi]);
                mi++;
            }
            merged.push(k);
        }
        while (mi < middle.length) {
            merged.push(middle[mi]);
            mi++;
        }
        combined = [...front, ...merged, ...back];
    }

    sessionOrder.clear();
    for (let i = 0; i < combined.length; i++) {
        sessionOrder.set(combined[i].key, i);
    }
    return combined;
}

