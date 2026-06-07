import { GraphEdge } from '../services/RepertoireGraph';
import { Path } from '../services/ExplorerService';

/**
 * Token stream used to render multiple "How you got here" paths as a single
 * PGN-with-variations line. Consumers walk the array left-to-right and emit:
 *   - `ply`         → a clickable move (main line or variation, distinguished
 *                     by `isMain`). `prefix` is the pre-computed move-number
 *                     prefix (e.g. "1.", "3…", or ""), already accounting for
 *                     intervening variations.
 *   - `open-var`    → render an opening parenthesis "(".
 *   - `close-var`   → render a closing parenthesis ")".
 */
export type MergedPathToken =
    | { kind: 'ply'; edge: GraphEdge; plyDepth: number; isMain: boolean; prefix: string }
    | { kind: 'open-var' }
    | { kind: 'close-var' };

/**
 * Merge a small set of root→target paths into a single PGN-with-variations
 * token stream.
 *
 * Algorithm:
 *   - The first path (`paths[0]`) is the **main line**. Callers should pass
 *     paths in canonical order (shortest first, lex-by-SAN tiebreak) so the
 *     main line is the canonical one.
 *   - For each subsequent path:
 *       * Find the **divergence index** `d` (smallest edge index at which the
 *         path's `to` FEN differs from main's `to` FEN at the same index).
 *       * Find the **rejoin index** `r` by computing the longest trailing run
 *         of edges that are pairwise identical (same `from` and `to` FEN) in
 *         the variation and the main line. Those trailing edges are
 *         redundant — they appear verbatim on main — so the variation drops
 *         them. The variation's emitted edges are `p[d..r-1]`.
 *
 *         We use edge identity (not just FEN membership) so a divergent
 *         intermediate position that *coincidentally* equals some non-rejoin
 *         `main[k].to` (e.g. a transposition through a main square) does not
 *         truncate the variation. The suffix must align all the way to the
 *         target.
 *       * Emitted edges are inserted **immediately after** main's edge at
 *         index `d` (the move the variation is an alternative to).
 *   - Variations are not nested: each non-main path produces exactly one
 *     `(…)` group at the top level of the main line. Multiple non-main paths
 *     that diverge at the same point render as sibling groups `(…)(…)` after
 *     the same main move.
 *
 * Prefix computation honors the standard PGN rule that a black ply
 * immediately following its matching white ply on the same line omits the
 * move number — except that a variation intervening between them forces the
 * next black main ply to carry its full `N…SAN` prefix, as is conventional
 * in published game notation.
 *
 * @param paths   Ordered list of paths (paths[0] is the main line).
 * @param _rootFen The starting FEN. Currently unused by the merge algorithm
 *                 but kept in the signature for callers that pass it for
 *                 documentation/symmetry with sibling utilities.
 */
export function mergePathsAsVariations(
    paths: Path[],
    _rootFen: string,
): MergedPathToken[] {
    if (paths.length === 0) return [];
    const main = paths[0];
    if (main.length === 0) return [];

    // Variations grouped by the main-edge index they appear *after*.
    const variationsByMainIdx = new Map<number, GraphEdge[][]>();

    for (let pi = 1; pi < paths.length; pi++) {
        const p = paths[pi];
        if (p.length === 0) continue;

        // Divergence index d: smallest i where p[i].to !== main[i].to.
        let d = 0;
        const minLen = Math.min(p.length, main.length);
        while (d < minLen && p[d].to === main[d].to) d++;
        if (d >= p.length) continue;

        // Longest common trailing run by edge identity (same from + to). At
        // step s from the end the edges are main[M-1-s] and p[P-1-s]; once
        // they diverge we stop. `from` is checked explicitly so the topmost
        // suffix edge is verified to be the same move, not just a move that
        // happens to land on the same FEN.
        let s = 0;
        while (s < Math.min(p.length, main.length)) {
            const me = main[main.length - 1 - s];
            const ve = p[p.length - 1 - s];
            if (me.from !== ve.from || me.to !== ve.to) break;
            s++;
        }

        // Always keep at least one edge after the divergence — the move that
        // the variation is presenting as an alternative.
        const r = Math.max(d + 1, p.length - s);

        const variationEdges = p.slice(d, r);
        if (variationEdges.length === 0) continue;

        const list = variationsByMainIdx.get(d) ?? [];
        list.push(variationEdges);
        variationsByMainIdx.set(d, list);
    }

    const tokens: MergedPathToken[] = [];
    let lastMainPlyDepth: number | null = null;
    let variationSinceLastMainPly = false;

    for (let i = 0; i < main.length; i++) {
        const depth = i + 1;
        tokens.push({
            kind: 'ply',
            edge: main[i],
            plyDepth: depth,
            isMain: true,
            prefix: computePrefix(depth, lastMainPlyDepth, variationSinceLastMainPly, i === 0),
        });
        lastMainPlyDepth = depth;
        variationSinceLastMainPly = false;

        const vars = variationsByMainIdx.get(i);
        if (vars) {
            for (const variationEdges of vars) {
                tokens.push({ kind: 'open-var' });
                let lastVarDepth: number | null = null;
                for (let j = 0; j < variationEdges.length; j++) {
                    const vDepth = depth + j;
                    tokens.push({
                        kind: 'ply',
                        edge: variationEdges[j],
                        plyDepth: vDepth,
                        isMain: false,
                        prefix: computePrefix(vDepth, lastVarDepth, false, j === 0),
                    });
                    lastVarDepth = vDepth;
                }
                tokens.push({ kind: 'close-var' });
            }
            variationSinceLastMainPly = true;
        }
    }

    return tokens;
}

function computePrefix(
    depth: number,
    prevDepth: number | null,
    variationSincePrev: boolean,
    isFirst: boolean,
): string {
    const isWhite = depth % 2 === 1;
    const moveNumber = Math.ceil(depth / 2);
    if (isWhite) return `${moveNumber}.`;
    if (isFirst || prevDepth === null) return `${moveNumber}\u2026`;
    const canDropPrefix =
        !variationSincePrev &&
        prevDepth === depth - 1 &&
        prevDepth % 2 === 1;
    return canDropPrefix ? '' : `${moveNumber}\u2026`;
}
