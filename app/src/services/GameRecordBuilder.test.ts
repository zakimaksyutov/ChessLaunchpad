import { describe, it, expect } from 'vitest';
import {
    buildGameRecord,
    getRecordUserColor,
    MAX_RECORD_PLIES,
} from './GameRecordBuilder';

const NOW = new Date('2026-05-25T12:00:00Z').getTime();

function lichessGame(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 'g1',
        createdAt: NOW,
        rated: true,
        speed: 'blitz',
        moves: 'e4 e5 Nf3',
        winner: 'white',
        status: 'mate',
        players: {
            white: { user: { id: 'me', name: 'Me' }, rating: 1800 },
            black: { user: { id: 'opp', name: 'Opp' }, rating: 1850 },
        },
        clock: { initial: 300, increment: 3 },
        opening: { name: "King's Pawn Opening" },
        ...overrides,
    };
}

function chesscomGame(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        uuid: 'cc-uuid',
        end_time: Math.floor(NOW / 1000),
        rated: true,
        time_class: 'blitz',
        time_control: '300+3',
        rules: 'chess',
        white: { username: 'Me', rating: 1800, result: 'win' },
        black: { username: 'Opp', rating: 1850, result: 'checkmated' },
        pgn: '[Event "Live Chess"]\n[ECOUrl "https://www.chess.com/openings/Italian-Game"]\n\n1. e4 e5 2. Nf3 Nc6 1-0',
        ...overrides,
    };
}

describe('buildGameRecord — Lichess', () => {
    it('builds a record from a typical Lichess payload', () => {
        const rec = buildGameRecord(lichessGame(), 'me', 'lichess');
        expect(rec).not.toBeNull();
        expect(rec!.id).toBe('g1');
        expect(rec!.p).toBe('l');
        expect(rec!.t).toBe(NOW);
        expect(rec!.m).toBe('e4 e5 Nf3');
        expect(rec!.wa).toBe('Me'); // provider casing preserved
        expect(rec!.ba).toBe('Opp');
        expect(rec!.wr).toBe(1800);
        expect(rec!.br).toBe(1850);
        expect(rec!.res).toBe('win');
        expect(rec!.rt).toBe(1);
        expect(rec!.tc).toBe('5+3');
        expect(rec!.sp).toBe('blitz');
        expect(rec!.o).toBe("King's Pawn Opening");
        expect(rec!.ev).toBeUndefined();
    });

    it('resolves the user as black when black matches the account', () => {
        const rec = buildGameRecord(lichessGame({ winner: 'black' }), 'opp', 'lichess');
        expect(rec).not.toBeNull();
        expect(rec!.res).toBe('win');
    });

    it('returns null when the user is not a player', () => {
        const rec = buildGameRecord(lichessGame(), 'stranger', 'lichess');
        expect(rec).toBeNull();
    });

    it('returns null when there are no moves', () => {
        const rec = buildGameRecord(lichessGame({ moves: '' }), 'me', 'lichess');
        expect(rec).toBeNull();
    });

    it('reports draw correctly when winner is absent', () => {
        const rec = buildGameRecord(lichessGame({ winner: undefined, status: 'draw' }), 'me', 'lichess');
        expect(rec!.res).toBe('draw');
    });

    it('reports loss correctly when opponent wins', () => {
        const rec = buildGameRecord(lichessGame({ winner: 'black' }), 'me', 'lichess');
        expect(rec!.res).toBe('loss');
    });

    it('extracts per-ply evals with null sentinels for missing plies', () => {
        const rec = buildGameRecord(
            lichessGame({
                moves: 'e4 e5 Nf3 Nc6',
                analysis: [
                    { eval: 20 },
                    {}, // missing — should serialize as null
                    { mate: 5 }, // mate score → MATE_CP
                    { mate: -5 }, // mate score → -MATE_CP
                ],
            }),
            'me',
            'lichess',
        );
        expect(rec!.ev).toEqual([20, null, 10_000, -10_000]);
    });

    it('truncates m and ev to MAX_RECORD_PLIES', () => {
        // Generate a long opening that goes well past MAX_RECORD_PLIES.
        // Simple SAN sequence — just shuffle knights.
        const sans: string[] = [];
        // Build a long but legal game by repeating Nf3, Nf6, Nb1, Ng8 etc.
        for (let i = 0; i < MAX_RECORD_PLIES + 50; i++) {
            const mod = i % 4;
            if (mod === 0) sans.push('Nf3');
            else if (mod === 1) sans.push('Nf6');
            else if (mod === 2) sans.push('Ng1');
            else sans.push('Ng8');
        }
        const movesStr = sans.join(' ');
        const evals: Record<string, unknown>[] = sans.map((_, i) => ({ eval: i }));
        const rec = buildGameRecord(
            lichessGame({ moves: movesStr, analysis: evals }),
            'me',
            'lichess',
        );
        expect(rec).not.toBeNull();
        const sansAfter = rec!.m.split(/\s+/);
        expect(sansAfter.length).toBe(MAX_RECORD_PLIES);
        expect(rec!.ev!.length).toBe(MAX_RECORD_PLIES);
    });

    it('survives illegal moves by stopping replay defensively', () => {
        const rec = buildGameRecord(
            lichessGame({ moves: 'e4 e5 totally-illegal-san Nf3' }),
            'me',
            'lichess',
        );
        expect(rec).not.toBeNull();
        // Stops at the illegal san — only 'e4 e5' captured.
        expect(rec!.m).toBe('e4 e5');
    });
});

describe('buildGameRecord — Chess.com', () => {
    it('builds a record from a typical Chess.com payload', () => {
        const rec = buildGameRecord(chesscomGame(), 'me', 'chess.com');
        expect(rec).not.toBeNull();
        expect(rec!.id).toBe('cc-uuid');
        expect(rec!.p).toBe('c');
        expect(rec!.t).toBe(NOW);
        expect(rec!.m).toBe('e4 e5 Nf3 Nc6');
        expect(rec!.wa).toBe('Me');
        expect(rec!.ba).toBe('Opp');
        expect(rec!.res).toBe('win');
        expect(rec!.tc).toBe('5+3');
        expect(rec!.sp).toBe('blitz');
        // Opening name extracted from ECOUrl
        expect(rec!.o).toBe('Italian Game');
        // ev should be absent for Chess.com
        expect(rec!.ev).toBeUndefined();
    });

    it('extracts opening BEFORE the PGN is reduced to bare SAN (regression)', () => {
        const rec = buildGameRecord(
            chesscomGame({
                pgn: '[ECOUrl "https://www.chess.com/openings/Sicilian-Defense"]\n\n1. e4 c5',
            }),
            'me',
            'chess.com',
        );
        expect(rec!.o).toBe('Sicilian Defense');
        expect(rec!.m).toBe('e4 c5');
    });

    it('returns null when uuid is missing', () => {
        const rec = buildGameRecord(chesscomGame({ uuid: undefined }), 'me', 'chess.com');
        expect(rec).toBeNull();
    });

    it('reports draw / loss correctly via per-side result fields', () => {
        const draw = buildGameRecord(
            chesscomGame({
                white: { username: 'Me', rating: 1800, result: 'agreed' },
                black: { username: 'Opp', rating: 1850, result: 'agreed' },
            }),
            'me',
            'chess.com',
        );
        expect(draw!.res).toBe('draw');

        const loss = buildGameRecord(
            chesscomGame({
                white: { username: 'Me', rating: 1800, result: 'resigned' },
                black: { username: 'Opp', rating: 1850, result: 'win' },
            }),
            'me',
            'chess.com',
        );
        expect(loss!.res).toBe('loss');
    });

    it('strips PGN clock comments and headers', () => {
        const rec = buildGameRecord(
            chesscomGame({
                pgn: '[Event "x"]\n\n1. e4 { [%clk 0:05:00.0] } e5 { [%clk 0:05:00.0] } 2. Nf3',
            }),
            'me',
            'chess.com',
        );
        expect(rec).not.toBeNull();
        expect(rec!.m).toBe('e4 e5 Nf3');
    });
    it('persists the canonical Chess.com URL on `u` so the View link is correct', () => {
        const rec = buildGameRecord(chesscomGame({ url: 'https://www.chess.com/game/live/12345' }), 'me', 'chess.com');
        expect(rec!.u).toBe('https://www.chess.com/game/live/12345');
    });

    it('omits `u` when the Chess.com payload has no url', () => {
        const game = chesscomGame();
        delete (game as Record<string, unknown>).url;
        const rec = buildGameRecord(game, 'me', 'chess.com');
        expect(rec!.u).toBeUndefined();
    });
});

describe('getRecordUserColor', () => {
    it('matches the user as white case-insensitively', () => {
        const rec = buildGameRecord(lichessGame(), 'me', 'lichess')!;
        expect(getRecordUserColor(rec, 'me')).toBe('white');
        expect(getRecordUserColor(rec, 'ME')).toBe('white');
    });

    it('matches the user as black', () => {
        const rec = buildGameRecord(lichessGame(), 'opp', 'lichess')!;
        expect(getRecordUserColor(rec, 'opp')).toBe('black');
    });

    it('returns null when neither side matches', () => {
        const rec = buildGameRecord(lichessGame(), 'me', 'lichess')!;
        expect(getRecordUserColor(rec, 'stranger')).toBeNull();
    });
});
