import { describe, it, expect } from 'vitest';
import {
    annotateRecord,
    getRecordMetadata,
    getRecordOpponentName,
    deriveRecordEotPositions,
} from './RecordAnnotation';
import { GameRecord } from '../models/RepertoireData';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { pgnToRepertoires } from '../test-utils/repertoireBuilders';

const NOW = new Date('2026-05-25T12:00:00Z').getTime();

function makeLichessRecord(opts: Partial<GameRecord> & { m: string }): GameRecord {
    return {
        id: 'g1',
        p: 'l',
        t: NOW,
        wa: 'Me',
        ba: 'Opp',
        res: 'win',
        rt: 1,
        tc: '5+3',
        sp: 'blitz',
        wr: 1800,
        br: 1850,
        ...opts,
    };
}

describe('annotateRecord', () => {
    it('returns null when the user is not in the record', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', wa: 'a', ba: 'b' });
        const sets = buildRepertoireFenSets([]);
        const ann = await annotateRecord(rec, 'someone-else', sets.whiteFens, null);
        expect(ann).toBeNull();
    });

    it('marks in-repertoire user moves as in-repertoire', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const rec = makeLichessRecord({ m: 'e4 e5 Nf3' });
        const ann = await annotateRecord(rec, 'me', fens.whiteFens, null);
        expect(ann).not.toBeNull();
        const e4 = ann!.moves.find(m => m.san === 'e4');
        const nf3 = ann!.moves.find(m => m.san === 'Nf3');
        expect(e4?.highlight).toBe('in-repertoire');
        expect(nf3?.highlight).toBe('in-repertoire');
    });

    it('detects a user deviation', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const rec = makeLichessRecord({ m: 'e4 e5 d3' });
        const ann = await annotateRecord(rec, 'me', fens.whiteFens, null);
        expect(ann!.deviation).toBeDefined();
        expect(ann!.deviation!.userMove.san).toBe('d3');
        expect(ann!.deviation!.repertoireMoves.map(r => r.san)).toContain('Nf3');
    });
});

describe('annotateRecord — start-position seeding (empty / uncovered repertoire)', () => {
    it('grades a white user\'s first move instead of stopping out-of-theory', async () => {
        const fens = buildRepertoireFenSets([], { seedInitialPosition: true });
        const rec = makeLichessRecord({ m: 'e4 e5 d3', wa: 'me', ba: 'opp' });
        const ann = await annotateRecord(rec, 'me', fens.whiteFens, null);
        const e4 = ann!.moves.find(m => m.san === 'e4');
        // Start position seeded as book -> the empty repertoire's move 1 is a
        // leaf (no authored continuation) -> post-theory response, not an
        // immediate out-of-theory stop.
        expect(e4?.highlight).toBe('out-of-repertoire-response');
    });

    it('without seeding, the same first move is out-of-theory', async () => {
        const fens = buildRepertoireFenSets([]);
        const rec = makeLichessRecord({ m: 'e4 e5 d3', wa: 'me', ba: 'opp' });
        const ann = await annotateRecord(rec, 'me', fens.whiteFens, null);
        const e4 = ann!.moves.find(m => m.san === 'e4');
        expect(e4?.highlight).toBe('out-of-theory');
    });

    it('grades a black user\'s game past move 1 when evals are available', async () => {
        const fens = buildRepertoireFenSets([], { seedInitialPosition: true });
        const rec = makeLichessRecord({ m: 'e4 e5 Nf3 Nc6', wa: 'opp', ba: 'me' });
        const cloudEval = () => [20]; // ~equal -> tiny drops, stays "in theory"
        const ann = await annotateRecord(rec, 'me', fens.blackFens, null, undefined, false, cloudEval);
        const e4 = ann!.moves.find(m => m.san === 'e4');
        // Opponent's first move leaves the (start-only) book; a ~0 drop keeps it
        // in theory rather than stopping the walk at move 1.
        expect(e4?.highlight).toBe('out-of-repertoire');
        expect(ann!.moves.length).toBe(4);
    });
});

describe('getRecordMetadata', () => {
    it('uses the record res field as the authoritative result', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', res: 'loss' });
        const meta = getRecordMetadata(rec, 'me');
        expect(meta.result).toBe('loss');
    });

    it('produces a platform-correct game URL for Chess.com records using the stored u', async () => {
        const rec: GameRecord = {
            id: 'cc-uuid', p: 'c', t: NOW, m: 'e4 e5',
            wa: 'Me', ba: 'Opp', res: 'win', rt: 1,
            u: 'https://www.chess.com/game/live/12345',
        };
        const meta = getRecordMetadata(rec, 'me');
        expect(meta.gameUrl).toBe('https://www.chess.com/game/live/12345');
        expect(meta.platform).toBe('chess.com');
    });

    it('falls back to id-derived Chess.com URL when u is absent (best-effort)', async () => {
        const rec: GameRecord = {
            id: 'cc-uuid', p: 'c', t: NOW, m: 'e4 e5',
            wa: 'Me', ba: 'Opp', res: 'win', rt: 1,
        };
        const meta = getRecordMetadata(rec, 'me');
        expect(meta.gameUrl).toBe('https://www.chess.com/game/live/cc-uuid');
    });

    it('produces a /black URL for Lichess black games', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', wa: 'Opp', ba: 'Me' });
        const meta = getRecordMetadata(rec, 'me');
        expect(meta.gameUrl).toBe('https://lichess.org/g1/black');
        expect(meta.userColor).toBe('black');
    });

    it('preserves provider casing in display names', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', wa: 'DrNykterstein', ba: 'me' });
        const meta = getRecordMetadata(rec, 'me');
        expect(meta.whiteName).toBe('DrNykterstein');
        expect(meta.blackName).toBe('me');
    });

    it('exposes the opening name from the record', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', o: 'Italian Game' });
        const meta = getRecordMetadata(rec, 'me');
        expect(meta.openingName).toBe('Italian Game');
    });
});

describe('getRecordOpponentName', () => {
    it('returns the opposite-side name (provider casing)', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', wa: 'Me', ba: 'DrNykterstein' });
        expect(getRecordOpponentName(rec, 'me')).toBe('DrNykterstein');
    });

    it('falls back to wa when user is unknown', async () => {
        const rec = makeLichessRecord({ m: 'e4 e5', wa: 'Alice', ba: 'Bob' });
        expect(getRecordOpponentName(rec, 'stranger')).toBe('Alice');
    });
});

describe('deriveRecordEotPositions', () => {
    it('returns null when there is no EOT eval-drop user move', async () => {
        const reps = pgnToRepertoires([{ pgn: '1. e4 e5 2. Nf3', orientation: 'white' }]);
        const fens = buildRepertoireFenSets(reps);
        const rec = makeLichessRecord({ m: 'e4 e5 Nf3' });
        const ann = await annotateRecord(rec, 'me', fens.whiteFens, null);
        const eot = deriveRecordEotPositions(rec, ann!);
        expect(eot).toBeNull();
    });
});
