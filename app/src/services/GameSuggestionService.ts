// ---------------------------------------------------------------------------
// GameSuggestionService — the "Suggest a fix" algorithm for the /games page.
//
// Given a played game and the user's repertoire, propose a concrete line to
// add so the user is ready next time. The walk replays the in-repertoire
// prefix, then at the first out-of-repertoire user move scores the masters
// Top-5 and either accepts a good user move (staying on the real game) or
// substitutes a better one and closes the line out at depth 1.
//
// See docs/product-specs/GAMES-SUGGESTION.md for the full specification and
// tools/analyze-position/suggest-score.cjs for the reference move scorer.
// ---------------------------------------------------------------------------

import { Chess } from 'chess.js';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { MastersPositionResult } from './MastersExplorerService';

// ---------------------------------------------------------------------------
// Scoring constants (match GAMES-SUGGESTION.md §"Move-scoring")
// ---------------------------------------------------------------------------

/** dWin softmax temperature over win-margin (win% − loss%, user orientation). */
export const WIN_TAU = 0.25;

/** Per-dimension weights (exponents) for dGames¹ · dWin² · dEval². */
export const SCORE_WEIGHTS = { games: 1, win: 2, eval: 2 } as const;

/**
 * "Good" bar (case b): accept the user's move if its normalized score is at
 * least this share of the Top-5.
 */
export const GOOD_SCORE_THRESHOLD = 0.10;

/**
 * Eval-missing fallback: a candidate whose eval-after is unavailable (our-DB
 * miss *and* cloud-eval 404) is treated as a small disadvantage rather than 0,
 * so a sound popular move is never silently eliminated. Expressed in pawns
 * (user orientation) — ≈ −10 cp.
 */
export const EVAL_MISSING_PAWNS = -0.10;

// ---------------------------------------------------------------------------
// Providers (injected so the algorithm is pure + testable)
// ---------------------------------------------------------------------------

/**
 * Fetch the masters explorer result for a position. Returns `null` or a result
 * with an empty `moves` array when there is genuinely no master data (the walk
 * treats that as "stop and emit the line so far"). A **transient** failure
 * (network / 429 / non-2xx) must instead **throw**, so the suggestion aborts to
 * an error state rather than silently emitting a truncated, authoritative-looking
 * line — mirroring the reference scorer, which aborts on rate-limit.
 */
export type MastersProvider = (fen: string) => Promise<MastersPositionResult | null>;

/**
 * Fetch a single White-POV centipawn eval. Returns the cp, or `null` for a
 * genuine **no-eval** (our-DB miss + cloud 404) which the scorer maps to the
 * ≈ −10 cp eval-missing fallback. A **transient** failure must instead **throw**
 * so the suggestion aborts rather than scoring a rate-limited blip as missing
 * data (which would skew `dEval`).
 */
export type CloudEvalCpProvider = (fen: string) => Promise<number | null>;

export interface SuggestionInput {
    /** Space-separated SAN move list of the played game (`record.m`). */
    sans: string[];
    /** Which color the user played. */
    userColor: 'white' | 'black';
    /** Normalized FEN set of the user-color repertoire (no initial-position seed). */
    repertoireFens: Set<string>;
    /** Static pre-computed evals (White-POV), or `null` when unavailable. */
    explorerEvals: ExplorerEvals | null;
    /** Per-ply embedded evals (`record.ev`), aligned 1:1 with `sans`. */
    embeddedEvals?: (number | null)[];
    masters: MastersProvider;
    cloudEvalCp: CloudEvalCpProvider;
    signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SuggestionPly {
    san: string;
    isWhiteMove: boolean;
    isUserMove: boolean;
    /** Resulting FEN is part of the user's repertoire (greenish highlight). */
    inRepertoire: boolean;
    /** Set only for white moves (1, 2, 3 …). */
    moveNumber?: number;
}

export interface SuggestionResult {
    plies: SuggestionPly[];
    /** Movetext PGN of the suggested line, from the starting position. */
    pgn: string;
    orientation: 'white' | 'black';
}

// ---------------------------------------------------------------------------
// Move scoring
// ---------------------------------------------------------------------------

/** cp/pawns (user orientation) → expected score 0..1 via the logistic. */
function expectedScore(pawnsUserPov: number): number {
    return 1 / (1 + Math.pow(10, -pawnsUserPov / 4));
}

export interface ScoredMove {
    /** Canonical SAN (as produced by chess.js from `fenBefore`). */
    san: string;
    /** from+to(+promotion) key for robust identity matching. */
    uci: string;
    /** Normalized combined score (the five sum to 1). */
    score: number;
}

/**
 * Score the masters Top-5 for the position `fenBefore`, all from the user's
 * orientation. Illegal/unknown candidates are dropped (contribute zero). The
 * returned list is sorted best-first and its scores sum to 1 (unless empty).
 */
export async function scoreMastersMoves(
    fenBefore: string,
    masters: MastersPositionResult,
    userWhite: boolean,
    resolveEvalAfterCp: (fenAfter: string) => Promise<number | null>,
): Promise<ScoredMove[]> {
    const top5 = masters.moves.slice(0, 5);

    interface Row {
        san: string;
        uci: string;
        games: number;
        margin: number;
        evES: number;
    }
    const rows: Row[] = [];

    for (const mv of top5) {
        const probe = new Chess(fenBefore);
        let played;
        try {
            played = probe.move(mv.san);
        } catch {
            played = null;
        }
        if (!played) continue; // illegal from this FEN — drop (contributes zero)

        const games = mv.total;
        if (games <= 0) continue;
        const userWins = userWhite ? mv.white : mv.black;
        const oppWins = userWhite ? mv.black : mv.white;
        const margin = (userWins - oppWins) / games;

        const cp = await resolveEvalAfterCp(normalizeFenResetHalfmoveClock(probe.fen()));
        const pawns = cp === null ? EVAL_MISSING_PAWNS : (userWhite ? cp : -cp) / 100;

        rows.push({
            san: played.san,
            uci: played.from + played.to + (played.promotion ?? ''),
            games,
            margin,
            evES: expectedScore(pawns),
        });
    }

    if (rows.length === 0) return [];

    const sumGames = rows.reduce((a, r) => a + r.games, 0);
    const maxMargin = Math.max(...rows.map(r => r.margin));
    const winExp = rows.map(r => Math.exp((r.margin - maxMargin) / WIN_TAU));
    const sumWin = winExp.reduce((a, b) => a + b, 0) || 1;
    const sumEvES = rows.reduce((a, r) => a + r.evES, 0) || 1;

    const raws = rows.map((r, i) => {
        const dG = r.games / sumGames;
        const dW = winExp[i] / sumWin;
        const dE = r.evES / sumEvES;
        return Math.pow(dG, SCORE_WEIGHTS.games) * Math.pow(dW, SCORE_WEIGHTS.win) * Math.pow(dE, SCORE_WEIGHTS.eval);
    });
    const sumRaw = raws.reduce((a, b) => a + b, 0) || 1;

    return rows
        .map((r, i) => ({ san: r.san, uci: r.uci, score: raws[i] / sumRaw }))
        .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function uciOf(fenBefore: string, san: string): string | null {
    const probe = new Chess(fenBefore);
    try {
        const m = probe.move(san);
        return m ? m.from + m.to + (m.promotion ?? '') : null;
    } catch {
        return null;
    }
}

/**
 * Compute a repertoire-fix suggestion for a played game.
 *
 * The walk always starts from the initial position and replays the in-repertoire
 * prefix as-is. The first ply that leaves the repertoire is either the user's
 * (deviation) or — on the EOT rows this feature is offered on — the opponent's
 * sound book-leaving move, which is appended before advancing to the user's
 * reply. From the first out-of-repertoire user move the walk scores the masters
 * Top-5 and either keeps a good user move (staying on the real game) or
 * substitutes a better one and closes out at depth 1.
 */
export async function computeSuggestion(input: SuggestionInput): Promise<SuggestionResult> {
    const { sans, userColor, repertoireFens, signal } = input;
    const userWhite = userColor === 'white';

    const throwIfAborted = () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };

    // Eval-after resolver: static → embedded → cloud-eval, memoized per call.
    const embeddedByFen = new Map<string, number>();
    {
        const replay = new Chess();
        for (let i = 0; i < sans.length; i++) {
            let m;
            try {
                m = replay.move(sans[i]);
            } catch {
                m = null;
            }
            if (!m) break;
            const cp = input.embeddedEvals?.[i];
            if (cp !== undefined && cp !== null) {
                embeddedByFen.set(normalizeFenResetHalfmoveClock(replay.fen()), cp);
            }
        }
    }
    const evalCache = new Map<string, number | null>();
    const resolveEvalAfterCp = async (fenAfterNorm: string): Promise<number | null> => {
        if (evalCache.has(fenAfterNorm)) return evalCache.get(fenAfterNorm) ?? null;
        let cp: number | null = input.explorerEvals?.lookup(fenAfterNorm) ?? null;
        if (cp === null && embeddedByFen.has(fenAfterNorm)) cp = embeddedByFen.get(fenAfterNorm)!;
        if (cp === null) {
            throwIfAborted();
            cp = await input.cloudEvalCp(fenAfterNorm);
        }
        evalCache.set(fenAfterNorm, cp);
        return cp;
    };

    const mastersCache = new Map<string, MastersPositionResult | null>();
    const getMasters = async (fen: string): Promise<MastersPositionResult | null> => {
        const key = normalizeFenResetHalfmoveClock(fen);
        if (mastersCache.has(key)) return mastersCache.get(key) ?? null;
        throwIfAborted();
        const res = await input.masters(fen);
        mastersCache.set(key, res);
        return res;
    };

    const board = new Chess();
    const plies: SuggestionPly[] = [];

    const appendMove = (san: string): boolean => {
        let move;
        try {
            move = board.move(san);
        } catch {
            move = null;
        }
        if (!move) return false;
        const isWhiteMove = move.color === 'w';
        const plyIndex = plies.length;
        plies.push({
            san: move.san,
            isWhiteMove,
            isUserMove: isWhiteMove === userWhite,
            inRepertoire: repertoireFens.has(normalizeFenResetHalfmoveClock(board.fen())),
            moveNumber: isWhiteMove ? Math.floor(plyIndex / 2) + 1 : undefined,
        });
        return true;
    };

    const finalize = (): SuggestionResult => ({
        plies,
        pgn: board.pgn(),
        orientation: userColor,
    });

    // 1. Replay the in-repertoire prefix.
    let i = 0;
    while (i < sans.length) {
        const probe = new Chess(board.fen());
        let probed;
        try {
            probed = probe.move(sans[i]);
        } catch {
            probed = null;
        }
        if (!probed) return finalize(); // corrupt SAN — bail with what we have
        if (repertoireFens.has(normalizeFenResetHalfmoveClock(probe.fen()))) {
            appendMove(sans[i]);
            i++;
            continue;
        }
        break; // sans[i] is the first out-of-repertoire ply
    }

    if (i >= sans.length) return finalize(); // entire game was in repertoire

    // The first out-of-repertoire ply: opponent (EOT) or user (deviation).
    const firstOutIsUser = (board.turn() === 'w') === userWhite;
    if (!firstOutIsUser) {
        // Opponent's sound, book-leaving move — append as-is, advance to reply.
        if (!appendMove(sans[i])) return finalize();
        i++;
    }

    // Close out the line at depth 1 from the chosen replacement user move.
    const closeOutLine = async (chosenSan: string): Promise<void> => {
        if (!appendMove(chosenSan)) return;

        const oppData = await getMasters(board.fen());
        const oppTop = oppData?.moves?.[0];
        if (!oppTop || !appendMove(oppTop.san)) return;

        const data2 = await getMasters(board.fen());
        if (!data2 || data2.moves.length === 0) return;
        const scored2 = await scoreMastersMoves(board.fen(), data2, userWhite, resolveEvalAfterCp);
        if (scored2.length === 0) return;
        appendMove(scored2[0].san);
    };

    // 2. Walk the out-of-repertoire user moves.
    while (i < sans.length) {
        throwIfAborted();

        // Defensive: if it is not the user's turn, stay on the real game.
        if ((board.turn() === 'w') !== userWhite) {
            if (!appendMove(sans[i])) return finalize();
            i++;
            continue;
        }

        const fenBefore = board.fen();
        const mastersData = await getMasters(fenBefore);
        if (!mastersData || mastersData.moves.length === 0) break; // no master games — stop

        const scored = await scoreMastersMoves(fenBefore, mastersData, userWhite, resolveEvalAfterCp);
        if (scored.length === 0) break;

        const userUci = uciOf(fenBefore, sans[i]);
        const userScored = userUci ? scored.find(s => s.uci === userUci) : undefined;

        if (!userScored) {
            // (a) User's move is not in masters Top-5 — substitute + close out.
            await closeOutLine(scored[0].san);
            break;
        }

        if (userScored.score >= GOOD_SCORE_THRESHOLD) {
            // (b)-good — accept the user's move, stay on the real game.
            if (!appendMove(sans[i])) return finalize();
            i++;
            if (i < sans.length) {
                // Append the opponent's actual reply and re-check the next user ply.
                if (!appendMove(sans[i])) return finalize();
                i++;
            }
            continue;
        }

        // (b)-not-good — substitute the best move and close out. Reaching here
        // implies the user's move is not `scored[0]`: the Top-5 scores sum to 1,
        // so `scored[0] >= 1/N >= 0.2 >= GOOD_SCORE_THRESHOLD` and a `scored[0]`
        // user move would have been accepted above. Hence `find(uci !== userUci)`
        // yields the best (non-user) move — never the second-best.
        const replacement = scored.find(s => s.uci !== userUci) ?? scored[0];
        await closeOutLine(replacement.san);
        break;
    }

    return finalize();
}
