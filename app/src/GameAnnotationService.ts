import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { ExplorerEvals } from './ExplorerEvals';
import { categorizeEvalDrop, computeConservativeDrop, EvalDrop, EvalDropCategory } from './EvalDropService';
import type { Platform } from './LinkedAccountsService';
import { parseChesscomTimeControl } from './ChesscomGamesService';
import type { MoveStats } from './MastersExplorerService';

/** Duck-typed interface for masters data lookup (satisfied by both MastersLookup and MastersCache). */
export interface MastersLookupLike {
    getMoveStats(fen: string, moveSan: string): MoveStats | null;
    isOutOfTheory(fen: string, moveSan: string): boolean | null;
}

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

export type EvalSource = 'explorer' | 'embedded' | 'cloud' | 'none';

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
 * Look up eval values for a before/after position pair, trying sources in priority order:
 * 1. ExplorerEvals (static repertoire data)
 * 2. Embedded game analysis (Lichess per-ply evals)
 *
 * Cloud evals (source 3) are handled asynchronously in a separate pass.
 */
function lookupEvals(
    fenBefore: string,
    fenAfter: string,
    plyIndex: number,
    evals: ExplorerEvals | null,
    embeddedEvals: ((plyIndex: number) => number | null) | null
): EvalLookupResult | null {
    // Source 1: ExplorerEvals
    if (evals) {
        const beforeVals = evals.lookupAll(fenBefore);
        const afterVals = evals.lookupAll(fenAfter);
        if (beforeVals && afterVals && beforeVals.length > 0 && afterVals.length > 0) {
            return { beforeVals, afterVals, source: 'explorer' };
        }
    }

    // Source 2: Embedded game analysis
    if (embeddedEvals) {
        // Lichess analysis[i] = eval of position AFTER ply i is played.
        // For a move at plyIndex:
        //   before = position after ply (plyIndex - 1) = analysis[plyIndex - 1]
        //   after  = position after ply plyIndex       = analysis[plyIndex]
        const beforeCp = embeddedEvals(plyIndex - 1);
        const afterCp = embeddedEvals(plyIndex);
        if (beforeCp !== null && afterCp !== null) {
            return { beforeVals: [beforeCp], afterVals: [afterCp], source: 'embedded' };
        }
    }

    return null;
}

export type MoveHighlight = 'in-repertoire' | 'deviation' | 'out-of-repertoire-response' | 'out-of-repertoire' | 'out-of-theory';

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
}

/** Info about the first user deviation from repertoire */
export interface DeviationInfo {
    /** FEN of the position before the deviation (after opponent's move) */
    fen: string;
    /** The move the user actually played (red arrow) */
    userMove: { from: string; to: string; san: string };
    /** Moves from this position that stay in repertoire (green arrows) */
    repertoireMoves: { from: string; to: string; san: string }[];
}

export interface MissingEvalPosition {
    /** Index into the moves[] array */
    moveIndex: number;
    /** Ply index (0-based) */
    plyIndex: number;
    fenBefore: string;
    fenAfter: string;
    isWhiteMove: boolean;
}

/** Opponent move in the ambiguous eval-drop zone (15–44 cp) needing masters DB check. */
export interface AmbiguousTheoryPosition {
    /** Index into the moves[] array */
    moveIndex: number;
    /** Ply index (0-based) */
    plyIndex: number;
    /** FEN before the opponent's move (position to query masters API) */
    fenBefore: string;
    /** The opponent's move in SAN */
    moveSan: string;
}

export interface GameAnnotation {
    moves: AnnotatedMove[];
    /** FEN for the mini board display */
    miniBoardFen: string;
    /** Orientation for the mini board */
    miniBoardOrientation: 'white' | 'black';
    /** Deviation details for arrow display on the mini board */
    deviation?: DeviationInfo;
    /** Positions where eval data was needed but unavailable from sources 1+2 */
    missingEvalPositions?: MissingEvalPosition[];
    /** Opponent moves in the ambiguous zone (15–44 cp) that need masters DB verification */
    ambiguousTheoryPositions?: AmbiguousTheoryPosition[];
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

    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        // Try stripping comments (Chess.com PGNs often have clock annotations)
        try {
            const cleaned = pgn.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ');
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
function buildPgn(gameData: Record<string, unknown>, platform: Platform): string | null {
    if (platform === 'chess.com') {
        return buildPgnFromChesscomData(gameData);
    }
    return buildPgnFromLichessData(gameData);
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
function getDebugGameFilter(): string | null {
    if (typeof window === 'undefined') return null;
    // Support both regular and hash-based routing (HashRouter puts params in the hash fragment)
    const hashQuery = window.location.hash.split('?')[1];
    const search = hashQuery || window.location.search;
    return new URLSearchParams(search).get('debugGame');
}

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

export function annotateGame(
    gameData: Record<string, unknown>,
    username: string,
    repertoireFens: Set<string>,
    evals: ExplorerEvals | null,
    maxPlies: number = 30,
    platform: Platform,
    mastersLookup?: MastersLookupLike
): GameAnnotation | null {
    const gameId = gameData.id as string | undefined;
    const userColor = getUserColor(gameData, username, platform);
    if (!userColor) {
        return null;
    }

    const debugFilter = getDebugGameFilter();
    const opponentName = getOpponentName(gameData, userColor, platform);
    const debugThis = debugFilter !== null &&
        opponentName.toLowerCase().includes(debugFilter.toLowerCase());

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
    const missingEvalPositions: MissingEvalPosition[] = [];
    const ambiguousTheoryPositions: AmbiguousTheoryPosition[] = [];
    let postTheoryAnalysis = false;
    let theoryEndPly = 0;
    let moveNumber = 1;

    // Track first notable event for mini board
    let firstPostTheoryFen: string | null = null;
    let firstEvalDropFen: string | null = null;
    let lastInRepertoireFen: string | null = null;
    let deviation: DeviationInfo | undefined;

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
            theoryEndPly = i + 1;
            postTheoryAnalysis = false;
            reason = 'after-FEN in repertoire';
        } else if (isUserMove && repertoireFens.has(normalizedFenBefore)) {
            // User deviated from repertoire (before-FEN was in repertoire, after-FEN is not)
            highlight = 'deviation';
            reason = 'before-FEN in repertoire but after-FEN is NOT → user deviated';

            if (!deviation) {
                // Compute deviation info: find repertoire moves from this position
                const deviationChess = new Chess(fenBefore);
                const legalMoves = deviationChess.moves({ verbose: true });
                const repertoireMoves: { from: string; to: string; san: string }[] = [];
                for (const lm of legalMoves) {
                    const probe = new Chess(fenBefore);
                    probe.move(lm);
                    if (repertoireFens.has(normalizeFenResetHalfmoveClock(probe.fen()))) {
                        repertoireMoves.push({ from: lm.from, to: lm.to, san: lm.san });
                    }
                }
                deviation = {
                    fen: fenBefore,
                    userMove: { from: allMoves[i].from, to: allMoves[i].to, san: allMoves[i].san },
                    repertoireMoves,
                };
            }

            if (!firstPostTheoryFen) {
                firstPostTheoryFen = fenAfter;
            }

            // Compute eval drop for the deviation
            const evalResult = lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals);
            if (evalResult) {
                const drop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                const category = categorizeEvalDrop(drop);
                evalDrop = { evalDrop: drop, category };
                evalSource = evalResult.source;
                reason += `, evalDrop=${drop.toFixed(2)} (${category}) [source: ${evalResult.source}]`;

                if (!firstEvalDropFen && category !== 'ok') {
                    firstEvalDropFen = fenAfter;
                }
            } else {
                reason += ', no eval data for drop calc';
                missingEvalPositions.push({ moveIndex: moves.length, plyIndex: i, fenBefore, fenAfter, isWhiteMove });
            }
        } else if (!isUserMove && repertoireFens.has(normalizedFenBefore) && !repertoireFens.has(normalizedFenAfter)) {
            // Opponent left the user's repertoire.
            // Three-zone classification:
            //   ≥ 45 cp → out of theory
            //   15–44 cp → ambiguous, check masters DB
            //   < 15 cp → in theory
            theoryEndPly = i;
            reason = 'opponent left repertoire';

            const evalResult = lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals);
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
                    const mastersVerdict = mastersLookup?.isOutOfTheory(fenBefore, allMoves[i].san);
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
                        ambiguousTheoryPositions.push({ moveIndex: moves.length, plyIndex: i, fenBefore, moveSan: allMoves[i].san });
                    }
                }
            } else {
                // No eval data — benefit of the doubt, analyse user moves
                highlight = 'out-of-repertoire';
                postTheoryAnalysis = true;
                reason += ', no eval data for opponent drop → analyse user moves';
            }
        } else if (postTheoryAnalysis && isUserMove) {
            // User move after opponent left repertoire but still in theory — evaluate for eval drop
            highlight = 'out-of-repertoire-response';
            reason = 'user move after opponent left repertoire (still in theory)';

            if (!firstPostTheoryFen) {
                firstPostTheoryFen = fenAfter;
            }

            const evalResult = lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals);
            if (evalResult) {
                const drop = computeConservativeDrop(evalResult.beforeVals, evalResult.afterVals, isWhiteMove);
                const category = categorizeEvalDrop(drop);
                evalDrop = { evalDrop: drop, category };
                evalSource = evalResult.source;
                reason += `, evalDrop=${drop.toFixed(2)} (${category}) [source: ${evalResult.source}]`;

                if (!firstEvalDropFen && category !== 'ok') {
                    firstEvalDropFen = fenAfter;
                }

                // Stop after first notable eval drop — only the first inaccuracy/mistake/blunder matters
                if (category !== 'ok') {
                    postTheoryAnalysis = false;
                    reason += ' → stop (first notable drop)';
                }
            } else {
                reason += ', no eval data for drop calc';
                missingEvalPositions.push({ moveIndex: moves.length, plyIndex: i, fenBefore, fenAfter, isWhiteMove });
            }
        } else if (postTheoryAnalysis && !isUserMove) {
            // Subsequent opponent move — three-zone check
            reason = 'opponent move (still in theory)';

            const evalResult = lookupEvals(fenBefore, fenAfter, i, evals, embeddedEvals);
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
                    const mastersVerdict = mastersLookup?.isOutOfTheory(fenBefore, allMoves[i].san);
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
                        ambiguousTheoryPositions.push({ moveIndex: moves.length, plyIndex: i, fenBefore, moveSan: allMoves[i].san });
                    }
                }
            } else {
                highlight = 'out-of-repertoire';
                reason += ', no eval data for opponent drop → continue';
                missingEvalPositions.push({ moveIndex: moves.length, plyIndex: i, fenBefore, fenAfter, isWhiteMove });
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
        });

        // Stop after maxPlies or theory end + some buffer
        const effectiveMax = Math.max(maxPlies, theoryEndPly + 4);
        if (i + 1 >= effectiveMax) break;
    }

    if (debugThis) console.groupEnd();

    // Determine mini board position (spec §3.3)
    // For user deviations, show the position BEFORE the deviation (with arrows)
    let miniBoardFen: string;
    if (deviation) {
        miniBoardFen = deviation.fen;
    } else if (firstPostTheoryFen) {
        miniBoardFen = firstPostTheoryFen;
    } else if (firstEvalDropFen) {
        miniBoardFen = firstEvalDropFen;
    } else if (lastInRepertoireFen) {
        miniBoardFen = lastInRepertoireFen;
    } else {
        miniBoardFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    }

    return {
        moves,
        miniBoardFen,
        miniBoardOrientation: userColor,
        deviation,
        missingEvalPositions: missingEvalPositions.length > 0 ? missingEvalPositions : undefined,
        ambiguousTheoryPositions: ambiguousTheoryPositions.length > 0 ? ambiguousTheoryPositions : undefined,
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
