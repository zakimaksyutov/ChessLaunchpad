import { describe, it, expect } from 'vitest';
import {
    reachableFrom,
    forEachReachableEdge,
    enumerateShortestPaths,
    findCanonicalPath,
    type NeighborFn,
    type EdgeRef,
} from './PathSearch';

// ── Helpers ──────────────────────────────────────────────────────────

// A tiny string-keyed graph for testing.
type Adj = Record<string, Array<{ to: string; san: string }>>;

function makeNeighbors(adj: Adj): NeighborFn<string, string> {
    return (node: string): EdgeRef<string, string>[] =>
        (adj[node] ?? []).map(e => ({ from: node, to: e.to, edge: e.san }));
}

function makeNeighborsNode(adj: Adj): (node: string) => string[] {
    return (node: string) => (adj[node] ?? []).map(e => e.to);
}

// ── reachableFrom ────────────────────────────────────────────────────

describe('reachableFrom', () => {
    it('returns just the start node for an isolated graph', () => {
        const r = reachableFrom('A', makeNeighborsNode({}));
        expect([...r]).toEqual(['A']);
    });

    it('walks a simple DAG to completion', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'x' }, { to: 'C', san: 'y' }],
            B: [{ to: 'D', san: 'z' }],
            C: [{ to: 'D', san: 'w' }],
        };
        const r = reachableFrom('A', makeNeighborsNode(adj));
        expect([...r].sort()).toEqual(['A', 'B', 'C', 'D']);
    });

    it('terminates on cycles', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'x' }],
            B: [{ to: 'A', san: 'y' }, { to: 'C', san: 'z' }],
            C: [],
        };
        const r = reachableFrom('A', makeNeighborsNode(adj));
        expect([...r].sort()).toEqual(['A', 'B', 'C']);
    });
});

// ── forEachReachableEdge ─────────────────────────────────────────────

describe('forEachReachableEdge', () => {
    it('visits every outgoing edge of every reachable node exactly once', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'x' }, { to: 'C', san: 'y' }],
            B: [{ to: 'D', san: 'z' }],
            C: [{ to: 'D', san: 'w' }],
            D: [],
        };
        const seen: string[] = [];
        const visited = forEachReachableEdge(
            'A',
            makeNeighbors(adj),
            ref => { seen.push(`${ref.from}-${ref.edge}->${ref.to}`); },
        );
        expect([...visited].sort()).toEqual(['A', 'B', 'C', 'D']);
        expect(seen.sort()).toEqual(['A-x->B', 'A-y->C', 'B-z->D', 'C-w->D']);
    });

    it('handles cycles without revisiting nodes', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'x' }],
            B: [{ to: 'A', san: 'y' }],
        };
        let visitCount = 0;
        forEachReachableEdge('A', makeNeighbors(adj), () => { visitCount += 1; });
        // 2 edges total: A->B and B->A. Both are visited; cycle is harmless.
        expect(visitCount).toBe(2);
    });
});

// ── enumerateShortestPaths ───────────────────────────────────────────

describe('enumerateShortestPaths', () => {
    it('returns [[]] when start is the target', () => {
        const r = enumerateShortestPaths('A', n => n === 'A', makeNeighbors({}), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        expect(r.paths).toEqual([[]]);
        expect(r.capped).toBe(false);
    });

    it('finds the single shortest path', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'e4' }],
            B: [{ to: 'C', san: 'e5' }],
            C: [],
        };
        const r = enumerateShortestPaths('A', n => n === 'C', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        expect(r.paths).toEqual([['e4', 'e5']]);
        expect(r.capped).toBe(false);
    });

    it('breaks ties by lex(edge-key sequence) — depth-1 case', () => {
        const adj: Adj = {
            A: [
                { to: 'T', san: 'c' },
                { to: 'T', san: 'b' },
                { to: 'T', san: 'a' },
            ],
        };
        const r = enumerateShortestPaths('A', n => n === 'T', makeNeighbors(adj), {
            edgeKey: e => e, limit: 3, maxWork: 100,
        });
        // dedup by edge-key sequence keeps all three (different keys), sorted lex.
        expect(r.paths).toEqual([['a'], ['b'], ['c']]);
    });

    it('breaks ties by lex(edge-key sequence) — deeper paths', () => {
        // Two same-length paths A->C: via "b,d" vs "a,e".
        const adj: Adj = {
            A: [{ to: 'B1', san: 'b' }, { to: 'B2', san: 'a' }],
            B1: [{ to: 'C', san: 'd' }],
            B2: [{ to: 'C', san: 'e' }],
        };
        const r = enumerateShortestPaths('A', n => n === 'C', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        // Both length-2; 'a e' < 'b d' lex.
        expect(r.paths).toEqual([['a', 'e'], ['b', 'd']]);
    });

    it('returns shortest paths first across depths', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'x' }, { to: 'T', san: 'z' }],
            B: [{ to: 'T', san: 'y' }],
        };
        const r = enumerateShortestPaths('A', n => n === 'T', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        expect(r.paths).toEqual([['z'], ['x', 'y']]);
    });

    it('dedupes paths whose edge-key sequence already appeared', () => {
        // Two distinct traversals A->T via the same SAN sequence "e4 e5".
        // We model this by two parallel B-nodes that share outgoing labels.
        const adj: Adj = {
            A: [{ to: 'B1', san: 'e4' }, { to: 'B2', san: 'e4' }],
            B1: [{ to: 'T', san: 'e5' }],
            B2: [{ to: 'T', san: 'e5' }],
        };
        const r = enumerateShortestPaths('A', n => n === 'T', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        // The two structurally distinct paths share the same SAN sequence — dedup to one.
        expect(r.paths).toEqual([['e4', 'e5']]);
    });

    it('honors the per-path cycle guard', () => {
        const adj: Adj = {
            A: [{ to: 'B', san: 'x' }],
            B: [{ to: 'A', san: 'y' }, { to: 'T', san: 'z' }],
        };
        const r = enumerateShortestPaths('A', n => n === 'T', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        expect(r.paths).toEqual([['x', 'z']]);
        expect(r.capped).toBe(false);
    });

    it('flags capped when the result limit is reached', () => {
        const adj: Adj = {
            A: [
                { to: 'T', san: 'a' },
                { to: 'T', san: 'b' },
                { to: 'T', san: 'c' },
                { to: 'T', san: 'd' },
            ],
        };
        const r = enumerateShortestPaths('A', n => n === 'T', makeNeighbors(adj), {
            edgeKey: e => e, limit: 2, maxWork: 100,
        });
        expect(r.paths).toEqual([['a'], ['b']]);
        expect(r.capped).toBe(true);
    });

    it('flags capped when maxWork is exhausted before completion', () => {
        // Long chain — target is depth 5, but maxWork only allows 2 expansions.
        const adj: Adj = {
            A: [{ to: 'B', san: '1' }],
            B: [{ to: 'C', san: '2' }],
            C: [{ to: 'D', san: '3' }],
            D: [{ to: 'T', san: '4' }],
        };
        const r = enumerateShortestPaths('A', n => n === 'T', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 2,
        });
        expect(r.paths).toEqual([]);
        expect(r.capped).toBe(true);
    });

    it('returns empty/not-capped when target is genuinely unreachable', () => {
        const adj: Adj = { A: [{ to: 'B', san: 'x' }] };
        const r = enumerateShortestPaths('A', n => n === 'Z', makeNeighbors(adj), {
            edgeKey: e => e, limit: 5, maxWork: 100,
        });
        expect(r.paths).toEqual([]);
        expect(r.capped).toBe(false);
    });
});

// ── findCanonicalPath ────────────────────────────────────────────────

describe('findCanonicalPath', () => {
    it('returns [] for the trivial start=target case', () => {
        expect(findCanonicalPath('A', n => n === 'A', makeNeighbors({}), {
            edgeKey: e => e, maxWork: 100,
        })).toEqual([]);
    });

    it('returns the lex-smallest shortest path', () => {
        const adj: Adj = {
            A: [{ to: 'B1', san: 'b' }, { to: 'B2', san: 'a' }],
            B1: [{ to: 'C', san: 'd' }],
            B2: [{ to: 'C', san: 'e' }],
        };
        expect(findCanonicalPath('A', n => n === 'C', makeNeighbors(adj), {
            edgeKey: e => e, maxWork: 100,
        })).toEqual(['a', 'e']);
    });

    it('returns null when the target is unreachable', () => {
        expect(findCanonicalPath('A', n => n === 'Z', makeNeighbors({}), {
            edgeKey: e => e, maxWork: 100,
        })).toBeNull();
    });
});
