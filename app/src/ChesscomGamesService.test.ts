import { describe, it, expect } from 'vitest';
import { parseChesscomTimeControl } from './ChesscomGamesService';
import { getUserColor, getGameMetadata, annotateGame } from './GameAnnotationService';
import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from './FenUtils';

/**
 * Helper: build a Chess.com-style game data object.
 */
function makeChesscomGameData(
    pgn: string,
    whiteUsername: string,
    blackUsername: string,
    options: {
        whiteResult?: string;
        blackResult?: string;
        timeControl?: string;
        timeClass?: string;
        rated?: boolean;
        endTime?: number;
        url?: string;
    } = {}
): Record<string, unknown> {
    return {
        uuid: 'test-uuid-123',
        url: options.url ?? 'https://www.chess.com/game/live/123456789',
        pgn,
        time_control: options.timeControl ?? '300',
        time_class: options.timeClass ?? 'blitz',
        rated: options.rated ?? true,
        rules: 'chess',
        end_time: options.endTime ?? 1714476552,
        white: {
            username: whiteUsername,
            rating: 1500,
            result: options.whiteResult ?? 'win',
        },
        black: {
            username: blackUsername,
            rating: 1400,
            result: options.blackResult ?? 'checkmated',
        },
    };
}

/**
 * Helper: build a repertoire FEN set from a list of PGN move sequences.
 */
function buildRepertoireFens(moveSequences: string[][]): Set<string> {
    const fens = new Set<string>();
    for (const seq of moveSequences) {
        const c = new Chess();
        fens.add(normalizeFenResetHalfmoveClock(c.fen()));
        for (const san of seq) {
            c.move(san);
            fens.add(normalizeFenResetHalfmoveClock(c.fen()));
        }
    }
    return fens;
}

describe('parseChesscomTimeControl', () => {
    it('parses plain seconds', () => {
        expect(parseChesscomTimeControl('600')).toBe('10+0');
        expect(parseChesscomTimeControl('300')).toBe('5+0');
        expect(parseChesscomTimeControl('180')).toBe('3+0');
        expect(parseChesscomTimeControl('60')).toBe('1+0');
    });

    it('parses seconds with increment', () => {
        expect(parseChesscomTimeControl('300+5')).toBe('5+5');
        expect(parseChesscomTimeControl('180+2')).toBe('3+2');
        expect(parseChesscomTimeControl('600+10')).toBe('10+10');
    });

    it('handles empty string', () => {
        expect(parseChesscomTimeControl('')).toBe('');
    });

    it('passes through daily format unchanged', () => {
        expect(parseChesscomTimeControl('1/259200')).toBe('1/259200');
    });
});

describe('getUserColor (Chess.com)', () => {
    it('returns white when username matches white player', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        expect(getUserColor(data, 'alice', 'chess.com')).toBe('white');
    });

    it('returns black when username matches black player', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        expect(getUserColor(data, 'bob', 'chess.com')).toBe('black');
    });

    it('is case-insensitive', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        expect(getUserColor(data, 'ALICE', 'chess.com')).toBe('white');
        expect(getUserColor(data, 'BOB', 'chess.com')).toBe('black');
    });

    it('returns null for unknown player', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        expect(getUserColor(data, 'charlie', 'chess.com')).toBeNull();
    });

    it('auto-detects chess.com platform from data shape', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        // Without explicit platform - should auto-detect from uuid field
        expect(getUserColor(data, 'alice')).toBe('white');
    });
});

describe('getGameMetadata (Chess.com)', () => {
    it('extracts player names and ratings', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.whiteName).toBe('Alice');
        expect(meta.whiteRating).toBe(1500);
        expect(meta.blackName).toBe('Bob');
        expect(meta.blackRating).toBe(1400);
    });

    it('determines win correctly', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob', {
            whiteResult: 'win',
            blackResult: 'checkmated',
        });
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.result).toBe('win');
    });

    it('determines loss correctly', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob', {
            whiteResult: 'checkmated',
            blackResult: 'win',
        });
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.result).toBe('loss');
    });

    it('determines draw correctly', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob', {
            whiteResult: 'stalemate',
            blackResult: 'stalemate',
        });
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.result).toBe('draw');
    });

    it('handles agreed draw', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob', {
            whiteResult: 'agreed',
            blackResult: 'agreed',
        });
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.result).toBe('draw');
    });

    it('parses time control', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob', {
            timeControl: '300+5',
        });
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.timeControl).toBe('5+5');
    });

    it('includes game URL', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob', {
            url: 'https://www.chess.com/game/live/999',
        });
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.gameUrl).toBe('https://www.chess.com/game/live/999');
    });

    it('reports platform as chess.com', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        const meta = getGameMetadata(data, 'alice', 'chess.com');
        expect(meta.platform).toBe('chess.com');
    });

    it('handles null userColor gracefully', () => {
        const data = makeChesscomGameData('', 'Alice', 'Bob');
        const meta = getGameMetadata(data, 'charlie', 'chess.com');
        expect(meta.userColor).toBeNull();
        expect(meta.result).toBe('draw'); // fallback
    });
});

describe('annotateGame (Chess.com PGN)', () => {
    const simplePgn = `[Event "Live Chess"]
[Site "Chess.com"]
[White "TestUser"]
[Black "Opponent"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 1-0`;

    it('annotates moves from a Chess.com PGN', () => {
        const data = makeChesscomGameData(simplePgn, 'TestUser', 'Opponent');
        const repertoireFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']]);

        const result = annotateGame(data, 'testuser', repertoireFens, null, 30, 'chess.com');
        expect(result).not.toBeNull();
        expect(result!.moves.length).toBeGreaterThan(0);

        // First move e4 should be in-repertoire
        expect(result!.moves[0].san).toBe('e4');
        expect(result!.moves[0].highlight).toBe('in-repertoire');
    });

    it('handles PGN with clock annotations', () => {
        const pgnWithClocks = `[Event "Live Chess"]
[Site "Chess.com"]
[White "TestUser"]
[Black "Opponent"]
[Result "1-0"]

1. e4 {[%clk 0:04:58.5]} 1... e5 {[%clk 0:04:57.2]} 2. Nf3 {[%clk 0:04:55.1]} 2... Nc6 {[%clk 0:04:53.8]} 1-0`;

        const data = makeChesscomGameData(pgnWithClocks, 'TestUser', 'Opponent');
        const repertoireFens = buildRepertoireFens([['e4', 'e5', 'Nf3', 'Nc6']]);

        const result = annotateGame(data, 'testuser', repertoireFens, null, 30, 'chess.com');
        expect(result).not.toBeNull();
        expect(result!.moves.length).toBe(4);
    });

    it('returns null for empty/no-move games', () => {
        const emptyPgn = `[Event "Live Chess"]
[Result "*"]

*`;
        const data = makeChesscomGameData(emptyPgn, 'TestUser', 'Opponent');
        const repertoireFens = buildRepertoireFens([['e4']]);

        const result = annotateGame(data, 'testuser', repertoireFens, null, 30, 'chess.com');
        // Either null or empty moves is acceptable
        if (result) {
            expect(result.moves.length).toBe(0);
        }
    });

    it('identifies board orientation correctly for black', () => {
        const data = makeChesscomGameData(simplePgn, 'Opponent', 'TestUser');
        const repertoireFens = buildRepertoireFens([['e4', 'e5']]);

        const result = annotateGame(data, 'testuser', repertoireFens, null, 30, 'chess.com');
        expect(result).not.toBeNull();
        expect(result!.miniBoardOrientation).toBe('black');
    });
});
