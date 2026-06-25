import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
    computeSuggestion,
    scoreMastersMoves,
    GOOD_SCORE_THRESHOLD,
    MastersProvider,
    CloudEvalCpProvider,
} from './GameSuggestionService';
import { MastersPositionResult } from './MastersExplorerService';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalized FEN reached by replaying `sans` from the start. */
function fenAfter(sans: string[]): string {
    const c = new Chess();
    for (const s of sans) c.move(s);
    return normalizeFenResetHalfmoveClock(c.fen());
}

type Entry = [san: string, white: number, draws: number, black: number];

function mkMasters(entries: Entry[]): MastersPositionResult {
    const moves = entries.map(([san, white, draws, black]) => ({
        san,
        white,
        draws,
        black,
        total: white + draws + black,
    }));
    return {
        fen: '',
        totalGames: moves.reduce((a, m) => a + m.total, 0),
        moves,
    };
}

/** Build a masters provider keyed by normalized FEN. */
function mastersFromMap(map: Map<string, MastersPositionResult | null>): MastersProvider {
    return async (fen: string) => map.get(normalizeFenResetHalfmoveClock(fen)) ?? null;
}

const noCloud: CloudEvalCpProvider = async () => null;

const buildRepFens = (lines: string[][]) => new Set(lines.map(l => fenAfter(l)));

// ---------------------------------------------------------------------------
// scoreMastersMoves
// ---------------------------------------------------------------------------

describe('scoreMastersMoves', () => {
    const startFen = new Chess().fen();

    it('normalizes the Top-5 scores to sum to 1, sorted best-first', async () => {
        const masters = mkMasters([
            ['e4', 5000, 3000, 2000],
            ['d4', 4000, 3000, 2000],
            ['Nf3', 1000, 800, 700],
            ['c4', 800, 600, 500],
            ['g3', 100, 80, 60],
        ]);
        const scored = await scoreMastersMoves(startFen, masters, true, async () => null);
        expect(scored.length).toBe(5);
        const sum = scored.reduce((a, s) => a + s.score, 0);
        expect(sum).toBeCloseTo(1, 6);
        for (let i = 1; i < scored.length; i++) {
            expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
        }
    });

    it('eval-after breaks ties between equally popular, equal-margin moves', async () => {
        // Two identical-popularity, identical-margin moves; only eval differs.
        const masters = mkMasters([
            ['e4', 3000, 2000, 1000],
            ['d4', 3000, 2000, 1000],
        ]);
        const evalByFen = new Map<string, number>();
        evalByFen.set(fenAfter(['e4']), 80);  // +0.8 (White POV)
        evalByFen.set(fenAfter(['d4']), -20);  // -0.2
        const resolve = async (fen: string) => evalByFen.get(normalizeFenResetHalfmoveClock(fen)) ?? null;
        const scored = await scoreMastersMoves(startFen, masters, true, resolve);
        expect(scored[0].san).toBe('e4');
        expect(scored[0].score).toBeGreaterThan(scored[1].score);
    });

    it('drops illegal candidates (contributes zero / drops out)', async () => {
        const masters = mkMasters([
            ['e4', 3000, 2000, 1000],
            ['Qh5', 10, 5, 5],       // illegal from start position
        ]);
        const scored = await scoreMastersMoves(startFen, masters, true, async () => null);
        expect(scored.map(s => s.san)).toEqual(['e4']);
        expect(scored[0].score).toBeCloseTo(1, 6);
    });
});

// ---------------------------------------------------------------------------
// computeSuggestion — branch (a): user move off-book
// ---------------------------------------------------------------------------

describe('computeSuggestion — branch (a) user move not in Top-5', () => {
    it('replays the in-rep prefix, appends opponent EOT move, substitutes + closes out at depth 1', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const sans = ['e4', 'e5', 'Nf3', 'd6', 'h4', 'Nf6'];

        const map = new Map<string, MastersPositionResult | null>();
        // User ply position (after Nf3 d6) — h4 is NOT in this list → branch (a).
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), mkMasters([
            ['d4', 6000, 3000, 1000],
            ['Bc4', 1000, 800, 700],
            ['c3', 300, 200, 100],
            ['Nc3', 200, 100, 80],
            ['g3', 50, 30, 20],
        ]));
        // After substituted d4 — opponent top reply.
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6', 'd4']), mkMasters([
            ['exd4', 4000, 1000, 1000],
            ['Nf6', 500, 300, 200],
        ]));
        // After d4 exd4 — best next user move.
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4']), mkMasters([
            ['Nxd4', 3000, 1500, 1000],
            ['Qxd4', 200, 100, 80],
        ]));

        const result = await computeSuggestion({
            sans,
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: noCloud,
        });

        expect(result.plies.map(p => p.san)).toEqual(['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4', 'Nxd4']);
        // Prefix is in-repertoire; everything from the opponent's EOT move is not.
        expect(result.plies.map(p => p.inRepertoire)).toEqual([true, true, true, false, false, false, false]);
        // Move numbers on white moves.
        expect(result.plies[0].moveNumber).toBe(1);
        expect(result.plies[2].moveNumber).toBe(2);
        expect(result.plies[4].moveNumber).toBe(3);
        // The substituted move is not the user's actual h4.
        expect(result.plies[4].san).not.toBe('h4');
        expect(result.pgn).toContain('1. e4 e5');
    });
});

// ---------------------------------------------------------------------------
// computeSuggestion — branch (b): user move in Top-5
// ---------------------------------------------------------------------------

describe('computeSuggestion — branch (b) user move in Top-5', () => {
    it('keeps a good user move, stays on the real game, then stops when masters runs out', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const sans = ['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4', 'Nxd4'];

        const map = new Map<string, MastersPositionResult | null>();
        // User ply (after Nf3 d6): d4 is the dominant top move → "good".
        // Kept under 5k games so this exercises the scoring path, not the
        // popularity short-circuit (covered separately below).
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), mkMasters([
            ['d4', 2000, 1000, 500],
            ['Bc4', 100, 80, 60],
            ['c3', 50, 40, 30],
        ]));
        // Next user ply (after d4 exd4): no master games → stop.
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4']), mkMasters([]));

        const result = await computeSuggestion({
            sans,
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: noCloud,
        });

        // prefix (3) + opponent d6 + user's good d4 + opponent's real exd4, then stop.
        expect(result.plies.map(p => p.san)).toEqual(['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4']);
        // The accepted d4 is the user's actual move.
        expect(result.plies[4].san).toBe('d4');
    });

    it('accepts a Top-5 user move with > 5k games via the popularity short-circuit (no eval queries)', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const sans = ['e4', 'e5', 'Nf3', 'd6', 'd4'];

        const map = new Map<string, MastersPositionResult | null>();
        // d4 is in the Top-5 with > 5,000 games → accepted as-is, no scoring.
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), mkMasters([
            ['d4', 9000, 4000, 2000],
            ['Bc4', 100, 80, 60],
        ]));

        let evalCalls = 0;
        const countingCloud: CloudEvalCpProvider = async () => { evalCalls++; return null; };

        const result = await computeSuggestion({
            sans,
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: countingCloud,
        });

        // prefix (3) + opponent d6 + accepted d4, then the game ends.
        expect(result.plies.map(p => p.san)).toEqual(['e4', 'e5', 'Nf3', 'd6', 'd4']);
        expect(result.plies[4].san).toBe('d4');
        // The short-circuit means no eval lookups happened.
        expect(evalCalls).toBe(0);
    });

    it('substitutes when the user move is in Top-5 but below the good bar', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        // User plays g3 (in Top-5 but weakest) at the EOT user ply.
        const sans = ['e4', 'e5', 'Nf3', 'd6', 'g3'];

        const map = new Map<string, MastersPositionResult | null>();
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), mkMasters([
            ['d4', 9000, 1000, 500],
            ['Bc4', 4000, 1000, 800],
            ['Bb5+', 3000, 800, 700],
            ['c3', 2000, 700, 600],
            ['g3', 30, 10, 60],      // few games, losing margin → score below the bar
        ]));
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6', 'd4']), mkMasters([
            ['exd4', 4000, 1000, 1000],
        ]));
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4']), mkMasters([
            ['Nxd4', 3000, 1500, 1000],
        ]));

        // Confirm the premise: g3's normalized score is below the good bar.
        const scored = await scoreMastersMoves(
            fenAfter(['e4', 'e5', 'Nf3', 'd6']),
            map.get(fenAfter(['e4', 'e5', 'Nf3', 'd6']))!,
            true,
            noCloud,
        );
        expect(scored.find(s => s.san === 'g3')!.score).toBeLessThan(GOOD_SCORE_THRESHOLD);

        const result = await computeSuggestion({
            sans,
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: noCloud,
        });

        // g3 replaced by d4, then closed out at depth 1.
        expect(result.plies.map(p => p.san)).toEqual(['e4', 'e5', 'Nf3', 'd6', 'd4', 'exd4', 'Nxd4']);
        expect(result.plies.some(p => p.san === 'g3')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// computeSuggestion — edge cases
// ---------------------------------------------------------------------------

describe('computeSuggestion — edge cases', () => {
    it('stops with the prefix + opponent move when the user position has no master games', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const sans = ['e4', 'e5', 'Nf3', 'd6', 'h4'];
        const map = new Map<string, MastersPositionResult | null>();
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), null); // no data

        const result = await computeSuggestion({
            sans,
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: noCloud,
        });

        expect(result.plies.map(p => p.san)).toEqual(['e4', 'e5', 'Nf3', 'd6']);
    });

    it('handles a black-orientation user (margins flip)', async () => {
        // User is Black. Repertoire: 1.e4 c5 2.Nf3 d6, then White leaves book with 3.b3.
        const repFens = buildRepFens([
            ['e4'], ['e4', 'c5'], ['e4', 'c5', 'Nf3'], ['e4', 'c5', 'Nf3', 'd6'],
        ]);
        const sans = ['e4', 'c5', 'Nf3', 'd6', 'b3', 'a6'];

        const map = new Map<string, MastersPositionResult | null>();
        // Black to move after 1.e4 c5 2.Nf3 d6 3.b3 — a6 not in Top-5 → branch (a).
        map.set(fenAfter(['e4', 'c5', 'Nf3', 'd6', 'b3']), mkMasters([
            ['e5', 2000, 1000, 2500],   // good for Black (more black wins)
            ['Nc6', 1500, 1000, 1400],
            ['e6', 1000, 800, 900],
        ]));
        map.set(fenAfter(['e4', 'c5', 'Nf3', 'd6', 'b3', 'e5']), mkMasters([
            ['Bb2', 1500, 500, 1000],
        ]));
        map.set(fenAfter(['e4', 'c5', 'Nf3', 'd6', 'b3', 'e5', 'Bb2']), mkMasters([
            ['Nc6', 1000, 600, 1200],
        ]));

        const result = await computeSuggestion({
            sans,
            userColor: 'black',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: noCloud,
        });

        expect(result.plies.map(p => p.san)).toEqual(['e4', 'c5', 'Nf3', 'd6', 'b3', 'e5', 'Bb2', 'Nc6']);
        expect(result.plies.map(p => p.inRepertoire)).toEqual([true, true, true, true, false, false, false, false]);
        // The user (Black) moves are the substituted e5 and the closing Nc6.
        expect(result.plies[5].isUserMove).toBe(true);
        expect(result.plies[5].san).toBe('e5');
    });

    it('aborts when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const map = new Map<string, MastersPositionResult | null>();
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), mkMasters([['d4', 1, 1, 1]]));
        await expect(computeSuggestion({
            sans: ['e4', 'e5', 'Nf3', 'd6', 'h4'],
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: noCloud,
            signal: controller.signal,
        })).rejects.toThrow();
    });

    it('propagates a transient masters failure (rejects) instead of emitting a partial line', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const masters: MastersProvider = async () => {
            throw new Error('masters explorer unavailable');
        };
        await expect(computeSuggestion({
            sans: ['e4', 'e5', 'Nf3', 'd6', 'h4'],
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters,
            cloudEvalCp: noCloud,
        })).rejects.toThrow('masters explorer unavailable');
    });

    it('propagates a transient cloud-eval failure (rejects) instead of scoring it as eval-missing', async () => {
        const repFens = buildRepFens([['e4'], ['e4', 'e5'], ['e4', 'e5', 'Nf3']]);
        const map = new Map<string, MastersPositionResult | null>();
        map.set(fenAfter(['e4', 'e5', 'Nf3', 'd6']), mkMasters([
            ['d4', 6000, 3000, 1000],
            ['Bc4', 1000, 800, 700],
        ]));
        const throwingCloud: CloudEvalCpProvider = async () => {
            throw new Error('cloud-eval unavailable');
        };
        await expect(computeSuggestion({
            sans: ['e4', 'e5', 'Nf3', 'd6', 'h4'],
            userColor: 'white',
            repertoireFens: repFens,
            explorerEvals: null,
            masters: mastersFromMap(map),
            cloudEvalCp: throwingCloud,
        })).rejects.toThrow('cloud-eval unavailable');
    });
});
