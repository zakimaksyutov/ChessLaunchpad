import { describe, it, expect } from 'vitest';
import { mergePathsAsVariations, MergedPathToken } from './MergedPathsRender';
import { GraphEdge } from '../services/RepertoireGraph';
import { Path } from '../services/ExplorerService';

function E(from: string, to: string, san: string): GraphEdge {
    return { from, to, san, hasCard: false, cardKey: '', orientations: new Set() };
}

function render(tokens: MergedPathToken[]): string {
    const out: string[] = [];
    for (const t of tokens) {
        if (t.kind === 'open-var') out.push('(');
        else if (t.kind === 'close-var') out.push(')');
        else out.push(t.prefix + t.edge.san);
    }
    return out.join(' ')
        .replace(/\( /g, '(')
        .replace(/ \)/g, ')');
}

function san(tokens: MergedPathToken[]): string[] {
    return tokens.flatMap(t => (t.kind === 'ply' ? [t.edge.san] : []));
}

describe('mergePathsAsVariations', () => {
    const ROOT = 'fen:root';

    it('returns empty for empty input', () => {
        expect(mergePathsAsVariations([], ROOT)).toEqual([]);
    });

    it('returns empty when the single path is empty (root case)', () => {
        // Caller filters this; the utility should be robust either way.
        expect(mergePathsAsVariations([[]], ROOT)).toEqual([]);
    });

    it('single path → main-only token stream with standard PGN prefixes', () => {
        const path: Path = [
            E(ROOT, 'A', 'e4'),
            E('A', 'B', 'e5'),
            E('B', 'C', 'Nf3'),
            E('C', 'D', 'Nc6'),
        ];
        const tokens = mergePathsAsVariations([path], ROOT);
        expect(tokens.every(t => t.kind === 'ply')).toBe(true);
        expect(render(tokens)).toBe('1.e4 e5 2.Nf3 Nc6');
        // All plies are main.
        for (const t of tokens) {
            if (t.kind === 'ply') expect(t.isMain).toBe(true);
        }
    });

    it('two paths that rejoin: variation segment stops at the rejoin position', () => {
        // Main:  R - A - B - C - D - E - F - G   (sans: a, b, c, d, e, f, g)
        // Var:   R - A - B - X - Y - Z - F - G   (sans: a, b, c2, d2, e2, f, g)
        //                ^ diverges at index 2; rejoins at position F (index 5 in var
        //                  → var[5].to = F, so r = 6).
        const main: Path = [
            E(ROOT, 'A', 'a'),
            E('A', 'B', 'b'),
            E('B', 'C', 'c'),
            E('C', 'D', 'd'),
            E('D', 'E', 'e'),
            E('E', 'F', 'f'),
            E('F', 'G', 'g'),
        ];
        const variation: Path = [
            E(ROOT, 'A', 'a'),
            E('A', 'B', 'b'),
            E('B', 'X', 'c2'),
            E('X', 'Y', 'd2'),
            E('Y', 'Z', 'e2'),
            E('Z', 'F', 'f2'),
            E('F', 'G', 'g'),
        ];
        const tokens = mergePathsAsVariations([main, variation], ROOT);

        // Sequence-of-kinds: 3 main, open, 4 var, close, 4 main.
        const kinds = tokens.map(t => t.kind);
        expect(kinds).toEqual([
            'ply', 'ply', 'ply',
            'open-var', 'ply', 'ply', 'ply', 'ply', 'close-var',
            'ply', 'ply', 'ply', 'ply',
        ]);

        // The variation must NOT contain the shared suffix `f g`.
        const varSlice = tokens.slice(3, 9);
        const varSans = san(varSlice);
        expect(varSans).toEqual(['c2', 'd2', 'e2', 'f2']);
        // Main slice after variation continues with d, e, f, g.
        expect(san(tokens.slice(9))).toEqual(['d', 'e', 'f', 'g']);
    });

    it('variation that never rejoins before target spans up to the final edge', () => {
        // Paths diverge at the first move; both end at target T.
        const main: Path = [
            E(ROOT, 'A1', 'e4'),
            E('A1', 'B1', 'c5'),
            E('B1', 'T', 'Nf3'),
        ];
        const variation: Path = [
            E(ROOT, 'A2', 'Nf3'),
            E('A2', 'B2', 'c5'),
            E('B2', 'T', 'e4'),
        ];
        const tokens = mergePathsAsVariations([main, variation], ROOT);
        // Variation segment must include all 3 var edges (target is the rejoin).
        const kinds = tokens.map(t => t.kind);
        expect(kinds).toEqual([
            'ply',
            'open-var', 'ply', 'ply', 'ply', 'close-var',
            'ply', 'ply',
        ]);
        const varSans = san(tokens.slice(1, 5));
        expect(varSans).toEqual(['Nf3', 'c5', 'e4']);
    });

    it('three paths diverging at the same point render as sibling variations', () => {
        // Main:  R - A - B - C   (sans: e4, e5, Nf3)
        // Var1:  R - A - X - C   (sans: e4, c5, Nf3)
        // Var2:  R - A - Y - C   (sans: e4, Nc6, Nf3)
        const main: Path = [
            E(ROOT, 'A', 'e4'),
            E('A', 'B', 'e5'),
            E('B', 'C', 'Nf3'),
        ];
        const var1: Path = [
            E(ROOT, 'A', 'e4'),
            E('A', 'X', 'c5'),
            E('X', 'C', 'Nf3'),
        ];
        const var2: Path = [
            E(ROOT, 'A', 'e4'),
            E('A', 'Y', 'Nc6'),
            E('Y', 'C', 'Nf3'),
        ];
        const tokens = mergePathsAsVariations([main, var1, var2], ROOT);
        // Pattern: ply(e4) ply(e5) open ply(c5) ply(Nf3) close open ply(Nc6) ply(Nf3) close ply(Nf3)
        const kinds = tokens.map(t => t.kind);
        expect(kinds).toEqual([
            'ply', 'ply',
            'open-var', 'ply', 'ply', 'close-var',
            'open-var', 'ply', 'ply', 'close-var',
            'ply',
        ]);
        // Variation 1: 1…c5 2.Nf3   (var rejoins at target → both moves emitted)
        const t3 = tokens[3];
        const t4 = tokens[4];
        if (t3.kind !== 'ply' || t4.kind !== 'ply') throw new Error('unexpected token kinds');
        expect(t3.prefix + t3.edge.san).toBe('1\u2026c5');
        expect(t4.prefix + t4.edge.san).toBe('2.Nf3');
        // Variation 2: 1…Nc6 2.Nf3
        const t7 = tokens[7];
        const t8 = tokens[8];
        if (t7.kind !== 'ply' || t8.kind !== 'ply') throw new Error('unexpected token kinds');
        expect(t7.prefix + t7.edge.san).toBe('1\u2026Nc6');
        expect(t8.prefix + t8.edge.san).toBe('2.Nf3');
    });

    it('main black ply that follows a variation regains its full move-number prefix', () => {
        // Main:  R - A - B - C   (sans: e4, e5, Nf3)  - normally renders as "1.e4 e5 2.Nf3"
        // Var:   R - X - Y - C   (sans: d4, d5, Nf3)  - diverges at index 0
        //
        // Variation appears AFTER main[0] (= 1.e4), so the next main ply (1...e5)
        // becomes `1…e5` rather than the bare `e5` it would normally be.
        const main: Path = [
            E(ROOT, 'A', 'e4'),
            E('A', 'B', 'e5'),
            E('B', 'C', 'Nf3'),
        ];
        const variation: Path = [
            E(ROOT, 'X', 'd4'),
            E('X', 'Y', 'd5'),
            E('Y', 'C', 'Nf3'),
        ];
        const tokens = mergePathsAsVariations([main, variation], ROOT);
        const rendered = render(tokens);
        expect(rendered).toBe('1.e4 (1.d4 d5 2.Nf3) 1\u2026e5 2.Nf3');
    });

    it('matches the screenshot example: Ruy Lopez transposition via 5.O-O', () => {
        // Reproduces the example from the user-provided screenshot. Both paths
        // reach the same FEN after 9.d3 d6 in the Ruy Lopez Closed.
        //
        // Main:   e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O b5 Bb3 Be7 Re1 O-O a4 Bb7 d3 d6
        // Var:    e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O a4 Bb7 d3 d6
        //
        // In actual chess the variation rejoins the main line ONE PLY before
        // the trailing common suffix begins: the position after main's 7.Re1
        // (black to move, with bishop on b3, knight f3, …) is identical to the
        // position after var's 7.Bb3 (same pieces, same squares, black to move).
        // Both then play 7…O-O reaching the same M14 position. So the variation
        // segment is just `5…Be7 6.Re1 b5 7.Bb3` (4 plies) — the shared `7…O-O`
        // is emitted only once, on the main line.
        const mainSans = ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','b5','Bb3','Be7','Re1','O-O','a4','Bb7','d3','d6'];
        const varSans  = ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','O-O','a4','Bb7','d3','d6'];

        // Position sequence: shared P0..P9 (5.O-O), then divergent V10..V12,
        // then var's P13 (after var's 7.Bb3) equals main's P13 (after main's
        // 7.Re1), and both paths share everything from index 13 onwards.
        const mainPositions = Array.from({ length: mainSans.length + 1 }, (_, i) =>
            i <= 9 ? `S${i}` : `M${i}`);
        const varPositions = mainPositions.slice();
        for (let i = 10; i <= 12; i++) varPositions[i] = `V${i}`;
        for (let i = 13; i <= mainSans.length; i++) varPositions[i] = mainPositions[i];

        const main: Path = mainSans.map((s, i) => E(mainPositions[i], mainPositions[i + 1], s));
        const variation: Path = varSans.map((s, i) => E(varPositions[i], varPositions[i + 1], s));

        const tokens = mergePathsAsVariations([main, variation], ROOT);
        const rendered = render(tokens);
        expect(rendered).toBe(
            '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O b5 ' +
            '(5\u2026Be7 6.Re1 b5 7.Bb3) ' +
            '6.Bb3 Be7 7.Re1 O-O 8.a4 Bb7 9.d3 d6',
        );
        // Sanity: every variation token is marked non-main.
        let inVar = false;
        for (const t of tokens) {
            if (t.kind === 'open-var') inVar = true;
            else if (t.kind === 'close-var') inVar = false;
            else expect(t.isMain).toBe(!inVar);
        }
    });

    it('paths[1] identical to main is ignored (no empty variation emitted)', () => {
        const path: Path = [
            E(ROOT, 'A', 'e4'),
            E('A', 'B', 'e5'),
        ];
        const tokens = mergePathsAsVariations([path, [...path]], ROOT);
        expect(tokens.every(t => t.kind === 'ply')).toBe(true);
        expect(render(tokens)).toBe('1.e4 e5');
    });

    it('phantom rejoin: divergent intermediate FEN that coincides with a non-rejoin main position does not truncate the variation', () => {
        // Main:  R - A - B - C - D - T   (sans: a, b, c, d, e)
        // Var:   R - X - C - Y - Z - T   (sans: a2, b2, c2, d2, e2)
        //
        // var[1].to == 'C' == main[2].to (a transposition through a main square,
        // but NOT the variation's true rejoin point). With the old
        // membership-based rejoin search, the variation would be truncated to
        // [a2, b2] and the moves c2/d2/e2 leading to target would be dropped.
        // With suffix-by-edge-identity, the trailing run has length 0 (var's
        // last edge has .from='Z', main's has .from='D'), so the variation
        // spans all 5 edges.
        const main: Path = [
            E(ROOT, 'A', 'a'),
            E('A', 'B', 'b'),
            E('B', 'C', 'c'),
            E('C', 'D', 'd'),
            E('D', 'T', 'e'),
        ];
        const variation: Path = [
            E(ROOT, 'X', 'a2'),
            E('X', 'C', 'b2'),
            E('C', 'Y', 'c2'),
            E('Y', 'Z', 'd2'),
            E('Z', 'T', 'e2'),
        ];
        const tokens = mergePathsAsVariations([main, variation], ROOT);
        // Variation must contain all 5 divergent edges, not just the first two.
        const varSlice = tokens.slice(1, tokens.findIndex(t => t.kind === 'close-var') + 1);
        const varSans = san(varSlice);
        expect(varSans).toEqual(['a2', 'b2', 'c2', 'd2', 'e2']);
    });
});
