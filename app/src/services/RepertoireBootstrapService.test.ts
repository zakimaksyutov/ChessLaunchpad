import { describe, it, expect, vi, afterEach } from 'vitest';
import { Chess } from 'chess.js';
import {
    BootstrapGame,
    BootstrapColor,
    BootstrapAccount,
    normalizeGame,
    selectRepertoire,
    serializeBootstrapGames,
    parseBootstrapGames,
    collectBootstrapGames,
} from './RepertoireBootstrapService';
import { ExplorerEvals, toCompactFen } from '../models/ExplorerEvals';

// ── Helpers ──────────────────────────────────────────────────────────

let idCounter = 0;

/**
 * Build a `BootstrapGame` from a SAN list with a position-indexed eval array.
 * `evalsArr` (length = plies + 1) defaults to all-zero (every move sound).
 */
function mkGame(
    color: BootstrapColor,
    createdAt: number,
    sans: string[],
    evalsArr?: (number | null)[],
): BootstrapGame {
    const n = sans.length;
    const analysis = [];
    for (let k = 0; k <= n; k++) {
        const v = evalsArr ? evalsArr[k] : 0;
        analysis.push(v === null || v === undefined ? null : { eval: v });
    }
    return {
        id: `g${idCounter++}`,
        platform: 'lichess',
        color,
        createdAt,
        moves: sans.join(' '),
        analysis,
    };
}

/** Build an artifact from move-prefix → cp entries (prefix [] = start position). */
function mkArtifact(entries: { sans: string[]; cp: number }[]): ExplorerEvals {
    const rec: Record<string, number[]> = {};
    for (const e of entries) {
        const chess = new Chess();
        for (const s of e.sans) chess.move(s);
        rec[toCompactFen(chess.fen())] = [e.cp];
    }
    return ExplorerEvals.fromRecord(rec);
}

function whiteEdgeSans(games: BootstrapGame[]): string[] {
    return selectRepertoire(games, ['white']).white.map(e => e.san);
}

// ── normalizeGame: enrichment + indexing ─────────────────────────────

describe('normalizeGame', () => {
    function lichessGame(over: Partial<Record<string, unknown>>): Record<string, unknown> {
        return {
            id: 'abc',
            createdAt: 1000,
            speed: 'blitz',
            rated: true,
            variant: 'standard',
            players: {
                white: { user: { id: 'alice', name: 'Alice' } },
                black: { user: { id: 'bob', name: 'Bob' } },
            },
            moves: 'e4 c5',
            ...over,
        };
    }

    it('produces a position-indexed analysis of length plies+1 (index 0 = start)', () => {
        const artifact = mkArtifact([{ sans: [], cp: 20 }]);
        const g = normalizeGame(lichessGame({ analysis: [] }), 'lichess', 'alice', artifact);
        expect(g).not.toBeNull();
        expect(g!.color).toBe('white');
        expect(g!.analysis).toHaveLength(3); // start + 2 plies
        expect(g!.analysis[0]).toEqual({ eval: 20 }); // start from artifact
    });

    it('prefers the Lichess per-game eval and fills only the gaps from the artifact', () => {
        // Lichess native analysis: index i = AFTER ply i.
        const analysis = [{ eval: -10 }, { eval: 25 }];
        // Artifact covers start + (different) values for the move positions.
        const artifact = mkArtifact([
            { sans: [], cp: 20 },
            { sans: ['e4'], cp: 999 },
            { sans: ['e4', 'c5'], cp: 888 },
        ]);
        const g = normalizeGame(lichessGame({ analysis }), 'lichess', 'alice', artifact)!;
        expect(g.analysis[0]).toEqual({ eval: 20 });  // start: artifact (Lichess never has it)
        expect(g.analysis[1]).toEqual({ eval: -10 }); // after e4: Lichess wins over 999
        expect(g.analysis[2]).toEqual({ eval: 25 });  // after c5: Lichess wins over 888
    });

    it('fills entirely from the artifact when Lichess has no analysis', () => {
        const artifact = mkArtifact([
            { sans: [], cp: 20 },
            { sans: ['e4'], cp: 30 },
            { sans: ['e4', 'c5'], cp: 28 },
        ]);
        const g = normalizeGame(lichessGame({ analysis: [] }), 'lichess', 'alice', artifact)!;
        expect(g.analysis).toEqual([{ eval: 20 }, { eval: 30 }, { eval: 28 }]);
    });

    it('records null for positions with no eval from any source', () => {
        const artifact = mkArtifact([]); // empty
        const g = normalizeGame(lichessGame({ analysis: [] }), 'lichess', 'alice', artifact)!;
        expect(g.analysis).toEqual([null, null, null]);
    });

    it('coalesces mate evals to a large centipawn value', () => {
        const artifact = mkArtifact([{ sans: [], cp: 0 }]);
        const g = normalizeGame(lichessGame({ analysis: [{ mate: 2 }, { mate: -1 }] }), 'lichess', 'alice', artifact)!;
        expect(g.analysis[1]!.eval).toBeGreaterThan(9000);
        expect(g.analysis[2]!.eval).toBeLessThan(-9000);
    });

    it('returns null when the user color is not derivable', () => {
        const artifact = mkArtifact([]);
        expect(normalizeGame(lichessGame({}), 'lichess', 'carol', artifact)).toBeNull();
    });

    it('derives black color and uses it', () => {
        const artifact = mkArtifact([]);
        const g = normalizeGame(lichessGame({}), 'lichess', 'bob', artifact)!;
        expect(g.color).toBe('black');
    });

    it('normalizes a Chess.com PGN payload (evals entirely from the artifact)', () => {
        const artifact = mkArtifact([
            { sans: [], cp: 15 },
            { sans: ['e4'], cp: 22 },
        ]);
        const pgn = '[White "alice"]\n[Black "bob"]\n\n1. e4 *';
        const gd = { uuid: 'u1', end_time: 5, time_class: 'blitz', rated: true, rules: 'chess',
            white: { username: 'alice' }, black: { username: 'bob' }, pgn };
        const g = normalizeGame(gd, 'chess.com', 'alice', artifact)!;
        expect(g.color).toBe('white');
        expect(g.createdAt).toBe(5000);
        expect(g.moves).toBe('e4');
        expect(g.analysis).toEqual([{ eval: 15 }, { eval: 22 }]);
    });
});

// ── selectRepertoire: gates ──────────────────────────────────────────

describe('selectRepertoire — consistency floor', () => {
    it('seeds nothing when fewer than 3 games reach a position', () => {
        const games = [
            mkGame('white', 1, ['e4']),
            mkGame('white', 2, ['e4']),
        ];
        expect(whiteEdgeSans(games)).toEqual([]);
    });

    it('seeds a move that 3 games unanimously play', () => {
        const games = [
            mkGame('white', 1, ['e4']),
            mkGame('white', 2, ['e4']),
            mkGame('white', 3, ['e4']),
        ];
        expect(whiteEdgeSans(games)).toEqual(['e4']);
    });

    it('stops when the window is not unanimous', () => {
        const games = [
            mkGame('white', 1, ['e4']),
            mkGame('white', 2, ['d4']),
            mkGame('white', 3, ['e4']),
        ];
        expect(whiteEdgeSans(games)).toEqual([]);
    });
});

describe('selectRepertoire — recency window', () => {
    it('uses only the most recent 5 games (abandoned old lines are ignored)', () => {
        // Oldest game plays e4; the most recent 5 unanimously play d4.
        const games = [
            mkGame('white', 1, ['e4']),
            mkGame('white', 2, ['d4']),
            mkGame('white', 3, ['d4']),
            mkGame('white', 4, ['d4']),
            mkGame('white', 5, ['d4']),
            mkGame('white', 6, ['d4']),
        ];
        expect(whiteEdgeSans(games)).toEqual(['d4']);
    });

    it('stops when the most recent 5 are split even if an older majority agrees', () => {
        const games = [
            mkGame('white', 1, ['e4']),
            mkGame('white', 2, ['e4']),
            mkGame('white', 3, ['e4']),
            mkGame('white', 4, ['d4']),
            mkGame('white', 5, ['d4']),
            mkGame('white', 6, ['e4']),
            mkGame('white', 7, ['d4']),
        ];
        // Most recent 5 (ts 3..7): e4,d4,d4,e4,d4 → not unanimous.
        expect(whiteEdgeSans(games)).toEqual([]);
    });
});

describe('selectRepertoire — soundness', () => {
    it('drops a move whose conservative eval drop is an inaccuracy or worse', () => {
        // White: drop = before − after = 20 − (−200) = 220 → blunder.
        const evals = [20, -200];
        const games = [
            mkGame('white', 1, ['e4'], evals),
            mkGame('white', 2, ['e4'], evals),
            mkGame('white', 3, ['e4'], evals),
        ];
        expect(whiteEdgeSans(games)).toEqual([]);
    });

    it('keeps a move at the edge of the ok band (drop < 30cp)', () => {
        // White: drop = 0 − (−29) = 29 → ok.
        const evals = [0, -29];
        const games = [
            mkGame('white', 1, ['e4'], evals),
            mkGame('white', 2, ['e4'], evals),
            mkGame('white', 3, ['e4'], evals),
        ];
        expect(whiteEdgeSans(games)).toEqual(['e4']);
    });

    it('treats a position missing an eval as unknown (not seeded)', () => {
        const evals = [0, null]; // after-eval missing
        const games = [
            mkGame('white', 1, ['e4'], evals),
            mkGame('white', 2, ['e4'], evals),
            mkGame('white', 3, ['e4'], evals),
        ];
        expect(whiteEdgeSans(games)).toEqual([]);
    });

    it('uses the most favorable pairing across the window (conservative)', () => {
        // Every game has a complete before+after pair; one game's drop looks bad
        // but another's is sound → conservative (minimum) across games → kept.
        const games = [
            mkGame('white', 1, ['e4'], [0, -300]),
            mkGame('white', 2, ['e4'], [0, 0]),
            mkGame('white', 3, ['e4'], [0, 0]),
        ];
        expect(whiteEdgeSans(games)).toEqual(['e4']);
    });

    it('never pairs one game\'s "before" with another game\'s "after"', () => {
        // No single game has BOTH evals: game 1 has only before, game 2 only
        // after. A cross-game pairing would (wrongly) look sound; per-game pairing
        // treats the position as unknown → dropped.
        const games = [
            mkGame('white', 1, ['e4'], [10, null]),
            mkGame('white', 2, ['e4'], [null, 10]),
            mkGame('white', 3, ['e4'], [null, null]),
        ];
        expect(whiteEdgeSans(games)).toEqual([]);
    });
});

describe('selectRepertoire — transposition merge', () => {
    // Same black-to-move position Q reached by two White move orders that
    // transpose; only White's move ORDER differs (first move stays 1.d4).
    const ORDER_A = ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'];
    const ORDER_B = ['d4', 'Nf6', 'Nf3', 'e6', 'c4', 'b6'];

    it('merges transposed positions and seeds the shared move once', () => {
        const games = [
            mkGame('black', 1, ORDER_A), mkGame('black', 2, ORDER_A), mkGame('black', 3, ORDER_A),
            mkGame('black', 4, ORDER_B), mkGame('black', 5, ORDER_B), mkGame('black', 6, ORDER_B),
        ];
        const sans = selectRepertoire(games, ['black']).black.map(e => e.san);
        // Both opponent branches after 1.d4 Nf6 survive (3 games each).
        expect(sans).toContain('c4');
        expect(sans).toContain('Nf3');
        // The shared move at the merged position is seeded exactly once (FEN-keyed).
        expect(sans.filter(s => s === 'b6')).toHaveLength(1);
    });

    it('is order-independent (set-union tree → same repertoire regardless of input order)', () => {
        const games = [
            mkGame('black', 1, ORDER_A), mkGame('black', 2, ORDER_A), mkGame('black', 3, ORDER_A),
            mkGame('black', 4, ORDER_B), mkGame('black', 5, ORDER_B), mkGame('black', 6, ORDER_B),
        ];
        const forward = selectRepertoire(games, ['black']);
        const reversed = selectRepertoire([...games].reverse(), ['black']);
        expect(reversed).toEqual(forward);
    });
});

describe('selectRepertoire — opponent branching', () => {
    function whiteGame(ts: number, oppReply: string, userSecond: string): BootstrapGame {
        return mkGame('white', ts, ['e4', oppReply, userSecond]);
    }

    it('branches into a common opponent reply and seeds the user response', () => {
        const games = [
            whiteGame(1, 'c5', 'Nf3'),
            whiteGame(2, 'c5', 'Nf3'),
            whiteGame(3, 'c5', 'Nf3'),
        ];
        expect(whiteEdgeSans(games)).toEqual(['e4', 'c5', 'Nf3']);
    });

    it('prunes a rare opponent reply (below the 3-game floor)', () => {
        const games = [
            whiteGame(1, 'c5', 'Nf3'),
            whiteGame(2, 'c5', 'Nf3'),
            whiteGame(3, 'c5', 'Nf3'),
            whiteGame(4, 'e5', 'Nf3'),
            whiteGame(5, 'e5', 'Nf3'),
        ];
        // e5 only appears twice → pruned; c5 mainline kept.
        expect(whiteEdgeSans(games)).toEqual(['e4', 'c5', 'Nf3']);
    });

    it('prunes a dangling opponent edge whose user follow-up is not unanimous', () => {
        // 3 games face ...c5 (passes the opponent floor) but the user's reply
        // splits → no user move below → the c5 edge is dropped entirely.
        const games = [
            whiteGame(1, 'c5', 'Nf3'),
            whiteGame(2, 'c5', 'c3'),
            whiteGame(3, 'c5', 'Nc3'),
        ];
        expect(whiteEdgeSans(games)).toEqual(['e4']);
    });

    it('prunes an engine-dubious opponent reply', () => {
        // User is white → opponent is black; a black blunder raises White's eval
        // (after ≫ before from White POV) → drop ≥ 30 → pruned.
        // analysis indices: [start, after e4, after oppReply, after Nf3]
        const sound = [0, 0, 0, 0];
        const dubious = [0, 0, 300, 0]; // after the opponent reply White is +300
        const games = [
            mkGame('white', 1, ['e4', 'c5', 'Nf3'], sound),
            mkGame('white', 2, ['e4', 'c5', 'Nf3'], sound),
            mkGame('white', 3, ['e4', 'c5', 'Nf3'], sound),
            mkGame('white', 4, ['e4', 'a5', 'Nf3'], dubious),
            mkGame('white', 5, ['e4', 'a5', 'Nf3'], dubious),
            mkGame('white', 6, ['e4', 'a5', 'Nf3'], dubious),
        ];
        // a5 is frequent enough (3 games) but engine-dubious → pruned.
        expect(whiteEdgeSans(games)).toEqual(['e4', 'c5', 'Nf3']);
    });
});

describe('selectRepertoire — depth cap', () => {
    it('truncates a very long unanimous line to the early opening', () => {
        const longLine = [
            'a3', 'a6', 'b3', 'b6', 'c3', 'c6', 'd3', 'd6', 'e3', 'e6',
            'f3', 'f6', 'g3', 'g6', 'h3', 'h6', 'a4', 'a5', 'b4', 'b5',
            'c4', 'c5', 'd4', 'd5',
        ]; // 24 distinct plies
        const games = [
            mkGame('white', 1, longLine),
            mkGame('white', 2, longLine),
            mkGame('white', 3, longLine),
        ];
        const edges = whiteEdgeSans(games);
        expect(edges.length).toBeLessThan(longLine.length);
        expect(edges.length).toBeLessThanOrEqual(20);
        expect(edges.length).toBeGreaterThanOrEqual(18);
    });
});

describe('selectRepertoire — per-color separation', () => {
    it('only seeds the requested colors', () => {
        const games = [
            mkGame('white', 1, ['e4']),
            mkGame('white', 2, ['e4']),
            mkGame('white', 3, ['e4']),
            mkGame('black', 1, ['e4', 'c5']),
            mkGame('black', 2, ['e4', 'c5']),
            mkGame('black', 3, ['e4', 'c5']),
        ];
        const sel = selectRepertoire(games, ['black']);
        expect(sel.white).toEqual([]);
        expect(sel.black.map(e => e.san)).toEqual(['e4', 'c5']);
    });
});

// ── §5 replayability ─────────────────────────────────────────────────

describe('serialize/parse round-trip', () => {
    it('reproduces the exact same repertoire from the serialized NDJSON', () => {
        const games = [
            mkGame('white', 1, ['e4', 'c5', 'Nf3'], [10, 12, 8, 14]),
            mkGame('white', 2, ['e4', 'c5', 'Nf3'], [10, 12, 8, 14]),
            mkGame('white', 3, ['e4', 'c5', 'Nf3'], [10, 12, 8, 14]),
            mkGame('black', 1, ['d4', 'Nf6'], [5, 6, 7]),
        ];
        const ndjson = serializeBootstrapGames(games);
        const reparsed = parseBootstrapGames(ndjson);
        expect(reparsed).toEqual(games);

        const before = selectRepertoire(games, ['white', 'black']);
        const after = selectRepertoire(reparsed, ['white', 'black']);
        expect(after).toEqual(before);
    });

    it('skips malformed NDJSON lines', () => {
        const ndjson = `${JSON.stringify(mkGame('white', 1, ['e4']))}\n{bad json\n`;
        expect(parseBootstrapGames(ndjson)).toHaveLength(1);
    });
});

// ── §2 collection seam (bulk fetch + global recency cap) ─────────────

describe('collectBootstrapGames', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function lichessLine(username: string, id: string, createdAt: number, over: Partial<Record<string, unknown>> = {}): string {
        return JSON.stringify({
            id, createdAt, speed: 'blitz', rated: true, variant: 'standard',
            players: {
                white: { user: { id: username, name: username } },
                black: { user: { id: 'opp', name: 'opp' } },
            },
            moves: 'e4 e5',
            ...over,
        });
    }

    /** A streamed NDJSON response split mid-text to exercise partial-line buffering. */
    function streamedResponse(text: string): unknown {
        const bytes = new TextEncoder().encode(text);
        const mid = Math.floor(bytes.length / 2);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, mid));
                controller.enqueue(bytes.slice(mid));
                controller.close();
            },
        });
        return { ok: true, status: 200, statusText: 'OK', body, text: async () => text };
    }

    it('keeps only the most-recent games across accounts and filters ineligible ones', async () => {
        const ndjsonA = [
            lichessLine('aaa', 'a-old', 100),
            lichessLine('aaa', 'a-new', 400),
            lichessLine('aaa', 'a-bullet', 500, { speed: 'bullet' }), // ineligible
        ].join('\n') + '\n';
        const ndjsonB = [
            lichessLine('bbb', 'b-mid1', 200),
            lichessLine('bbb', 'b-mid2', 300),
        ].join('\n') + '\n';

        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes('/aaa?') || url.includes('/aaa%')) return streamedResponse(ndjsonA);
            if (url.includes('/bbb?')) return streamedResponse(ndjsonB);
            return { ok: false, status: 404, statusText: 'NF', body: null, text: async () => '' };
        });
        vi.stubGlobal('fetch', fetchMock);

        const accounts: BootstrapAccount[] = [
            { platform: 'lichess', username: 'aaa' },
            { platform: 'lichess', username: 'bbb' },
        ];
        const games = await collectBootstrapGames(accounts, mkArtifact([]), undefined, undefined, { maxGames: 2 });

        // 4 eligible games fetched (the bullet game is filtered); the 2 most-recent
        // across both accounts are kept: a-new (400) and b-mid2 (300), newest first.
        expect(games.map(g => g.id)).toEqual(['a-new', 'b-mid2']);
        expect(games[0].color).toBe('white');
    });

    it('reports progress phases and a download total scaled per account', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes('lichess.org')) {
                return streamedResponse(lichessLine('solo', 'g1', 100) + '\n');
            }
            return { ok: false, status: 404, statusText: 'NF', body: null, text: async () => '' };
        });
        vi.stubGlobal('fetch', fetchMock);

        const phases: string[] = [];
        let downloadTotal = 0;
        await collectBootstrapGames(
            [{ platform: 'lichess', username: 'solo' }],
            mkArtifact([]),
            p => {
                phases.push(p.phase);
                if (p.phase === 'downloading') downloadTotal = p.total;
            },
        );
        expect(phases).toContain('downloading');
        expect(phases).toContain('analyzing');
        expect(downloadTotal).toBe(2000); // one account → up to 2,000
    });
});
