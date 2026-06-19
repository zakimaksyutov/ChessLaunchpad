import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    annotationToFrozen,
    buildAnnotationFromFrozen,
    AnnotatedMove,
    GameAnnotation,
} from './GameAnnotationService';
import { annotateRecord, annotateRecordFromFrozen } from './RecordAnnotation';
import { GameRecord, FrozenAnnotation } from '../models/RepertoireData';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';

const NOW = new Date('2026-05-25T12:00:00Z').getTime();

function rec(opts: Partial<GameRecord> & { m: string }): GameRecord {
    return {
        id: 'g1',
        p: 'l',
        t: NOW,
        wa: 'Me',
        ba: 'Opp',
        res: 'win',
        rt: 1,
        ...opts,
    };
}

/**
 * Freeze a live annotation, thaw it back, and assert the render-relevant
 * fields match the live annotation up to its last user move (the frozen
 * display window ends there).
 */
async function expectRoundTrip(
    record: GameRecord,
    userLower: string,
    fens: Set<string>,
): Promise<{ fan: FrozenAnnotation; thawed: GameAnnotation }> {
    const live = await annotateRecord(record, userLower, fens, null);
    expect(live).not.toBeNull();
    const fan = annotationToFrozen(live!);
    const recWithFan: GameRecord = { ...record, fan };
    const thawed = annotateRecordFromFrozen(recWithFan, userLower);
    expect(thawed).not.toBeNull();

    // Last user move in the live annotation bounds the frozen window.
    let lastUser = -1;
    for (let i = 0; i < live!.moves.length; i++) {
        if (live!.moves[i].isUserMove) lastUser = i;
    }
    const expectedLen = lastUser + 1;
    expect(thawed!.moves.length).toBe(expectedLen);

    for (let i = 0; i < expectedLen; i++) {
        const a = live!.moves[i];
        const b = thawed!.moves[i];
        expect(b.san).toBe(a.san);
        expect(b.isUserMove).toBe(a.isUserMove);
        expect(b.moveNumber).toBe(a.moveNumber);
        if (a.isUserMove) {
            expect(b.highlight).toBe(a.highlight);
            expect(b.evalDrop?.category).toBe(a.evalDrop?.category);
        }
    }

    expect(thawed!.miniBoardOrientation).toBe(live!.miniBoardOrientation);
    expect(thawed!.miniBoardFen).toBe(live!.miniBoardFen);

    if (live!.deviation) {
        expect(thawed!.deviation).toBeDefined();
        expect(thawed!.deviation!.userMove.san).toBe(live!.deviation!.userMove.san);
        expect(thawed!.deviation!.repertoireMoves.map(m => m.san).sort())
            .toEqual(live!.deviation!.repertoireMoves.map(m => m.san).sort());
    } else {
        expect(thawed!.deviation).toBeUndefined();
    }
    return { fan, thawed: thawed! };
}

describe('frozen-annotation round trip (annotateRecord -> freeze -> thaw)', () => {
    it('round-trips a fully in-repertoire white game (all code 0)', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const { fan } = await expectRoundTrip(rec({ m: 'e4 e5 Nf3' }), 'me', fens.whiteFens);
        expect(fan.hl).toEqual([0, 0]);
        expect(fan.alt).toBeUndefined();
        // Mini-board anchors after the last in-rep move (e4 e5 Nf3 = 3 plies).
        expect(fan.mb).toBe(3);
    });

    it('round-trips a deviation (code 1) white game and carries alt SANs + anchor', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const { fan, thawed } = await expectRoundTrip(rec({ m: 'e4 e5 d3' }), 'me', fens.whiteFens);
        expect(fan.hl).toEqual([0, 1]);
        expect(fan.alt).toContain('Nf3');
        // Anchor = position BEFORE the deviation ply (after e4 e5 = 2 plies).
        expect(fan.mb).toBe(2);
        // The deviation's green arrow is reconstructed from the alt SAN.
        const nf3Arrow = thawed.deviation!.repertoireMoves.find(m => m.san === 'Nf3')!;
        expect(nf3Arrow.from).toBe('g1');
        expect(nf3Arrow.to).toBe('f3');
        // The red arrow is the played move.
        expect(thawed.deviation!.userMove).toMatchObject({ from: 'd2', to: 'd3', san: 'd3' });
    });

    it('round-trips a black-user in-repertoire game', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3 Nc6', orientation: 'black' }]);
        const fens = buildRepertoireFenSets(reps);
        const record = rec({ m: 'e4 e5 Nf3 Nc6', wa: 'Opp', ba: 'Me' });
        const { fan } = await expectRoundTrip(record, 'me', fens.blackFens);
        expect(fan.hl).toEqual([0, 0]); // user (black) moves e5, Nc6
    });

    it('trims the display window to the last user move covered by hl', async () => {
        // Black user; the white move after the last black user move is dropped.
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3 Nc6', orientation: 'black' }]);
        const fens = buildRepertoireFenSets(reps);
        const record = rec({ m: 'e4 e5 Nf3 Nc6 Bb5', wa: 'Opp', ba: 'Me' });
        const live = await annotateRecord(record, 'me', fens.blackFens, null);
        const fan = annotationToFrozen(live!);
        const thawed = annotateRecordFromFrozen({ ...record, fan }, 'me')!;
        // hl has 2 user (black) codes -> window ends at Nc6 (ply 3), dropping Bb5.
        expect(fan.hl.length).toBe(2);
        expect(thawed.moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    });

    it('trims a trailing opponent move for a white-user game ending on a black ply', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        // White user; the game ends on Black's Nc6 (an opponent ply) after the
        // last white user move Nf3 — the live window keeps it, the thaw drops it.
        const record = rec({ m: 'e4 e5 Nf3 Nc6' });
        const live = await annotateRecord(record, 'me', fens.whiteFens, null);
        expect(live!.moves.length).toBe(4);
        const { thawed } = await expectRoundTrip(record, 'me', fens.whiteFens);
        expect(thawed.moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3']);
    });

    it('round-trips an EOT eval-drop (code 3) white game from embedded evals', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        // After 2.Nf3 the opponent leaves book with a quiet move (a6, small
        // drop => stays "in theory"), then the user's reply Bc4 drops 35 cp
        // (inaccuracy => code 3). Evals are White's-POV centipawns per ply.
        const record = rec({ m: 'e4 e5 Nf3 a6 Bc4', ev: [20, 18, 20, 25, -10] });
        const { fan, thawed } = await expectRoundTrip(record, 'me', fens.whiteFens);
        expect(fan.hl).toEqual([0, 0, 3]);
        expect(fan.alt).toBeUndefined();
        const bc4 = thawed.moves.find(m => m.san === 'Bc4')!;
        expect(bc4.highlight).toBe('out-of-repertoire-response');
        expect(bc4.evalDrop?.category).toBe('inaccuracy');
        // Anchor = the first post-theory position (after Bc4 = 5 plies).
        expect(fan.mb).toBe(5);
    });

    it('round-trips a move from a user-to-move leaf as a graded post-theory move, not a deviation', async () => {
        // Repertoire ends after 1...e5 (a leaf — no authored 2nd white move),
        // so the user's 2.Nf3 leaves the leaf but had nothing to deviate from.
        // It's graded as a post-theory response (small drop → ok, code 2), not a deviation.
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const record = rec({ m: 'e4 e5 Nf3', ev: [20, 18, 20] });
        const { fan, thawed } = await expectRoundTrip(record, 'me', fens.whiteFens);
        expect(fan.hl).toEqual([0, 2]);
        expect(fan.alt).toBeUndefined();
        expect(thawed.deviation).toBeUndefined();
    });
});

describe('annotationToFrozen — highlight -> code mapping', () => {
    function userMove(highlight: AnnotatedMove['highlight'], category?: 'ok' | 'inaccuracy' | 'mistake' | 'blunder'): AnnotatedMove {
        return {
            san: 'x', isWhiteMove: true, isUserMove: true, highlight,
            evalDrop: category ? { evalDrop: 0, category } : undefined,
        };
    }
    const opp: AnnotatedMove = { san: 'y', isWhiteMove: false, isUserMove: false, highlight: 'out-of-theory' };

    it('maps each user highlight to its code and skips opponent moves', async () => {
        const ann: GameAnnotation = {
            moves: [
                userMove('in-repertoire'),
                opp,
                userMove('deviation'),
                userMove('out-of-repertoire-response', 'ok'),
                userMove('out-of-repertoire-response', 'inaccuracy'),
                userMove('out-of-repertoire-response', 'mistake'),
                userMove('out-of-repertoire-response', 'blunder'),
                userMove('out-of-theory'),
            ],
            miniBoardFen: 'startpos',
            miniBoardPly: 4,
            miniBoardOrientation: 'white',
            deviation: {
                fen: 'x',
                userMove: { from: 'a1', to: 'a2', san: 'Ra2' },
                repertoireMoves: [{ from: 'g1', to: 'f3', san: 'Nf3' }],
            },
        };
        const fan = annotationToFrozen(ann);
        expect(fan.hl).toEqual([0, 1, 2, 3, 4, 5, 7]);
        expect(fan.alt).toEqual(['Nf3']);
        expect(fan.mb).toBe(4);
    });

    it('omits alt when there is no deviation', async () => {
        const ann: GameAnnotation = {
            moves: [userMove('in-repertoire')],
            miniBoardFen: 'startpos',
            miniBoardPly: 1,
            miniBoardOrientation: 'white',
        };
        const fan = annotationToFrozen(ann);
        expect(fan.alt).toBeUndefined();
    });
});

describe('buildAnnotationFromFrozen — code -> highlight reconstruction', () => {
    it('reconstructs EOT categories from codes 2/3/4/5', async () => {
        // White user moves at plies 0,2,4,6.
        const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'b5'];
        const fan: FrozenAnnotation = { hl: [2, 3, 4, 5], mb: 0 };
        const ann = buildAnnotationFromFrozen(fan, sans, 'white');
        const userMoves = ann.moves.filter(m => m.isUserMove);
        expect(userMoves.map(m => m.highlight)).toEqual(Array(4).fill('out-of-repertoire-response'));
        expect(userMoves.map(m => m.evalDrop?.category)).toEqual(['ok', 'inaccuracy', 'mistake', 'blunder']);
    });

    it('reconstructs deviation arrows from alt SAN at the mb position', async () => {
        const sans = ['e4', 'e5', 'd3', 'Nc6'];
        const fan: FrozenAnnotation = { hl: [0, 1], mb: 2, alt: ['Nf3'] };
        const ann = buildAnnotationFromFrozen(fan, sans, 'white');
        expect(ann.deviation).toBeDefined();
        expect(ann.deviation!.userMove.san).toBe('d3');
        const arrow = ann.deviation!.repertoireMoves[0];
        expect(arrow).toMatchObject({ from: 'g1', to: 'f3', san: 'Nf3' });
        // Mini board is the position before the deviation (after e4 e5).
        const expectedFen = (() => { const c = new Chess(); c.move('e4'); c.move('e5'); return c.fen(); })();
        expect(ann.miniBoardFen).toBe(expectedFen);
    });
});

describe('annotateRecordFromFrozen', () => {
    it('returns null when the record has no fan', async () => {
        expect(annotateRecordFromFrozen(rec({ m: 'e4 e5' }), 'me')).toBeNull();
    });

    it('returns null when the user color cannot be resolved', async () => {
        const record: GameRecord = { ...rec({ m: 'e4 e5' }), fan: { hl: [0], mb: 0 } };
        expect(annotateRecordFromFrozen(record, 'stranger')).toBeNull();
    });
});
