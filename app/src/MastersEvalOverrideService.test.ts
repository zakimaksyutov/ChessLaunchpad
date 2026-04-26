import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { MastersExplorerResult } from './LichessMastersService';
import {
    shouldSuppressHighlight,
    identifyFlaggedMoves,
    applyOverrides,
} from './MastersEvalOverrideService';
import { EvalDrop } from './EvalDropService';

function makeMastersResult(
    moves: { san: string; totalGames: number; white: number; draws: number; black: number }[],
    fen = 'test-fen'
): MastersExplorerResult {
    const totalWhite = moves.reduce((s, m) => s + m.white, 0);
    const totalDraws = moves.reduce((s, m) => s + m.draws, 0);
    const totalBlack = moves.reduce((s, m) => s + m.black, 0);
    return {
        fen,
        totalWhite,
        totalDraws,
        totalBlack,
        totalGames: totalWhite + totalDraws + totalBlack,
        moves: moves.map((m) => {
            const total = m.white + m.draws + m.black;
            return {
                san: m.san,
                uci: '',
                white: m.white,
                draws: m.draws,
                black: m.black,
                totalGames: total,
                whitePercent: total > 0 ? Math.round((m.white / total) * 100) : 0,
                drawPercent: total > 0 ? Math.round((m.draws / total) * 100) : 0,
                blackPercent: total > 0 ? Math.round((m.black / total) * 100) : 0,
                averageRating: 2600,
            };
        }),
    };
}

describe('shouldSuppressHighlight', () => {
    it('suppresses when move is top with ≥90% share and no better alternative', () => {
        const result = makeMastersResult([
            { san: 'a3', totalGames: 500, white: 275, draws: 165, black: 60 },
            { san: 'Bh3', totalGames: 1, white: 1, draws: 0, black: 0 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(true);
    });

    it('does not suppress when move is not the top move', () => {
        const result = makeMastersResult([
            { san: 'a3', totalGames: 500, white: 275, draws: 165, black: 60 },
            { san: 'Bh3', totalGames: 1, white: 1, draws: 0, black: 0 },
        ]);
        expect(shouldSuppressHighlight(result, 'Bh3', 'white')).toBe(false);
    });

    it('does not suppress when top move share is below 90%', () => {
        const result = makeMastersResult([
            { san: 'a3', totalGames: 80, white: 44, draws: 26, black: 10 },
            { san: 'Bh3', totalGames: 20, white: 11, draws: 6, black: 3 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(false);
    });

    it('does not suppress when an alternative has ≥5% games and ≥5pp better win rate', () => {
        // Top move: 90% share, 50% white win rate
        // Alt: 10% share, 70% white win rate (20pp better)
        const result = makeMastersResult([
            { san: 'a3', totalGames: 90, white: 45, draws: 30, black: 15 },
            { san: 'Nc6', totalGames: 10, white: 7, draws: 2, black: 1 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(false);
    });

    it('suppresses when alternative has better win rate but too few games (<5%)', () => {
        const result = makeMastersResult([
            { san: 'a3', totalGames: 980, white: 490, draws: 294, black: 196 },
            { san: 'Nc6', totalGames: 20, white: 18, draws: 1, black: 1 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(true);
    });

    it('suppresses when alternative has enough games but marginal win rate difference', () => {
        // Top move: 55% white, Alt: 58% white (only 3pp diff, below 5pp threshold)
        const result = makeMastersResult([
            { san: 'a3', totalGames: 900, white: 495, draws: 270, black: 135 },
            { san: 'Nc6', totalGames: 100, white: 58, draws: 25, black: 17 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(true);
    });

    it('considers black win rate when orientation is black', () => {
        // Top move as black: 12% black win rate
        // Alt: 30% black win rate, 6% games — should block suppression (18pp edge)
        const result = makeMastersResult([
            { san: 'g6', totalGames: 94, white: 52, draws: 31, black: 11 },
            { san: 'd6', totalGames: 6, white: 2, draws: 2, black: 2 },
        ]);
        expect(shouldSuppressHighlight(result, 'g6', 'black')).toBe(false);
    });

    it('returns false for empty master data', () => {
        const result = makeMastersResult([]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(false);
    });

    it('suppresses when move has 150+ master games even if not top move', () => {
        const result = makeMastersResult([
            { san: 'Bh3', totalGames: 300, white: 150, draws: 90, black: 60 },
            { san: 'a3', totalGames: 200, white: 100, draws: 60, black: 40 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(true);
    });

    it('does not auto-suppress when move has fewer than 150 master games and is not top', () => {
        const result = makeMastersResult([
            { san: 'Bh3', totalGames: 300, white: 150, draws: 90, black: 60 },
            { san: 'a3', totalGames: 149, white: 75, draws: 45, black: 29 },
        ]);
        expect(shouldSuppressHighlight(result, 'a3', 'white')).toBe(false);
    });
});

describe('identifyFlaggedMoves', () => {
    it('identifies moves that have non-ok eval drops', () => {
        const pgn = '1. e4 e5 2. Nf3';
        const orientation: 'white' | 'black' = 'white';

        // Create a fake eval-drop map with an inaccuracy on move 2 (Nf3)
        const evalDrops = new Map<string, EvalDrop>();
        // We need to figure out the FEN after 1. e4 e5 2. Nf3
        const chess = new Chess();
        chess.loadPgn(pgn);
        const afterNf3Fen = chess.fen();
        chess.undo();
        const afterE5Fen = chess.fen();
        chess.undo();
        const afterE4Fen = chess.fen();

        evalDrops.set(afterE4Fen, { evalDrop: 10, category: 'ok' });
        evalDrops.set(afterNf3Fen, { evalDrop: 35, category: 'inaccuracy' });

        const flagged = identifyFlaggedMoves(pgn, orientation, evalDrops);
        expect(flagged).toHaveLength(1);
        expect(flagged[0].san).toBe('Nf3');
        expect(flagged[0].afterFen).toBe(afterNf3Fen);
    });

    it('returns empty array for invalid PGN', () => {
        const flagged = identifyFlaggedMoves('not a pgn', 'white', new Map());
        expect(flagged).toHaveLength(0);
    });
});

describe('applyOverrides', () => {
    it('sets overridden moves to ok category', () => {
        const drops = new Map<string, EvalDrop>([
            ['fen1', { evalDrop: 40, category: 'inaccuracy' }],
            ['fen2', { evalDrop: 60, category: 'mistake' }],
            ['fen3', { evalDrop: 20, category: 'ok' }],
        ]);
        const suppressed = new Set(['fen1']);

        const result = applyOverrides(drops, suppressed);
        expect(result.get('fen1')!.category).toBe('ok');
        expect(result.get('fen1')!.evalDrop).toBe(40); // preserves original drop value
        expect(result.get('fen2')!.category).toBe('mistake'); // not overridden
        expect(result.get('fen3')!.category).toBe('ok'); // already ok
    });

    it('does not mutate input map', () => {
        const drops = new Map<string, EvalDrop>([
            ['fen1', { evalDrop: 40, category: 'inaccuracy' }],
        ]);
        const suppressed = new Set(['fen1']);

        applyOverrides(drops, suppressed);
        expect(drops.get('fen1')!.category).toBe('inaccuracy'); // unchanged
    });
});
