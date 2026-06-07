/**
 * Generic graph-traversal helpers. The repertoire model is walked from
 * multiple sites (ExplorerService, PendingEditModel, RepertoireGraph) under
 * slightly different node/edge shapes — this module provides one
 * implementation each for forward reachability and shortest-path
 * enumeration so the algorithms cannot drift between consumers.
 *
 * All functions are pure: they neither mutate inputs nor reach for global
 * state. Callers adapt their own data into the `neighbors` callback.
 */

/** An outgoing edge from a node: `from --edge--> to`. */
export interface EdgeRef<N, E> {
    from: N;
    to: N;
    edge: E;
}

/** Yield the outgoing edges of a node. */
export type NeighborFn<N, E> = (node: N) => Iterable<EdgeRef<N, E>>;

/**
 * Set of nodes reachable from `start` (inclusive of `start`). Iterative DFS;
 * `neighborsOf` returns just the destination nodes — use this when callers
 * do not need access to the edge itself.
 */
export function reachableFrom<N>(
    start: N,
    neighborsOf: (node: N) => Iterable<N>,
): Set<N> {
    const visited = new Set<N>([start]);
    const stack: N[] = [start];
    while (stack.length) {
        const cur = stack.pop()!;
        for (const to of neighborsOf(cur)) {
            if (!visited.has(to)) {
                visited.add(to);
                stack.push(to);
            }
        }
    }
    return visited;
}

/**
 * Visit every outgoing edge of every node reachable from `start` (inclusive
 * of `start`). Each `EdgeRef` is delivered to `visit` exactly once. Returns
 * the set of visited nodes for further use by the caller.
 *
 * The traversal is DFS (LIFO) for cache locality; ordering across nodes is
 * not stable and callers must not rely on it.
 */
export function forEachReachableEdge<N, E>(
    start: N,
    neighbors: NeighborFn<N, E>,
    visit: (ref: EdgeRef<N, E>) => void,
): Set<N> {
    const visited = new Set<N>([start]);
    const stack: N[] = [start];
    while (stack.length) {
        const cur = stack.pop()!;
        for (const ref of neighbors(cur)) {
            visit(ref);
            if (!visited.has(ref.to)) {
                visited.add(ref.to);
                stack.push(ref.to);
            }
        }
    }
    return visited;
}

export interface SearchOptions<E> {
    /**
     * Lex key for an edge. Used both to sort the frontier deterministically
     * and to dedupe paths by their key sequence. For chess SANs this is
     * typically `e => e.san`.
     */
    edgeKey: (edge: E) => string;
    /** Stop after collecting this many paths (final results length ≤ limit). */
    limit: number;
    /** Stop after this many frontier-item expansions (defensive bound). */
    maxWork: number;
}

export interface PathEnumerationResult<E> {
    paths: E[][];
    /** True iff enumeration stopped because `limit` or `maxWork` was reached. */
    capped: boolean;
}

/**
 * BFS from `start`, returning up to `limit` shortest paths to any node where
 * `isTarget(node)` holds. Within a single depth, the frontier is sorted by
 * lex of the running edge-key sequence so results emerge shortest-first /
 * lex-smallest. Per-path cycle guard tolerates cycles in the graph.
 *
 * Paths are deduplicated by their edge-key sequence — transpositions can
 * yield distinct traversals that share a SAN sequence.
 *
 * Edges leading *to* a target are not expanded further (no descent past
 * a hit); siblings at the same depth are still considered.
 */
export function enumerateShortestPaths<N, E>(
    start: N,
    isTarget: (node: N) => boolean,
    neighbors: NeighborFn<N, E>,
    { edgeKey, limit, maxWork }: SearchOptions<E>,
): PathEnumerationResult<E> {
    if (isTarget(start)) {
        return { paths: [[]], capped: false };
    }

    interface FrontierItem {
        node: N;
        edges: E[];
        visited: Set<N>;
    }

    const cmpSeq = (a: E[], b: E[]): number => {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const c = edgeKey(a[i]).localeCompare(edgeKey(b[i]));
            if (c !== 0) return c;
        }
        return a.length - b.length;
    };

    let frontier: FrontierItem[] = [{
        node: start,
        edges: [],
        visited: new Set([start]),
    }];
    const results: E[][] = [];
    const seen = new Set<string>();
    let capped = false;
    let work = 0;

    while (frontier.length > 0 && results.length < limit) {
        // Sort the frontier so siblings emerge in lex(SAN-sequence) order.
        frontier.sort((a, b) => cmpSeq(a.edges, b.edges));
        const next: FrontierItem[] = [];
        let outerBreak = false;
        for (const item of frontier) {
            if (results.length >= limit) { capped = true; outerBreak = true; break; }
            if (work >= maxWork) { capped = true; outerBreak = true; break; }
            work += 1;
            // Sort outgoing edges by edgeKey so the first hit on a target
            // from a single parent is deterministically lex-smallest.
            const refs = Array.from(neighbors(item.node));
            refs.sort((a, b) => edgeKey(a.edge).localeCompare(edgeKey(b.edge)));
            for (const ref of refs) {
                if (item.visited.has(ref.to)) continue;
                const newEdges = item.edges.concat(ref.edge);
                if (isTarget(ref.to)) {
                    const key = newEdges.map(edgeKey).join(' ');
                    if (!seen.has(key)) {
                        seen.add(key);
                        results.push(newEdges);
                        if (results.length >= limit) { capped = true; outerBreak = true; break; }
                    }
                    // Don't expand past target — only root→target paths matter.
                    continue;
                }
                const newVisited = new Set(item.visited);
                newVisited.add(ref.to);
                next.push({ node: ref.to, edges: newEdges, visited: newVisited });
            }
            if (outerBreak) break;
        }
        if (outerBreak) break;
        frontier = next;
    }

    // Final sort: shortest-first, lex-by-edge-key tiebreak. The BFS emits
    // paths in this order naturally, but a defensive sort keeps the
    // contract explicit and survives future changes to the loop body.
    results.sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return cmpSeq(a, b);
    });
    return { paths: results, capped };
}

/**
 * Convenience: the lex-smallest shortest path from `start` to the first
 * `isTarget` node, or `null` if none exists within `maxWork`. Returns `[]`
 * when `start` itself satisfies `isTarget`.
 */
export function findCanonicalPath<N, E>(
    start: N,
    isTarget: (node: N) => boolean,
    neighbors: NeighborFn<N, E>,
    options: Omit<SearchOptions<E>, 'limit'>,
): E[] | null {
    const { paths } = enumerateShortestPaths(start, isTarget, neighbors, {
        ...options,
        limit: 1,
    });
    return paths[0] ?? null;
}
