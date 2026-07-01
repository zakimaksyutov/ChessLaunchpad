import { describe, it, expect } from 'vitest';
import {
    partitionAnnotationIntoSections,
    findPivotMoveIndex,
    GameSection,
    GameSectionKind,
} from './GameAnnotationSections';
import {
    AnnotatedMove,
    GameAnnotation,
    buildAnnotationFromFrozen,
} from './GameAnnotationService';
import { EvalDropCategory } from './EvalDropService';
import { FrozenAnnotation } from '../models/RepertoireData';

/** Map a stored `hl` code to a user move's highlight (mirrors codeToHighlight). */
function userMoveFromCode(code: number, idx: number): AnnotatedMove {
    const base = { san: `u${idx}`, isWhiteMove: idx % 2 === 0, isUserMove: true } as const;
    switch (code) {
        case 0: return { ...base, highlight: 'in-repertoire' };
        case 1: return { ...base, highlight: 'deviation' };
        case 2: return { ...base, highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'ok' } };
        case 3: return { ...base, highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'inaccuracy' } };
        case 4: return { ...base, highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'mistake' } };
        case 5: return { ...base, highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'blunder' } };
        default: return { ...base, highlight: 'out-of-theory' };
    }
}

/**
 * Build an annotation from a compact spec string. Tokens: `u<code>` for a user
 * move with that `hl` code, `o` for an opponent move (always neutral). e.g.
 * `"u0 o u2 o u4"`.
 */
function mk(spec: string): GameAnnotation {
    const moves: AnnotatedMove[] = spec.trim().split(/\s+/).filter(Boolean).map((tok, idx) => {
        if (tok === 'o') {
            return { san: `o${idx}`, isWhiteMove: idx % 2 === 0, isUserMove: false, highlight: 'out-of-theory' };
        }
        return userMoveFromCode(Number(tok.slice(1)), idx);
    });
    return { moves, miniBoardFen: '', miniBoardPly: 0, miniBoardOrientation: 'white' };
}

function kinds(sections: GameSection[]): GameSectionKind[] {
    return sections.map(s => s.kind);
}

/** Flatten section moves back to a SAN list to assert partition completeness. */
function flat(sections: GameSection[]): string[] {
    return sections.flatMap(s => s.moves.map(m => m.san));
}

describe('partitionAnnotationIntoSections', () => {
    it('returns no sections for an empty annotation', () => {
        expect(partitionAnnotationIntoSections(mk(''))).toEqual([]);
    });

    it('groups a fully in-book game into a single in-repertoire section', () => {
        const sections = partitionAnnotationIntoSections(mk('u0 o u0 o u0'));
        expect(kinds(sections)).toEqual(['in-repertoire']);
        expect(sections[0].moves).toHaveLength(5);
    });

    it('splits an EOT eval-drop game into in-repertoire / off-prep / pivot', () => {
        // book, book, opponent leaves (still theory) → ok, then a mistake.
        const sections = partitionAnnotationIntoSections(mk('u0 o u0 o u2 o u4'));
        expect(kinds(sections)).toEqual(['in-repertoire', 'off-prep', 'pivot']);
    });

    it('leads off-prep with the opponent departing move; pivot stands alone', () => {
        const sections = partitionAnnotationIntoSections(mk('u0 o u0 o u2 o u4'));
        expect(sections[0].moves.map(m => m.san)).toEqual(['u0', 'o1', 'u2']);
        expect(sections[1].moves.map(m => m.san)).toEqual(['o3', 'u4', 'o5']);
        expect(sections[2].moves.map(m => m.san)).toEqual(['u6']);
        expect(sections[2].pivotKind).toBe('mistake');
    });

    it('marks a deviation as the pivot and routes the tail to out-of-theory', () => {
        const sections = partitionAnnotationIntoSections(mk('u0 o u1 o u7'));
        expect(kinds(sections)).toEqual(['in-repertoire', 'pivot', 'out-of-theory']);
        expect(sections[1].pivotKind).toBe('deviation');
        // Opponent move after the pivot leads the out-of-theory tail.
        expect(sections[2].moves.map(m => m.san)).toEqual(['o3', 'u4']);
    });

    it('handles getting back to repertoire after the pivot (transposition)', () => {
        // book → opp leaves (off-prep) → blunder → opp transposes back → back in book.
        const sections = partitionAnnotationIntoSections(mk('u0 o u2 o u5 o u0 o u0'));
        expect(kinds(sections)).toEqual(['in-repertoire', 'off-prep', 'pivot', 'back-to-repertoire']);
        expect(sections[2].pivotKind).toBe('blunder');
        // The transposing opponent move leads the back-to-repertoire section.
        expect(sections[3].moves.map(m => m.san)).toEqual(['o5', 'u6', 'o7', 'u8']);
    });

    it('can leave known theory without a user pivot (no pivot section)', () => {
        const sections = partitionAnnotationIntoSections(mk('u0 o u0 o u7'));
        expect(kinds(sections)).toEqual(['in-repertoire', 'out-of-theory']);
        expect(sections.find(s => s.kind === 'pivot')).toBeUndefined();
    });

    it('keeps the pivot standing alone when Black\'s first move is the pivot', () => {
        // Opening opponent move has no preceding user move; it must NOT be
        // absorbed into the pivot section (regression: it used to render a grey
        // opponent move under a "You left your repertoire" header).
        const sections = partitionAnnotationIntoSections(mk('o u1 o u7'));
        expect(kinds(sections)).toEqual(['in-repertoire', 'pivot', 'out-of-theory']);
        expect(sections[0].moves.map(m => m.san)).toEqual(['o0']);
        expect(sections[1].moves.map(m => m.san)).toEqual(['u1']);
        expect(sections[1].pivotKind).toBe('deviation');
    });

    it('keeps an eval-drop pivot alone when it is Black\'s first move', () => {
        // Code 3/4/5 means the opponent already took the game off prep, so the
        // opening opponent move is labeled off-prep (not in-repertoire).
        const sections = partitionAnnotationIntoSections(mk('o u3 o u7'));
        expect(kinds(sections)).toEqual(['off-prep', 'pivot', 'out-of-theory']);
        expect(sections[0].moves.map(m => m.san)).toEqual(['o0']);
        expect(sections[1].moves.map(m => m.san)).toEqual(['u1']);
        expect(sections[1].pivotKind).toBe('inaccuracy');
    });

    it('labels a clean off-prep → back-to-book return as back-to-repertoire', () => {
        // No pivot: book → opponent leaves prep (still theory), user ok →
        // opponent transposes back → user back in book. The return is
        // back-to-repertoire, led by the transposing opponent move.
        const sections = partitionAnnotationIntoSections(mk('u0 o u2 o u0'));
        expect(kinds(sections)).toEqual(['in-repertoire', 'off-prep', 'back-to-repertoire']);
        expect(sections[2].moves.map(m => m.san)).toEqual(['o3', 'u4']);
        expect(sections.find(s => s.kind === 'pivot')).toBeUndefined();
    });

    it('captures the inaccuracy category on the pivot', () => {
        const sections = partitionAnnotationIntoSections(mk('u0 o u2 o u3'));
        expect(sections.find(s => s.kind === 'pivot')?.pivotKind).toBe('inaccuracy');
    });

    it('joins a leading opponent move (user is black) to the first section', () => {
        const ann = mk('o u0 o u0');
        // Force black orientation; the leading white move must join in-repertoire.
        const sections = partitionAnnotationIntoSections(ann);
        expect(kinds(sections)).toEqual(['in-repertoire']);
        expect(sections[0].moves).toHaveLength(4);
    });

    it('only ever produces a single pivot section', () => {
        // A second deviation after the pivot is folded into the tail.
        const sections = partitionAnnotationIntoSections(mk('u0 o u1 o u1 o u7'));
        expect(sections.filter(s => s.kind === 'pivot')).toHaveLength(1);
    });

    it.each([
        'u0 o u0 o u0',
        'u0 o u0 o u2 o u4',
        'u0 o u2 o u0',
        'u0 o u2 o u5 o u0 o u0',
        'o u0 o u1 o u7',
    ])('partitions cover every move exactly once (%s)', (spec) => {
        const ann = mk(spec);
        const sections = partitionAnnotationIntoSections(ann);
        expect(flat(sections)).toEqual(ann.moves.map(m => m.san));
    });

    it('works end-to-end on a thawed frozen annotation', () => {
        const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3'];
        const fan: FrozenAnnotation = { hl: [0, 0, 2, 4], mb: 0 };
        const annotation = buildAnnotationFromFrozen(fan, sans, 'white');
        const sections = partitionAnnotationIntoSections(annotation);
        expect(kinds(sections)).toEqual(['in-repertoire', 'off-prep', 'pivot']);
        expect(sections[0].moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3']);
        expect(sections[1].moves.map(m => m.san)).toEqual(['Nc6', 'Bc4', 'Bc5']);
        expect(sections[2].moves.map(m => m.san)).toEqual(['d3']);
        expect(sections[2].pivotKind).toBe('mistake');
    });
});

describe('findPivotMoveIndex', () => {
    it('returns the first eval-drop user move index', () => {
        expect(findPivotMoveIndex(mk('u0 o u0 o u2 o u4').moves)).toBe(6);
    });

    it('returns the first deviation user move index', () => {
        expect(findPivotMoveIndex(mk('u0 o u1 o u7').moves)).toBe(2);
    });

    it('returns -1 when there is no pivot', () => {
        expect(findPivotMoveIndex(mk('u0 o u0 o u2').moves)).toBe(-1);
    });
});

describe('partitionAnnotationIntoSections — pivotStartIndex (fix-diverges-early)', () => {
    // Base game: in-repertoire → off-prep (ok) → mistake. The off-prep user move
    // (san u4) is at ply 4; the mistake (san u6) at ply 6.
    const SPEC = 'u0 o u0 o u2 o u4';

    it('extends the pivot section back to the divergence ply', () => {
        const sections = partitionAnnotationIntoSections(mk(SPEC), 4);
        expect(kinds(sections)).toEqual(['in-repertoire', 'off-prep', 'pivot']);
        // The off-prep user move + its opponent reply + the mistake are pulled
        // into the one red pivot section; off-prep keeps only the opponent move
        // that took the game off book.
        expect(sections[2].moves.map(m => m.san)).toEqual(['u4', 'o5', 'u6']);
        expect(sections[1].moves.map(m => m.san)).toEqual(['o3']);
        expect(sections[2].pivotKind).toBe('mistake');
    });

    it('covers every move exactly once after extension', () => {
        const ann = mk(SPEC);
        const sections = partitionAnnotationIntoSections(ann, 4);
        expect(flat(sections)).toEqual(ann.moves.map(m => m.san));
    });

    it('is a no-op when pivotStartIndex is at or after the natural pivot', () => {
        const base = partitionAnnotationIntoSections(mk(SPEC));
        expect(partitionAnnotationIntoSections(mk(SPEC), 6)).toEqual(base);
        expect(partitionAnnotationIntoSections(mk(SPEC), 99)).toEqual(base);
    });

    it('is a no-op when the game has no pivot', () => {
        const noPivot = 'u0 o u0 o u2';
        const base = partitionAnnotationIntoSections(mk(noPivot));
        expect(partitionAnnotationIntoSections(mk(noPivot), 2)).toEqual(base);
    });
});
