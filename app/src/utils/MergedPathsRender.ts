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
 *       * Find the **rejoin index** `r` (smallest `r > d` such that the
 *         variation's intermediate position lies on the main line). Because
 *         all input paths end at the same target FEN, every variation
 *         eventually rejoins; in the worst case at `r == p.length`.
 *       * The variation's emitted edges are `p[d..r-1]`. They are inserted
 *         **immediately after** main's edge at index `d` (the move the
 *         variation is an alternative to).
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
 * @param rootFen The starting FEN — used as the position before paths[0][0].
 *                Required so the rejoin search can recognize a variation
 *                that returns directly to the root (which never happens in
 *                legal chess, but the contract is consistent).
 */
export function mergePathsAsVariations(
    paths: Path[],
    rootFen: string,
): MergedPathToken[] {
    if (paths.length === 0) return [];
    const main = paths[0];
    if (main.length === 0) return [];

    // FEN → main-line step index (0 = root, i+1 = position after main[i]).
    const mainPosToStep = new Map<string, number>();
    mainPosToStep.set(rootFen, 0);
    for (let i = 0; i < main.length; i++) {
        mainPosToStep.set(main[i].to, i + 1);
    }

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

        // Rejoin index r: smallest r > d such that p[r-1].to ∈ main positions.
        // Always terminates: target FEN === main's final position, so at worst
        // r = p.length.
        let r = d + 1;
        while (r < p.length && !mainPosToStep.has(p[r - 1].to)) r++;

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
