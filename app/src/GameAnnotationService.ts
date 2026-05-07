import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from './FenUtils';
import { ExplorerEvals } from './ExplorerEvals';
import { categorizeEvalDrop, computeConservativeDrop, EvalDrop, EvalDropCategory } from './EvalDropService';
import type { Platform } from './LinkedAccountsService';
import { parseChesscomTimeControl } from './ChesscomGamesService';

export type MoveHighlight = 'in-repertoire' | 'deviation' | 'end-of-theory-response' | 'out-of-theory';

export interface AnnotatedMove {
    /** Move text (SAN only, e.g. "d4" or "d5") */
    text: string;
    /** SAN of the move */
    san: string;
    /** Move number (set only for white moves, e.g. 1, 2, 3…) */
    moveNumber?: number;
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

/** Info about the first user deviation from repertoire */
export interface DeviationInfo {
    /** FEN of the position before the deviation (after opponent's move) */
    fen: string;
    /** The move the user actually played (red arrow) */
    userMove: { from: string; to: string };
    /** Moves from this position that stay in repertoire (green arrows) */
    repertoireMoves: { from: string; to: string }[];
}

export interface GameAnnotation {
    moves: AnnotatedMove[];
    /** FEN for the mini board display */
    miniBoardFen: string;
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
    platform?: Platform
): 'white' | 'black' | null {
    const effectivePlatform = platform ?? detectPlatform(gameData);

    if (effectivePlatform === 'chess.com') {
        return getUserColorChesscom(gameData, username);
    }

    return getUserColorLichess(gameData, username);
}

/**
 * Detect platform from game data structure.
 */
function detectPlatform(gameData: Record<string, unknown>): Platform {
    // Chess.com games have a 'uuid' field and white/black as direct objects with 'username'
    if ('uuid' in gameData || 'time_class' in gameData) return 'chess.com';
    return 'lichess';
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
const debugAnnotation = new URLSearchParams(window.location.search).has('debug');

export function annotateGame(
    gameData: Record<string, unknown>,
    username: string,
    repertoireFens: Set<string>,
    evals: ExplorerEvals | null,
    maxPlies: number = 30,
    platform?: Platform
): GameAnnotation | null {
    const gameId = gameData.id as string | undefined;
    const effectivePlatform = platform ?? detectPlatform(gameData);
    const userColor = getUserColor(gameData, username, effectivePlatform);
    if (!userColor) {
        if (debugAnnotation) console.debug(`[annotate ${gameId}] No user color found for ${username}`);
        return null;
    }

    const pgn = buildPgn(gameData, effectivePlatform);
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

        // Build move text (SAN only; move number stored separately)
        const text = allMoves[i].san;
        const currentMoveNumber = isWhiteMove ? moveNumber : undefined;
        if (!isWhiteMove) {
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

                // Compute deviation info: find repertoire moves from this position
                const deviationChess = new Chess(fenBefore);
                const legalMoves = deviationChess.moves({ verbose: true });
                const repertoireMoves: { from: string; to: string }[] = [];
                for (const lm of legalMoves) {
                    const probe = new Chess(fenBefore);
                    probe.move(lm);
                    if (repertoireFens.has(normalizeFenResetHalfmoveClock(probe.fen()))) {
                        repertoireMoves.push({ from: lm.from, to: lm.to });
                    }
                }
                deviation = {
                    fen: fenBefore,
                    userMove: { from: allMoves[i].from, to: allMoves[i].to },
                    repertoireMoves,
                };
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
            highlight = 'end-of-theory-response';
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
            moveNumber: currentMoveNumber,
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
    // For user deviations, show the position BEFORE the deviation (with arrows)
    let miniBoardFen: string;
    if (deviation) {
        miniBoardFen = deviation.fen;
    } else if (firstDeviationFen) {
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
    platform?: Platform
): GameMetadata {
    const effectivePlatform = platform ?? detectPlatform(gameData);

    if (effectivePlatform === 'chess.com') {
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
