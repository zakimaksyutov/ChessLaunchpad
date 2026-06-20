import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { FrozenAnnotation } from '../models/RepertoireData';
import { categorizeEvalDrop, computeConservativeDrop, EvalDrop, EvalDropCategory } from './EvalDropService';
import type { Platform } from './LinkedAccountsService';
import { parseChesscomTimeControl } from './ChesscomTimeControl';
import type { MoveStats } from './MastersExplorerService';

/**
 * Duck-typed interface for masters data lookup. `isOutOfTheory` may be async so
 * the analysis pass can fetch a verdict **on demand** (the engine awaits it):
 * the in-memory `MastersLookup` resolves synchronously, while the pass's
 * on-demand lookup hits the network only at the ambiguous plies the walk
 * actually reaches. `getMoveStats` is consulted right after a non-null verdict,
 * so it reads from whatever `isOutOfTheory` already resolved — always sync.
 */
export interface MastersLookupLike {
    getMoveStats(fen: string, moveSan: string): MoveStats | null;
    isOutOfTheory(fen: string, moveSan: string): boolean | null | Promise<boolean | null>;
}

/**
 * On-demand cloud-eval resolver. Returns White-POV centipawn value(s) for a
 * FEN, or `null` when no eval is available (a miss). May be async — the engine
 * awaits it only at plies that explorer and embedded analysis both miss, and
 * only until its stop conditions end the walk, so the settled tail of a game is
 * never queried.
 */
export type CloudEvalProvider = (fen: string) => number[] | null | Promise<number[] | null>;

/**
 * When the opponent plays a move out of the user's repertoire, we check the
 * opponent's eval drop to decide whether the position is still "in overall
 * theory" (a reasonable line worth studying) or "out of theory" (a blunder
 * that leaves no meaningful theory to analyse).
 *
 * If the opponent's drop ≥ this threshold the position is considered out of
 * theory and we stop highlighting the user's subsequent moves.
 * 45 cp ≈ 0.45 pawns.
 */
const OUT_OF_THEORY_THRESHOLD = 45;

/**
 * Opponent moves with eval drops below this threshold are considered clearly
 * reasonable ("in theory") and don't need a masters database check.
 * 15 cp ≈ 0.15 pawns.
 */
const AMBIGUOUS_THEORY_THRESHOLD = 15;

/** Large cp value used when analysis reports a forced mate. */
const MATE_CP = 10_000;

type EvalSource = 'explorer' | 'embedded' | 'cloud' | 'none';

/**
 * Extract per-ply centipawn evals from the Lichess `analysis` array.
 *
 * Lichess games fetched with `evals: true` include an `analysis` array where
 * each element corresponds to a half-move (ply) and has `{eval: cp}` or
 * `{mate: N}`. Values are from **White's perspective**.
 *
 * Returns a lookup function: `(plyIndex) => cp | null`.
 */
export function extractEmbeddedEvals(
    gameData: Record<string, unknown>
): ((plyIndex: number) => number | null) | null {
    const analysis = gameData.analysis as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(analysis) || analysis.length === 0) return null;

    return (plyIndex: number): number | null => {
        const entry = analysis[plyIndex];
        if (!entry || typeof entry !== 'object') return null;

        if (typeof entry.eval === 'number') return entry.eval;
        if (typeof entry.mate === 'number') {
            return entry.mate > 0 ? MATE_CP : -MATE_CP;
        }
        return null;
    };
}

interface EvalLookupResult {
    beforeVals: number[];
    afterVals: number[];
    source: EvalSource;
}

/**
 * Resolve eval values for a single position, trying sources in priority order:
 * ExplorerEvals (static) → embedded per-ply analysis → cloud.
 *
 * `embeddedPly` is the ply index whose Lichess `analysis[ply]` entry holds
 * this position's eval (the position *after* that ply is played). Explorer and
 * cloud key by FEN, so `embeddedPly` is ignored by them. `cloudEval` is the
 * only async source and is consulted last, so a fully-static position never
 * awaits. Returns `null` when no source has the position.
 */
async function resolveFenVals(
    fen: string,
    embeddedPly: number,
    evals: ExplorerEvals | null,
    embeddedEvals: ((plyIndex: number) => number | null) | null,
    cloudEval?: CloudEvalProvider,
    cloudEvalSink?: Map<number, number>
): Promise<{ vals: number[]; source: EvalSource } | null> {
    if (evals) {
        const vals = evals.lookupAll(fen);
        if (vals && vals.length > 0) return { vals, source: 'explorer' };
    }
    if (embeddedEvals) {
        const cp = embeddedEvals(embeddedPly);
        if (cp !== null) return { vals: [cp], source: 'embedded' };
    }
    if (cloudEval) {
        const vals = await cloudEval(fen);
        if (vals && vals.length > 0) {
            // Record the cloud hit keyed by its ply so the pass can persist it
            // into `record.ev` (indices align 1:1 with `ev`). `embeddedPly < 0`
            // is the pre-game "before" of ply 0 — it has no `ev` slot, so skip.
            if (embeddedPly >= 0) cloudEvalSink?.set(embeddedPly, vals[0]);
            return { vals, source: 'cloud' };
        }
    }
    return null;
}

/** Source precedence for labeling a (possibly mixed-source) before/after pair. */
function pickEvalSource(before: EvalSource, after: EvalSource): EvalSource {
    if (before === 'cloud' || after === 'cloud') return 'cloud';
    if (before === 'embedded' || after === 'embedded') return 'embedded';
    return 'explorer';
}

/**
 * Look up eval values for a before/after position pair.
 *
 * Same-source pairs are tried first (ExplorerEvals for both, then embedded for
 * both) so fully-covered positions keep their exact prior behavior and source
 * label — and never touch the (async) cloud. When neither same-source pair is
 * complete, each side is resolved independently across explorer → embedded →
 * cloud, so sources may mix — e.g. an explorer "before" with a cloud "after"
 * for a deviation into an off-book position. `computeConservativeDrop`
 * tolerates differing value counts.
 *
 * `cloudEval` (when supplied) is awaited only here, only for the side(s) the
 * static sources miss — the engine's own stop conditions then close the walk,
 * so the cloud API is never hit for the settled tail of a game.
 */
async function lookupEvals(
    fenBefore: string,
    fenAfter: string,
    plyIndex: number,
    evals: ExplorerEvals | null,
    embeddedEvals: ((plyIndex: number) => number | null) | null,
    cloudEval?: CloudEvalProvider,
    cloudEvalSink?: Map<number, number>
): Promise<EvalLookupResult | null> {
    // Source 1: ExplorerEvals for both sides.
    if (evals) {
        const beforeVals = evals.lookupAll(fenBefore);
        const afterVals = evals.lookupAll(fenAfter);
        if (beforeVals && afterVals && beforeVals.length > 0 && afterVals.length > 0) {
            return { beforeVals, afterVals, source: 'explorer' };
        }
    }

    // Source 2: Embedded game analysis for both sides.
    // Lichess analysis[i] = eval of position AFTER ply i is played. So for a
    // move at plyIndex: before = analysis[plyIndex - 1], after = analysis[plyIndex].
    if (embeddedEvals) {
        const beforeCp = embeddedEvals(plyIndex - 1);
        const afterCp = embeddedEvals(plyIndex);
        if (beforeCp !== null && afterCp !== null) {
            return { beforeVals: [beforeCp], afterVals: [afterCp], source: 'embedded' };
        }
    }

    // Source 3: per-side resolution (sources may mix), with cloud as the final
    // fallback. Reached only when neither same-source pair was complete — this
    // is where on-demand cloud fetches happen.
    const before = await resolveFenVals(fenBefore, plyIndex - 1, evals, embeddedEvals, cloudEval, cloudEvalSink);
    const after = await resolveFenVals(fenAfter, plyIndex, evals, embeddedEvals, cloudEval, cloudEvalSink);
    if (before && after) {
        return {
            beforeVals: before.vals,
            afterVals: after.vals,
            source: pickEvalSource(before.source, after.source),
        };
    }
    return null;
}

type MoveHighlight = 'in-repertoire' | 'deviation' | 'out-of-repertoire-response' | 'out-of-repertoire' | 'out-of-theory';

export interface AnnotatedMove {
    /** SAN of the move */
    san: string;
    /** Move number (set only for white moves, e.g. 1, 2, 3…) */
    moveNumber?: number;
    /** Whether this is a white move */
    isWhiteMove: boolean;
    /** Whether this is the user's move (based on game color) */
    isUserMove: boolean;
    /** Highlighting category */
    highlight: MoveHighlight;
    /** Eval drop info (only for deviation moves with eval data) */
    evalDrop?: EvalDrop;
    /** Which eval source provided data for this move's eval drop */
    evalSource?: EvalSource;
    /**
     * Normalized FEN (half-move clock reset) of the position after this move.
     * Used to deep-link in-repertoire user moves into the Explorer.
     */
    fenAfter?: string;
}

/** Info about the first user deviation from repertoire */
interface DeviationInfo {
    /** FEN of the position before the deviation (after opponent's move) */
    fen: string;
    /** The move the user actually played (red arrow) */
    userMove: { from: string; to: string; san: string };
    /** Moves from this position that stay in repertoire (green arrows) */
    repertoireMoves: { from: string; to: string; san: string }[];
}

export interface GameAnnotation {
    moves: AnnotatedMove[];
    /** FEN for the mini board display */
    miniBoardFen: string;
    /**
     * Half-move depth of `miniBoardFen` — the number of plies replayed from
     * the game start to reach the displayed position. Frozen into `fan.mb`
     * so render can replay the board without re-deriving the anchor rule.
     */
    miniBoardPly: number;
    /** Orientation for the mini board */
    miniBoardOrientation: 'white' | 'black';
    /** Deviation details for arrow display on the mini board */
    deviation?: DeviationInfo;
}

/**
 * Determine which color the user played in a game.
 * Supports both Lichess NDJSON format and Chess.com format.
 */
export function getUserColor(
    gameData: Record<string, unknown>,
    username: string,
    platform: Platform
): 'white' | 'black' | null {
    if (platform === 'chess.com') {
        return getUserColorChesscom(gameData, username);
    }

    return getUserColorLichess(gameData, username);
}

/**
 * Get user color from Lichess NDJSON format.
 * Lichess has players.white.user.id and players.black.user.id.
 */
function getUserColorLichess(
    gameData: Record<string, unknown>,
    username: string
): 'white' | 'black' | null {
    const players = gameData.players as Record<string, unknown> | undefined;
    if (!players) return null;

    const white = players.white as Record<string, unknown> | undefined;
    const black = players.black as Record<string, unknown> | undefined;

    const whiteUser = white?.user as Record<string, unknown> | undefined;
    const blackUser = black?.user as Record<string, unknown> | undefined;

    const whiteId = (whiteUser?.id as string || '').toLowerCase();
    const blackId = (blackUser?.id as string || '').toLowerCase();
    const normalizedUsername = username.toLowerCase();

    if (whiteId === normalizedUsername) return 'white';
    if (blackId === normalizedUsername) return 'black';

    // Also check the 'name' field as fallback
    const whiteName = (whiteUser?.name as string || '').toLowerCase();
    const blackName = (blackUser?.name as string || '').toLowerCase();

    if (whiteName === normalizedUsername) return 'white';
    if (blackName === normalizedUsername) return 'black';

    return null;
}

/**
 * Get user color from Chess.com format.
 * Chess.com has white.username and black.username at the top level.
 */
function getUserColorChesscom(
    gameData: Record<string, unknown>,
    username: string
): 'white' | 'black' | null {
    const white = gameData.white as Record<string, unknown> | undefined;
    const black = gameData.black as Record<string, unknown> | undefined;
    const normalizedUsername = username.toLowerCase();

    const whiteUsername = ((white?.username as string) || '').toLowerCase();
    const blackUsername = ((black?.username as string) || '').toLowerCase();

    if (whiteUsername === normalizedUsername) return 'white';
    if (blackUsername === normalizedUsername) return 'black';

    return null;
}

/**
 * Parse the game's moves from the Lichess NDJSON `moves` field (space-separated SAN).
 * Returns the PGN string.
 */
function buildPgnFromLichessData(gameData: Record<string, unknown>): string | null {
    const movesStr = gameData.moves as string | undefined;
    if (!movesStr || typeof movesStr !== 'string') return null;

    const sans = movesStr.split(/\s+/).filter(Boolean);
    const chess = new Chess();

    for (const san of sans) {
        try {
            chess.move(san);
        } catch {
            break;
        }
    }

    return chess.pgn();
}

/**
 * Parse PGN from Chess.com game data.
 * Chess.com provides a full PGN string with headers.
 */
function buildPgnFromChesscomData(gameData: Record<string, unknown>): string | null {
    const pgn = gameData.pgn as string | undefined;
    if (!pgn || typeof pgn !== 'string') return null;

    let chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        // Try stripping comments (Chess.com PGNs often have clock annotations)
        try {
            const cleaned = pgn.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ');
            chess = new Chess();
            chess.loadPgn(cleaned);
        } catch {
            return null;
        }
    }

    return chess.pgn();
}

/**
 * Build PGN from game data, dispatching based on platform.
 */
export function buildPgn(gameData: Record<string, unknown>, platform: Platform): string | null {
    if (platform === 'chess.com') {
        return buildPgnFromChesscomData(gameData);
    }
    return buildPgnFromLichessData(gameData);
}

/** Return the opponent's display name as provided by the source platform. */
function getOpponentName(
    gameData: Record<string, unknown>,
    userColor: 'white' | 'black',
    platform: Platform
): string {
    const opponentColor = userColor === 'white' ? 'black' : 'white';
    if (platform === 'chess.com') {
        return getPlayerInfoChesscom(gameData, opponentColor).name;
    }
    const players = gameData.players as Record<string, unknown> | undefined;
    return getPlayerInfo(players, opponentColor).name;
}

/**
 * Find the repertoire continuations authored from a position: legal moves whose
 * resulting position is itself in the repertoire FEN set. An empty result means
 * the position is a repertoire *leaf* (a node with no authored continuation,
 * e.g. a line that ends on an opponent move), so there is nothing to deviate
 * from.
 */
function findRepertoireContinuations(
    fenBefore: string,
    repertoireFens: Set<string>
): { from: string; to: string; san: string }[] {
    const continuations: { from: string; to: string; san: string }[] = [];
    for (const lm of new Chess(fenBefore).moves({ verbose: true })) {
        const probe = new Chess(fenBefore);
        probe.move(lm);
        if (repertoireFens.has(normalizeFenResetHalfmoveClock(probe.fen()))) {
            continuations.push({ from: lm.from, to: lm.to, san: lm.san });
        }
    }
    return continuations;
}

/**
 * Annotate a game's moves against the user's repertoire FEN set.
 *
 * @param gameData Raw Lichess NDJSON object
 * @param username Lichess username (for determining user's color)
 * @param repertoireFens Set of normalized FENs for the user's color in this game
 * @param evals ExplorerEvals instance for eval-drop computation
 * @param maxPlies Maximum plies to display (spec says ~20 or until theory ends, whichever is longer)
 */
export async function annotateGame(
    gameData: Record<string, unknown>,
    username: string,
    repertoireFens: Set<string>,
    evals: ExplorerEvals | null,
    maxPlies: number = 30,
    platform: Platform,
    mastersLookup?: MastersLookupLike,
    debug?: boolean,
    cloudEval?: CloudEvalProvider,
    cloudEvalSink?: Map<number, number>
): Promise<GameAnnotation | null> {
    const gameId = gameData.id as string | undefined;
    const userColor = getUserColor(gameData, username, platform);
    if (!userColor) {
        return null;
    }

    const opponentName = getOpponentName(gameData, userColor, platform);
    const debugThis = debug === true;

    const pgn = buildPgn(gameData, platform);
    if (!pgn) {
        if (debugThis) console.log(`[annotate ${gameId}] Could not build PGN`);
        return null;
    }

    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        if (debugThis) console.log(`[annotate ${gameId}] Failed to parse PGN`);
        return null;
    }
    chess.deleteComments();

    const allMoves = chess.history({ verbose: true });
    const temp = new Chess();

    const embeddedEvals = extractEmbeddedEvals(gameData);
    if (debugThis) console.groupCollapsed(`[annotate ${gameId}] ${username} as ${userColor} vs ${opponentName}, repertoire size=${repertoireFens.size}, moves=${allMoves.length}, hasEmbeddedEvals=${embeddedEvals !== null}`);

    const moves: AnnotatedMove[] = [];
    let postTheoryAnalysis = false;
    let theoryEndPly = 0;
    let moveNumber = 1;

    // Track first notable event for mini board
    let firstPostTheoryFen: string | null = null;
    let firstEvalDropFen: string | null = null;
    let lastInRepertoireFen: string | null = null;
    let deviation: DeviationInfo | undefined;
    // Ply depths matching each mini-board candidate FEN above, so the frozen
    // annotation can store an anchor index (`fan.mb`) instead of a FEN.
    let firstPostTheoryPly = 0;
    let firstEvalDropPly = 0;
    let lastInRepertoirePly = 0;
    let deviationPly = 0;

    for (let i = 0; i < allMoves.length; i++) {
        const isWhiteMove = i % 2 === 0;
        const isUserMove =
            (userColor === 'white' && isWhiteMove) ||
            (userColor === 'black' && !isWhiteMove);

        const fenBefore = temp.fen();
        const normalizedFenBefore = normalizeFenResetHalfmoveClock(fenBefore);

        temp.move(allMoves[i]);

        const fenAfter = temp.fen();
        const normalizedFenAfter = normalizeFenResetHalfmoveClock(fenAfter);

        // Build move number
        const currentMoveNumber = isWhiteMove ? moveNumber : undefined;
        if (!isWhiteMove) {
            moveNumber++;
        }

        // Determine highlighting
        let highlight: MoveHighlight;
        let evalDrop: EvalDrop | undefined;
        let evalSource: EvalSource | undefined;
        let reason: string;

        if (repertoireFens.has(normalizedFenAfter)) {
            // Position after move is in repertoire → green (handles transpositions back)
            highlight = 'in-repertoire';
            lastInRepertoireFen = fenAfter;
            lastInRepertoirePly = i + 1;
            theoryEndPly = i + 1;
            postTheoryAnalysis = false;
            reason = 'after-FEN in repertoire';
        } else if (isUserMove && repertoireFens.has(normalizedFenBefore)) {
            // Before-FEN is in the repertoire but the user's move left it. This
            // is only a real *deviation* when the repertoire authors at least
            // one continuation from here; a user-to-move leaf (e.g. a line that
            // ends on an opponent move) has nothing to deviate from.
            const repertoireMoves = findRepertoireContinuations(fenBefore, repertoireFens);

            if (repertoireMoves.length === 0) {
                // Repertoire leaf — the user's authored theory ends here, so
                // there is no book move to deviate from. Don't stop: grade this
                // move (and let subsequent moves be graded) just like a
                // post-theory response, so a mistake here still surfaces.
                highlight = 'out-of-repertoire-response';
                reason = 'before-FEN is a repertoire leaf (no authored continuation) → post-theory analysis';
                postTheoryAnalysis = true;

                if (!firstPostTheoryFen) {
                    firstPostTheoryFen = fenAfter;
                    firstPostTheoryPly = i + 1;
                }

                const evalResult = await lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals, cloudEval, cloudEvalSink);
                if (evalResult) {
                    const drop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                    const category = categorizeEvalDrop(drop);
                    evalDrop = { evalDrop: drop, category };
                    evalSource = evalResult.source;
                    reason += `, evalDrop=${drop.toFixed(2)} (${category}) [source: ${evalResult.source}]`;

                    if (!firstEvalDropFen && category !== 'ok') {
                        firstEvalDropFen = fenAfter;
                        firstEvalDropPly = i + 1;
                    }

                    // Stop after the first notable eval drop, same as a post-theory response.
                    if (category !== 'ok') {
                        postTheoryAnalysis = false;
                        reason += ' → stop (first notable drop)';
                    }
                } else {
                    reason += ', no eval data for drop calc';
                }
            } else {
                // User deviated from repertoire (before-FEN was in repertoire, after-FEN is not)
                highlight = 'deviation';
                reason = 'before-FEN in repertoire but after-FEN is NOT → user deviated';

                if (!deviation) {
                    deviation = {
                        fen: fenBefore,
                        userMove: { from: allMoves[i].from, to: allMoves[i].to, san: allMoves[i].san },
                        repertoireMoves,
                    };
                    deviationPly = i;
                }

                if (!firstPostTheoryFen) {
                    firstPostTheoryFen = fenAfter;
                    firstPostTheoryPly = i + 1;
                }

                // Compute eval drop for the deviation
                const evalResult = await lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals, cloudEval, cloudEvalSink);
                if (evalResult) {
                    const drop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                    const category = categorizeEvalDrop(drop);
                    evalDrop = { evalDrop: drop, category };
                    evalSource = evalResult.source;
                    reason += `, evalDrop=${drop.toFixed(2)} (${category}) [source: ${evalResult.source}]`;

                    if (!firstEvalDropFen && category !== 'ok') {
                        firstEvalDropFen = fenAfter;
                        firstEvalDropPly = i + 1;
                    }
                } else {
                    reason += ', no eval data for drop calc';
                }
            }
        } else if (!isUserMove && repertoireFens.has(normalizedFenBefore) && !repertoireFens.has(normalizedFenAfter)) {
            // Opponent left the user's repertoire.
            // Three-zone classification:
            //   ≥ 45 cp → out of theory
            //   15–44 cp → ambiguous, check masters DB
            //   < 15 cp → in theory
            theoryEndPly = i;
            reason = 'opponent left repertoire';

            const evalResult = await lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals, cloudEval, cloudEvalSink);
            if (evalResult) {
                const oppDrop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                if (oppDrop >= OUT_OF_THEORY_THRESHOLD) {
                    highlight = 'out-of-theory';
                    postTheoryAnalysis = false;
                    reason += `, opponent drop=${oppDrop.toFixed(2)} >= ${OUT_OF_THEORY_THRESHOLD} → out of theory, stop [source: ${evalResult.source}]`;
                } else if (oppDrop < AMBIGUOUS_THEORY_THRESHOLD) {
                    highlight = 'out-of-repertoire';
                    postTheoryAnalysis = true;
                    reason += `, opponent drop=${oppDrop.toFixed(2)} < ${AMBIGUOUS_THEORY_THRESHOLD} → clearly in theory, analyse user moves [source: ${evalResult.source}]`;
                } else {
                    // Ambiguous zone: 15 ≤ drop < 45 — check masters DB
                    const mastersVerdict = await mastersLookup?.isOutOfTheory(fenBefore, allMoves[i].san);
                    if (mastersVerdict === true) {
                        highlight = 'out-of-theory';
                        postTheoryAnalysis = false;
                        const stats = mastersLookup!.getMoveStats(fenBefore, allMoves[i].san)!;
                        reason += `, opponent drop=${oppDrop.toFixed(2)} (ambiguous), masters: ${stats.moveGames} games (${stats.percentage.toFixed(1)}%) → out of theory [source: ${evalResult.source}+masters]`;
                    } else if (mastersVerdict === false) {
                        highlight = 'out-of-repertoire';
                        postTheoryAnalysis = true;
                        const stats = mastersLookup!.getMoveStats(fenBefore, allMoves[i].san)!;
                        reason += `, opponent drop=${oppDrop.toFixed(2)} (ambiguous), masters: ${stats.moveGames} games (${stats.percentage.toFixed(1)}%) → in theory [source: ${evalResult.source}+masters]`;
                    } else {
                        // No masters data — optimistic default, collect for async patching
                        highlight = 'out-of-repertoire';
                        postTheoryAnalysis = true;
                        reason += `, opponent drop=${oppDrop.toFixed(2)} (ambiguous, ${AMBIGUOUS_THEORY_THRESHOLD}–${OUT_OF_THEORY_THRESHOLD}), no masters data → default in theory [source: ${evalResult.source}]`;
                    }
                }
            } else {
                // No eval from any source — including a Lichess cloud-eval miss
                // (404), which means the position is too rare for anyone on
                // Lichess to have analysed it. Treat it as out of theory and
                // stop, rather than the old optimistic "still book" default.
                highlight = 'out-of-theory';
                postTheoryAnalysis = false;
                reason += ', no eval data for opponent drop → out of theory, stop';
            }
        } else if (postTheoryAnalysis && isUserMove) {
            // User move after opponent left repertoire but still in theory — evaluate for eval drop
            highlight = 'out-of-repertoire-response';
            reason = 'user move after opponent left repertoire (still in theory)';

            if (!firstPostTheoryFen) {
                firstPostTheoryFen = fenAfter;
                firstPostTheoryPly = i + 1;
            }

            const evalResult = await lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals, cloudEval, cloudEvalSink);
            if (evalResult) {
                const drop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                const category = categorizeEvalDrop(drop);
                evalDrop = { evalDrop: drop, category };
                evalSource = evalResult.source;
                reason += `, evalDrop=${drop.toFixed(2)} (${category}) [source: ${evalResult.source}]`;

                if (!firstEvalDropFen && category !== 'ok') {
                    firstEvalDropFen = fenAfter;
                    firstEvalDropPly = i + 1;
                }

                // Stop after first notable eval drop — only the first inaccuracy/mistake/blunder matters
                if (category !== 'ok') {
                    postTheoryAnalysis = false;
                    reason += ' → stop (first notable drop)';
                }
            } else {
                reason += ', no eval data for drop calc';
            }
        } else if (postTheoryAnalysis && !isUserMove) {
            // Subsequent opponent move — three-zone check
            reason = 'opponent move (still in theory)';

            const evalResult = await lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals, cloudEval, cloudEvalSink);
            if (evalResult) {
                const oppDrop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                if (oppDrop >= OUT_OF_THEORY_THRESHOLD) {
                    highlight = 'out-of-theory';
                    postTheoryAnalysis = false;
                    reason += `, opponent drop=${oppDrop.toFixed(2)} >= ${OUT_OF_THEORY_THRESHOLD} → out of theory, stop [source: ${evalResult.source}]`;
                } else if (oppDrop < AMBIGUOUS_THEORY_THRESHOLD) {
                    highlight = 'out-of-repertoire';
                    reason += `, opponent drop=${oppDrop.toFixed(2)} < ${AMBIGUOUS_THEORY_THRESHOLD} → clearly in theory [source: ${evalResult.source}]`;
                } else {
                    // Ambiguous zone: check masters DB
                    const mastersVerdict = await mastersLookup?.isOutOfTheory(fenBefore, allMoves[i].san);
                    if (mastersVerdict === true) {
                        highlight = 'out-of-theory';
                        postTheoryAnalysis = false;
                        const stats = mastersLookup!.getMoveStats(fenBefore, allMoves[i].san)!;
                        reason += `, opponent drop=${oppDrop.toFixed(2)} (ambiguous), masters: ${stats.moveGames} games (${stats.percentage.toFixed(1)}%) → out of theory [source: ${evalResult.source}+masters]`;
                    } else if (mastersVerdict === false) {
                        highlight = 'out-of-repertoire';
                        const stats = mastersLookup!.getMoveStats(fenBefore, allMoves[i].san)!;
                        reason += `, opponent drop=${oppDrop.toFixed(2)} (ambiguous), masters: ${stats.moveGames} games (${stats.percentage.toFixed(1)}%) → in theory [source: ${evalResult.source}+masters]`;
                    } else {
                        highlight = 'out-of-repertoire';
                        reason += `, opponent drop=${oppDrop.toFixed(2)} (ambiguous, ${AMBIGUOUS_THEORY_THRESHOLD}–${OUT_OF_THEORY_THRESHOLD}), no masters data → default in theory [source: ${evalResult.source}]`;
                    }
                }
            } else {
                // No eval from any source (incl. a cloud 404) → too rare to be
                // theory; stop, same as the opponent's first departure above.
                highlight = 'out-of-theory';
                postTheoryAnalysis = false;
                reason += ', no eval data for opponent drop → out of theory, stop';
            }
        } else {
            highlight = 'out-of-theory';
            reason = `out of theory: beforeInRep=${repertoireFens.has(normalizedFenBefore)}, afterInRep=${repertoireFens.has(normalizedFenAfter)}, isUser=${isUserMove}`;
        }

        if (debugThis) console.log(
            `  ply ${i}: ${allMoves[i].san} [${isUserMove ? 'USER' : 'OPP'}] → ${highlight} | ${reason}`
        );

        moves.push({
            san: allMoves[i].san,
            moveNumber: currentMoveNumber,
            isWhiteMove,
            isUserMove,
            highlight,
            evalDrop,
            evalSource,
            fenAfter: normalizedFenAfter,
        });

        // Stop after maxPlies or theory end + some buffer
        const effectiveMax = Math.max(maxPlies, theoryEndPly + 4);
        if (i + 1 >= effectiveMax) break;
    }

    if (debugThis) console.groupEnd();

    // Determine mini board position (spec §3.3)
    // For user deviations, show the position BEFORE the deviation (with arrows)
    let miniBoardFen: string;
    let miniBoardPly: number;
    if (deviation) {
        miniBoardFen = deviation.fen;
        miniBoardPly = deviationPly;
    } else if (firstPostTheoryFen) {
        miniBoardFen = firstPostTheoryFen;
        miniBoardPly = firstPostTheoryPly;
    } else if (firstEvalDropFen) {
        miniBoardFen = firstEvalDropFen;
        miniBoardPly = firstEvalDropPly;
    } else if (lastInRepertoireFen) {
        miniBoardFen = lastInRepertoireFen;
        miniBoardPly = lastInRepertoirePly;
    } else {
        miniBoardFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        miniBoardPly = 0;
    }

    return {
        moves,
        miniBoardFen,
        miniBoardPly,
        miniBoardOrientation: userColor,
        deviation,
    };
}

interface PlayerInfo {
    name: string;
    rating: number | undefined;
}

function getPlayerInfo(
    players: Record<string, unknown> | undefined,
    side: 'white' | 'black'
): PlayerInfo {
    const sideData = (players?.[side] as Record<string, unknown>) ?? {};
    const user = (sideData.user as Record<string, unknown>) ?? {};
    const name = (user.name as string) || (user.id as string) || 'Unknown';
    const rating = sideData.rating as number | undefined;
    return { name, rating };
}

function getPlayerInfoChesscom(
    gameData: Record<string, unknown>,
    side: 'white' | 'black'
): PlayerInfo {
    const sideData = (gameData[side] as Record<string, unknown>) ?? {};
    const name = (sideData.username as string) || 'Unknown';
    const rating = sideData.rating as number | undefined;
    return { name, rating };
}

export interface GameMetadata {
    whiteName: string;
    whiteRating: number | undefined;
    blackName: string;
    blackRating: number | undefined;
    result: 'win' | 'draw' | 'loss';
    timeControl: string;
    speed: string;
    rated: boolean;
    openingName: string;
    createdAt: number;
    userColor: 'white' | 'black' | null;
    /** URL to view the game on its platform */
    gameUrl: string;
    platform: Platform;
}

const CHESSCOM_DRAW_RESULTS = new Set([
    'agreed',
    'repetition',
    'stalemate',
    'insufficient',
    '50move',
    'timevsinsufficient',
    'drawn',
]);

/**
 * Extract game metadata for display. Handles both Lichess and Chess.com formats.
 */
export function getGameMetadata(
    gameData: Record<string, unknown>,
    username: string,
    platform: Platform
): GameMetadata {
    if (platform === 'chess.com') {
        return getGameMetadataChesscom(gameData, username);
    }

    return getGameMetadataLichess(gameData, username);
}

function getGameMetadataLichess(gameData: Record<string, unknown>, username: string): GameMetadata {
    const userColor = getUserColorLichess(gameData, username);
    const players = gameData.players as Record<string, unknown> | undefined;

    const white = getPlayerInfo(players, 'white');
    const black = getPlayerInfo(players, 'black');

    // Result from user's perspective
    const winner = gameData.winner as string | undefined;
    const status = gameData.status as string | undefined;
    let result: 'win' | 'draw' | 'loss';
    if (!winner || status === 'draw' || status === 'stalemate') {
        result = 'draw';
    } else if (winner === userColor) {
        result = 'win';
    } else {
        result = 'loss';
    }

    // Time control
    const clock = gameData.clock as Record<string, unknown> | undefined;
    let timeControl = '';
    if (clock && typeof clock.initial === 'number' && typeof clock.increment === 'number') {
        const initial = clock.initial / 60; // seconds to minutes
        const increment = clock.increment;
        timeControl = `${initial}+${increment}`;
    }

    // Speed (game type)
    const speed = (gameData.speed as string) || '';

    // Rated
    const rated = gameData.rated as boolean ?? false;

    // Opening
    const opening = gameData.opening as Record<string, unknown> | undefined;
    const openingName = (opening?.name as string) || '';

    // Date
    const createdAt = gameData.createdAt as number;

    // Game URL
    const gameId = gameData.id as string || '';
    const gameUrl = `https://lichess.org/${gameId}${userColor === 'black' ? '/black' : ''}`;

    return {
        whiteName: white.name,
        whiteRating: white.rating,
        blackName: black.name,
        blackRating: black.rating,
        result,
        timeControl,
        speed,
        rated,
        openingName,
        createdAt,
        userColor,
        gameUrl,
        platform: 'lichess',
    };
}

function getGameMetadataChesscom(gameData: Record<string, unknown>, username: string): GameMetadata {
    const userColor = getUserColorChesscom(gameData, username);

    const white = getPlayerInfoChesscom(gameData, 'white');
    const black = getPlayerInfoChesscom(gameData, 'black');

    // Result from user's perspective
    let result: 'win' | 'draw' | 'loss';
    if (userColor) {
        const opponentColor = userColor === 'white' ? 'black' : 'white';
        const userSide = gameData[userColor] as Record<string, unknown> | undefined;
        const opponentSide = gameData[opponentColor] as Record<string, unknown> | undefined;
        const userResult = (userSide?.result as string) || '';
        const opponentResult = (opponentSide?.result as string) || '';

        if (userResult === 'win') {
            result = 'win';
        } else if (opponentResult === 'win') {
            result = 'loss';
        } else if (CHESSCOM_DRAW_RESULTS.has(userResult) || CHESSCOM_DRAW_RESULTS.has(opponentResult)) {
            result = 'draw';
        } else {
            result = 'loss';
        }
    } else {
        result = 'draw'; // Fallback when user color can't be determined
    }

    // Time control
    const timeControl = parseChesscomTimeControl((gameData.time_control as string) || '');

    // Speed (time class)
    const speed = (gameData.time_class as string) || '';

    // Rated
    const rated = gameData.rated as boolean ?? false;

    // Opening - Chess.com doesn't provide opening in the game object,
    // but the PGN headers may have it
    let openingName = '';
    const pgn = gameData.pgn as string | undefined;
    if (pgn) {
        const openingMatch = pgn.match(/\[ECOUrl "[^"]*\/([^"]+)"\]/);
        if (openingMatch) {
            openingName = openingMatch[1].replace(/-/g, ' ');
        }
    }

    // Date
    const createdAt = (gameData.end_time as number) * 1000;

    // Game URL
    const gameUrl = (gameData.url as string) || '';

    return {
        whiteName: white.name,
        whiteRating: white.rating,
        blackName: black.name,
        blackRating: black.rating,
        result,
        timeControl,
        speed,
        rated,
        openingName,
        createdAt,
        userColor,
        gameUrl,
        platform: 'chess.com',
    };
}

// ---------------------------------------------------------------------------
// End-of-theory position derivation (for opponent analysis)
// ---------------------------------------------------------------------------

interface EotPositions {
    /** Normalized FEN of position before the user's bad move (after opponent's move) */
    fenBefore: string;
    /** Normalized FEN of position after the user's bad move */
    fenAfter: string;
    /** SAN of the preceding opponent move (e.g., "Nxe4") */
    opponentSan: string;
    /** SAN of the user's bad move (e.g., "exd6") */
    userSan: string;
    /** Eval drop category of the user's bad move */
    userMoveCategory: EvalDropCategory;
    /** Index of the user's bad move in annotation.moves[] */
    moveIndex: number;
    /** Ply index (0-based) of the user's bad move — used to cap replay depth */
    targetPly: number;
}

/**
 * Derive the critical FENs for the first out-of-repertoire eval-drop move.
 *
 * This is used by the opponent analysis feature: it replays the game PGN
 * to extract the positions before and after the user's bad move so we can
 * search the opponent's game history for matching positions.
 */
export function deriveEotPositions(
    gameData: Record<string, unknown>,
    annotation: GameAnnotation,
    platform: Platform
): EotPositions | null {
    // Find the first out-of-repertoire-response with a non-ok eval drop
    let eotIndex = -1;
    for (let i = 0; i < annotation.moves.length; i++) {
        const m = annotation.moves[i];
        if (m.highlight === 'out-of-repertoire-response' && m.evalDrop && m.evalDrop.category !== 'ok') {
            eotIndex = i;
            break;
        }
    }
    if (eotIndex < 0) return null;

    // Find the preceding opponent move
    let opponentSan: string | null = null;
    for (let j = eotIndex - 1; j >= 0; j--) {
        if (!annotation.moves[j].isUserMove) {
            opponentSan = annotation.moves[j].san;
            break;
        }
    }
    if (!opponentSan) return null;

    // Replay PGN to extract FENs at the eotIndex position
    const pgn = buildPgn(gameData, platform);
    if (!pgn) return null;

    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        return null;
    }
    chess.deleteComments();

    const allMoves = chess.history({ verbose: true });
    if (eotIndex >= allMoves.length) return null;

    const replay = new Chess();
    for (let i = 0; i < eotIndex; i++) {
        replay.move(allMoves[i]);
    }

    const fenBefore = normalizeFenResetHalfmoveClock(replay.fen());
    replay.move(allMoves[eotIndex]);
    const fenAfter = normalizeFenResetHalfmoveClock(replay.fen());

    return {
        fenBefore,
        fenAfter,
        opponentSan,
        userSan: annotation.moves[eotIndex].san,
        userMoveCategory: annotation.moves[eotIndex].evalDrop!.category,
        moveIndex: eotIndex,
        targetPly: eotIndex,
    };
}

// ---------------------------------------------------------------------------
// Frozen annotation (`fan`) — freeze/thaw between a live GameAnnotation and
// the stored per-game record. See the "Frozen Annotation (`fan`)" section of
// docs/product-specs/GAMES.md
// ---------------------------------------------------------------------------

/**
 * Highlight code for a user move, as stored in `fan.hl`. Opponent moves carry
 * no code. Codes intentionally match the GAMES.md highlight-codes table:
 *   0 in-repertoire | 1 deviation | 2 post-theory ok | 3 inaccuracy
 *   4 mistake | 5 blunder | 7 out-of-theory.
 * (Code `6`, out-of-repertoire, only applies to opponent moves and is never
 * stored.)
 */
function userMoveToCode(move: AnnotatedMove): number {
    switch (move.highlight) {
        case 'in-repertoire':
            return 0;
        case 'deviation':
            return 1;
        case 'out-of-repertoire-response':
            switch (move.evalDrop?.category) {
                case 'inaccuracy': return 3;
                case 'mistake': return 4;
                case 'blunder': return 5;
                default: return 2; // 'ok' or no eval data
            }
        case 'out-of-theory':
        case 'out-of-repertoire':
            return 7;
    }
}

/** Reconstruct a user move's `{highlight, evalDrop}` from a stored `hl` code. */
function codeToHighlight(code: number): { highlight: MoveHighlight; evalDrop?: EvalDrop } {
    switch (code) {
        case 0: return { highlight: 'in-repertoire' };
        case 1: return { highlight: 'deviation' };
        case 2: return { highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'ok' } };
        case 3: return { highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'inaccuracy' } };
        case 4: return { highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'mistake' } };
        case 5: return { highlight: 'out-of-repertoire-response', evalDrop: { evalDrop: 0, category: 'blunder' } };
        case 7:
        default:
            return { highlight: 'out-of-theory' };
    }
}

/**
 * Freeze a live `GameAnnotation` into the storable `fan` shape: per-user-move
 * highlight codes, the deviation alternatives (SAN, when present), and the
 * mini-board anchor ply. This is the analysis-time write path; render never
 * calls it.
 */
export function annotationToFrozen(annotation: GameAnnotation): FrozenAnnotation {
    const hl: number[] = [];
    for (const move of annotation.moves) {
        if (!move.isUserMove) continue;
        hl.push(userMoveToCode(move));
    }
    const fan: FrozenAnnotation = { hl, mb: annotation.miniBoardPly };
    const alt = annotation.deviation?.repertoireMoves.map(rm => rm.san);
    if (alt && alt.length > 0) fan.alt = alt;
    return fan;
}

/**
 * Thaw a stored `fan` back into a `GameAnnotation` for rendering — a pure
 * function of `fan`, the SAN move list `m`, and the user's color. No
 * repertoire, evals, or masters lookups. The display window is `fan.hl`:
 * replay `m`, assigning codes to user moves in order, and stop after the last
 * user move that `hl` covers.
 *
 * On an unparseable SAN the replay stops early and returns the moves built so
 * far (defensive — `m` is validated at ingest).
 */
export function buildAnnotationFromFrozen(
    fan: FrozenAnnotation,
    sans: string[],
    userColor: 'white' | 'black',
): GameAnnotation {
    const moves: AnnotatedMove[] = [];
    const replay = new Chess();
    let userMoveIdx = 0;
    let moveNumber = 1;
    let deviationPly = -1;

    for (let i = 0; i < sans.length; i++) {
        const isWhiteMove = i % 2 === 0;
        const isUserMove =
            (userColor === 'white' && isWhiteMove) ||
            (userColor === 'black' && !isWhiteMove);

        const currentMoveNumber = isWhiteMove ? moveNumber : undefined;
        if (!isWhiteMove) moveNumber++;

        let highlight: MoveHighlight;
        let evalDrop: EvalDrop | undefined;
        if (isUserMove) {
            // Window ends at the last user move covered by `hl`.
            if (userMoveIdx >= fan.hl.length) break;
            const code = fan.hl[userMoveIdx];
            userMoveIdx++;
            const mapped = codeToHighlight(code);
            highlight = mapped.highlight;
            evalDrop = mapped.evalDrop;
            if (code === 1 && deviationPly < 0) deviationPly = i;
        } else {
            // Opponent moves always render neutral — the value is unused.
            highlight = 'out-of-theory';
        }

        let moved;
        try {
            moved = replay.move(sans[i]);
        } catch {
            break;
        }
        if (!moved) break;

        moves.push({
            san: moved.san,
            moveNumber: currentMoveNumber,
            isWhiteMove,
            isUserMove,
            highlight,
            evalDrop,
            fenAfter: normalizeFenResetHalfmoveClock(replay.fen()),
        });

        if (isUserMove && userMoveIdx >= fan.hl.length) break;
    }

    return finishFrozen(moves, fan, sans, userColor, deviationPly);
}

/** Assemble the mini-board FEN + deviation arrows for a thawed annotation. */
function finishFrozen(
    moves: AnnotatedMove[],
    fan: FrozenAnnotation,
    sans: string[],
    userColor: 'white' | 'black',
    deviationPly: number,
): GameAnnotation {
    // Mini-board position: replay `mb` plies of `m`.
    const mbReplay = new Chess();
    const mb = Math.max(0, Math.min(fan.mb, sans.length));
    for (let k = 0; k < mb; k++) {
        try {
            if (!mbReplay.move(sans[k])) break;
        } catch {
            break;
        }
    }
    const miniBoardFen = mbReplay.fen();

    let deviation: DeviationInfo | undefined;
    if (deviationPly >= 0) {
        // Replay to the position before the deviation ply to recover squares.
        const devReplay = new Chess();
        let ok = true;
        for (let k = 0; k < deviationPly; k++) {
            try {
                if (!devReplay.move(sans[k])) { ok = false; break; }
            } catch {
                ok = false;
                break;
            }
        }
        if (ok) {
            const fenBefore = devReplay.fen();
            const repertoireMoves: { from: string; to: string; san: string }[] = [];
            for (const altSan of fan.alt ?? []) {
                const probe = new Chess(fenBefore);
                try {
                    const m = probe.move(altSan);
                    if (m) repertoireMoves.push({ from: m.from, to: m.to, san: m.san });
                } catch {
                    /* skip an alt that no longer parses */
                }
            }
            let userMove = { from: '', to: '', san: sans[deviationPly] ?? '' };
            try {
                const played = devReplay.move(sans[deviationPly]);
                if (played) userMove = { from: played.from, to: played.to, san: played.san };
            } catch {
                /* keep SAN-only fallback */
            }
            deviation = { fen: fenBefore, userMove, repertoireMoves };
        }
    }

    return {
        moves,
        miniBoardFen,
        miniBoardPly: mb,
        miniBoardOrientation: userColor,
        deviation,
    };
}
