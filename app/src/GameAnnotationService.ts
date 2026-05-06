import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { ExplorerEvals } from './ExplorerEvals';
import { categorizeEvalDrop, computeConservativeDrop, EvalDrop, EvalDropCategory } from './EvalDropService';

export type MoveHighlight = 'in-repertoire' | 'deviation' | 'out-of-theory';

export interface AnnotatedMove {
    /** Move text, e.g. "1. d4" or "d5" */
    text: string;
    /** SAN of the move */
    san: string;
    /** FEN after the move (full, for display/eval lookup) */
    fenAfter: string;
    /** FEN before the move (full) */
    fenBefore: string;
    /** Whether this is a white move */
    isWhiteMove: boolean;
    /** Whether this is the user's move (based on game color) */
    isUserMove: boolean;
    /** Highlighting category */
    highlight: MoveHighlight;
    /** Eval drop info (only for deviation moves with eval data) */
    evalDrop?: EvalDrop;
}

export interface GameAnnotation {
    moves: AnnotatedMove[];
    /** FEN for the mini board display */
    miniBoardFen: string;
    /** Orientation for the mini board */
    miniBoardOrientation: 'white' | 'black';
}

/**
 * Determine which color the user played in a game.
 * Lichess NDJSON has players.white.user.id and players.black.user.id.
 */
export function getUserColor(
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
 * Annotate a game's moves against the user's repertoire FEN set.
 *
 * @param gameData Raw Lichess NDJSON object
 * @param username Lichess username (for determining user's color)
 * @param repertoireFens Set of normalized FENs for the user's color in this game
 * @param evals ExplorerEvals instance for eval-drop computation
 * @param maxPlies Maximum plies to display (spec says ~20 or until theory ends, whichever is longer)
 */
const debugAnnotation = new URLSearchParams(window.location.search).has('debug');

export function annotateGame(
    gameData: Record<string, unknown>,
    username: string,
    repertoireFens: Set<string>,
    evals: ExplorerEvals | null,
    maxPlies: number = 30
): GameAnnotation | null {
    const gameId = gameData.id as string | undefined;
    const userColor = getUserColor(gameData, username);
    if (!userColor) {
        if (debugAnnotation) console.debug(`[annotate ${gameId}] No user color found for ${username}`);
        return null;
    }

    const pgn = buildPgnFromLichessData(gameData);
    if (!pgn) {
        if (debugAnnotation) console.debug(`[annotate ${gameId}] Could not build PGN`);
        return null;
    }

    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        if (debugAnnotation) console.debug(`[annotate ${gameId}] Failed to parse PGN`);
        return null;
    }
    chess.deleteComments();

    const allMoves = chess.history({ verbose: true });
    const temp = new Chess();

    if (debugAnnotation) console.groupCollapsed(`[annotate ${gameId}] ${username} as ${userColor}, repertoire size=${repertoireFens.size}, moves=${allMoves.length}`);

    const moves: AnnotatedMove[] = [];
    let pendingUserEvalDrop = false;
    let theoryEndPly = 0;
    let moveNumber = 1;

    // Track first notable event for mini board
    let firstDeviationFen: string | null = null;
    let firstEvalDropFen: string | null = null;
    let lastInRepertoireFen: string | null = null;

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

        // Build move text
        let text: string;
        if (isWhiteMove) {
            text = `${moveNumber}.\u00a0${allMoves[i].san}`;
        } else {
            text = allMoves[i].san;
            moveNumber++;
        }

        // Determine highlighting
        let highlight: MoveHighlight;
        let evalDrop: EvalDrop | undefined;
        let reason: string;

        if (repertoireFens.has(normalizedFenAfter)) {
            // Position after move is in repertoire → green (handles transpositions back)
            highlight = 'in-repertoire';
            lastInRepertoireFen = fenAfter;
            theoryEndPly = i + 1;
            pendingUserEvalDrop = false;
            reason = 'after-FEN in repertoire';
        } else if (isUserMove && repertoireFens.has(normalizedFenBefore)) {
            // User deviated from repertoire (before-FEN was in repertoire, after-FEN is not)
            highlight = 'deviation';
            reason = 'before-FEN in repertoire but after-FEN is NOT → user deviated';

            if (!firstDeviationFen) {
                firstDeviationFen = fenAfter;
            }

            // Compute eval drop for the deviation
            if (evals) {
                const beforeVals = evals.lookupAll(fenBefore);
                const afterVals = evals.lookupAll(fenAfter);

                if (beforeVals && afterVals && beforeVals.length > 0 && afterVals.length > 0) {
                    const drop = computeConservativeDrop(beforeVals, afterVals, isWhiteMove);
                    const category = categorizeEvalDrop(drop);
                    evalDrop = { evalDrop: drop, category };
                    reason += `, evalDrop=${drop.toFixed(2)} (${category})`;

                    if (!firstEvalDropFen && category !== 'ok') {
                        firstEvalDropFen = fenAfter;
                    }
                } else {
                    reason += ', no eval data for drop calc';
                }
            }
        } else if (!isUserMove && repertoireFens.has(normalizedFenBefore) && !repertoireFens.has(normalizedFenAfter)) {
            // Opponent deviated (opponent's move took us out of repertoire)
            highlight = 'out-of-theory';
            pendingUserEvalDrop = true;
            theoryEndPly = i;
            reason = 'opponent deviated (before-FEN in repertoire, after-FEN not)';
        } else if (pendingUserEvalDrop && isUserMove) {
            // User's first response after opponent deviation — evaluate for eval drop
            highlight = 'deviation';
            pendingUserEvalDrop = false;
            reason = 'user response after opponent deviation';

            if (!firstDeviationFen) {
                firstDeviationFen = fenAfter;
            }

            if (evals) {
                const beforeVals = evals.lookupAll(fenBefore);
                const afterVals = evals.lookupAll(fenAfter);

                if (beforeVals && afterVals && beforeVals.length > 0 && afterVals.length > 0) {
                    const drop = computeConservativeDrop(beforeVals, afterVals, isWhiteMove);
                    const category = categorizeEvalDrop(drop);
                    evalDrop = { evalDrop: drop, category };
                    reason += `, evalDrop=${drop.toFixed(2)} (${category})`;

                    if (!firstEvalDropFen && category !== 'ok') {
                        firstEvalDropFen = fenAfter;
                    }
                } else {
                    reason += ', no eval data for drop calc';
                }
            }
        } else {
            highlight = 'out-of-theory';
            reason = `out of theory: beforeInRep=${repertoireFens.has(normalizedFenBefore)}, afterInRep=${repertoireFens.has(normalizedFenAfter)}, isUser=${isUserMove}`;
        }

        if (debugAnnotation) console.debug(
            `  ply ${i}: ${allMoves[i].san} [${isUserMove ? 'USER' : 'OPP'}] → ${highlight} | ${reason}`
        );

        moves.push({
            text,
            san: allMoves[i].san,
            fenAfter,
            fenBefore,
            isWhiteMove,
            isUserMove,
            highlight,
            evalDrop,
        });

        // Stop after maxPlies or theory end + some buffer
        const effectiveMax = Math.max(maxPlies, theoryEndPly + 4);
        if (i + 1 >= effectiveMax) break;
    }

    if (debugAnnotation) console.groupEnd();

    // Determine mini board position (spec §3.3)
    let miniBoardFen: string;
    if (firstDeviationFen) {
        miniBoardFen = firstDeviationFen;
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

export interface GameMetadata {
    whiteName: string;
    whiteRating: number | undefined;
    blackName: string;
    blackRating: number | undefined;
    result: 'win' | 'draw' | 'loss';
    timeControl: string;
    rated: boolean;
    openingName: string;
    createdAt: number;
    userColor: 'white' | 'black' | null;
}

/**
 * Extract game metadata for display.
 */
export function getGameMetadata(gameData: Record<string, unknown>, username: string): GameMetadata {
    const userColor = getUserColor(gameData, username);
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

    // Rated
    const rated = gameData.rated as boolean ?? false;

    // Opening
    const opening = gameData.opening as Record<string, unknown> | undefined;
    const openingName = (opening?.name as string) || '';

    // Date
    const createdAt = gameData.createdAt as number;

    return {
        whiteName: white.name,
        whiteRating: white.rating,
        blackName: black.name,
        blackRating: black.rating,
        result,
        timeControl,
        rated,
        openingName,
        createdAt,
        userColor,
    };
}
