import { AnnotatedMove, GameAnnotation } from './GameAnnotationService';
import { EvalDropCategory } from './EvalDropService';

/**
 * Narrative sections for the Games-tile PGN. The per-move color scheme is hard
 * for new users to read, so the annotated line is grouped into labeled
 * sections whose headers carry the meaning (color becomes reinforcement).
 *
 * Sections are an ordered, contiguous partition of `annotation.moves` derived
 * purely from the already-frozen per-user-move highlights — no repertoire,
 * eval, or masters lookups. See `docs/product-specs/GAMES.md`.
 *
 *   in-repertoire       📖  green run before any pivot
 *   off-prep            🧭  opponent left YOUR book but it's still known theory
 *   pivot               ❌  the single deviation OR first eval-drop
 *   back-to-repertoire  📖  green run after a transposition back into your prep
 *   out-of-theory       🌫  dimmed tail once the game leaves all known theory
 */
export type GameSectionKind =
    | 'in-repertoire'
    | 'off-prep'
    | 'pivot'
    | 'back-to-repertoire'
    | 'out-of-theory';

/** What kind of mistake the single `pivot` section captures. */
export type PivotKind = 'deviation' | EvalDropCategory;

export interface GameSection {
    kind: GameSectionKind;
    moves: AnnotatedMove[];
    /** Only set on the `pivot` section — drives its header verdict. */
    pivotKind?: PivotKind;
}

/** A user move that left the repertoire while a book continuation existed. */
function isDeviationMove(m: AnnotatedMove): boolean {
    return m.isUserMove && m.highlight === 'deviation';
}

/** A user post-theory response whose eval drop is notable (inaccuracy+). */
function isEvalDropMove(m: AnnotatedMove): boolean {
    return (
        m.isUserMove &&
        m.highlight === 'out-of-repertoire-response' &&
        m.evalDrop !== undefined &&
        m.evalDrop.category !== 'ok'
    );
}

/** The single pivotal move: the first deviation or first notable eval drop. */
function isPivotMove(m: AnnotatedMove): boolean {
    return isDeviationMove(m) || isEvalDropMove(m);
}

/**
 * Classify a USER move into a section kind. `leftBook` (have we left the
 * in-repertoire phase yet, via off-prep / pivot / out-of-theory) distinguishes
 * a green move that's still original prep (`in-repertoire`) from one reached by
 * transposing back into book later (`back-to-repertoire`) — this is independent
 * of the pivot, so a clean off-prep → back-in-book return is also labeled
 * `back-to-repertoire`.
 */
function classifyUserMove(m: AnnotatedMove, leftBook: boolean): GameSectionKind {
    switch (m.highlight) {
        case 'in-repertoire':
            return leftBook ? 'back-to-repertoire' : 'in-repertoire';
        case 'out-of-repertoire-response':
            // An ok post-theory response → still known theory, off your prep.
            // A notable drop here that is NOT the first pivot (rare second
            // drop) is folded into the out-of-theory tail rather than starting
            // a second pivot section.
            return m.evalDrop && m.evalDrop.category !== 'ok' ? 'out-of-theory' : 'off-prep';
        case 'deviation':
            // A second deviation after the pivot is folded into the tail.
            return 'out-of-theory';
        case 'out-of-repertoire':
        case 'out-of-theory':
            return 'out-of-theory';
    }
}

/**
 * An opponent move "leads" the section that follows it (rather than trailing
 * the one before) only when the opponent itself drove the transition: leaving
 * your prep (→ off-prep), transposing back (→ back-to-repertoire), or leaving
 * known theory (→ out-of-theory). A pivot is always a USER move, so the
 * opponent move before it trails the prior section and the pivot stands alone.
 */
const OPPONENT_LED_KINDS: ReadonlySet<GameSectionKind> = new Set<GameSectionKind>([
    'off-prep',
    'back-to-repertoire',
    'out-of-theory',
]);

/**
 * Partition a thawed annotation into ordered narrative sections. Pure function
 * of `annotation.moves`; returns `[]` for an empty move list. Opponent moves
 * carry no frozen code, so they're placed by the surrounding user-move kinds.
 */
export function partitionAnnotationIntoSections(annotation: GameAnnotation): GameSection[] {
    const moves = annotation.moves;
    if (moves.length === 0) return [];

    // Pass 1 — kind per USER move (+ remember the single pivot move index).
    const userKind = new Map<number, GameSectionKind>();
    let pivotSeen = false;
    let leftBook = false;
    let pivotIdx = -1;
    let pivotKind: PivotKind | undefined;
    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (!m.isUserMove) continue;
        if (!pivotSeen && isPivotMove(m)) {
            userKind.set(i, 'pivot');
            pivotSeen = true;
            leftBook = true;
            pivotIdx = i;
            pivotKind = isDeviationMove(m) ? 'deviation' : m.evalDrop!.category;
        } else {
            const kind = classifyUserMove(m, leftBook);
            userKind.set(i, kind);
            // Anything other than staying/returning to book means we've left it.
            if (kind === 'off-prep' || kind === 'out-of-theory') leftBook = true;
        }
    }

    // Pass 2 — assign every move (incl. opponent) to a section kind.
    const kinds: GameSectionKind[] = new Array(moves.length);
    for (let i = 0; i < moves.length; i++) {
        if (moves[i].isUserMove) {
            kinds[i] = userKind.get(i)!;
            continue;
        }
        // Opponent move: lead the next section on an opponent-driven
        // transition, else trail the current one.
        let prev: GameSectionKind | undefined;
        for (let j = i - 1; j >= 0; j--) {
            if (moves[j].isUserMove) { prev = userKind.get(j); break; }
        }
        let next: GameSectionKind | undefined;
        for (let j = i + 1; j < moves.length; j++) {
            if (moves[j].isUserMove) { next = userKind.get(j); break; }
        }
        // No preceding user move (game opened on the opponent) → join the
        // first section. No following user move can't happen (the window
        // always ends on a user move), but fall back to prev defensively.
        const prevKind = prev ?? next ?? 'in-repertoire';
        const nextKind = next ?? prevKind;
        let kind =
            nextKind !== prevKind && OPPONENT_LED_KINDS.has(nextKind)
                ? nextKind
                : prevKind;
        // An opponent move must never form/join the lone `pivot` section — that
        // would put the opponent's move under a "Blunder" header and break
        // the "pivot stands alone" invariant. The only way this arises is the
        // opening opponent move when Black's very first move is the pivot.
        // Attribute it to the phase its own move created: a deviation pivot
        // means the position before was still in book (→ in-repertoire); an
        // eval-drop pivot means the opponent had already taken the game off
        // prep (→ off-prep).
        if (kind === 'pivot') {
            kind = pivotKind === 'deviation' ? 'in-repertoire' : 'off-prep';
        }
        kinds[i] = kind;
    }

    // Pass 3 — coalesce contiguous same-kind moves into sections.
    const sections: GameSection[] = [];
    for (let i = 0; i < moves.length; i++) {
        const kind = kinds[i];
        const last = sections[sections.length - 1];
        if (last && last.kind === kind) {
            last.moves.push(moves[i]);
        } else {
            sections.push({ kind, moves: [moves[i]] });
        }
    }
    if (pivotIdx >= 0 && pivotKind) {
        const pivotSection = sections.find(s => s.kind === 'pivot');
        if (pivotSection) pivotSection.pivotKind = pivotKind;
    }
    return sections;
}
