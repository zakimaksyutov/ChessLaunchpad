import { Chess } from 'chess.js';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import type { Platform } from './LinkedAccountsService';
import {
    OpponentAnalysisResult,
    OpponentGameRef,
    computeThreatLevel,
} from '../data/OpponentAnalysisDB';

const MAX_GAMES = 1000;
const MAX_RECENT_REFS = 5;

export interface OpponentAnalysisProgress {
    gamesDownloaded: number;
    phase: 'downloading' | 'complete';
}

export interface AnalyzeOpponentParams {
    gameId: string;
    opponentUsername: string;
    platform: Platform;
    /** Normalized FEN of position before user's bad move */
    fenBefore: string;
    /** Normalized FEN of position after user's bad move */
    fenAfter: string;
    /** SAN of the opponent's preceding move (e.g., "Nxe4") */
    opponentMoveSan: string;
    /** SAN of the user's bad move (e.g., "exd6") */
    userMoveSan: string;
    /** Ply index of the user's bad move — replay stops here */
    targetPly: number;
    /** URL of the source game to exclude from opponent results */
    excludeGameUrl?: string;
}

interface ParsedOpponentGame {
    moves: string;
    createdAt: number;
    gameUrl: string;
}

// ---------------------------------------------------------------------------
// Lichess download (NDJSON streaming)
// ---------------------------------------------------------------------------

async function downloadLichessGames(
    username: string,
    onProgress: (downloaded: number) => void,
    signal?: AbortSignal
): Promise<ParsedOpponentGame[]> {
    const params = new URLSearchParams({
        max: MAX_GAMES.toString(),
        perfType: 'blitz,rapid,classical',
    });

    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;
    const response = await fetch(url, {
        headers: { 'Accept': 'application/x-ndjson' },
        signal,
    });

    if (!response.ok) {
        throw new Error(`Lichess API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const games: ParsedOpponentGame[] = [];

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const data = JSON.parse(trimmed);
                    const movesStr = data.moves as string | undefined;
                    if (!movesStr) continue;

                    const gameId = data.id as string || '';
                    games.push({
                        moves: movesStr,
                        createdAt: data.createdAt as number,
                        gameUrl: `https://lichess.org/${gameId}`,
                    });
                    onProgress(games.length);
                } catch { /* skip malformed */ }
            }
        }

        if (buffer.trim()) {
            try {
                const data = JSON.parse(buffer.trim());
                const movesStr = data.moves as string | undefined;
                if (movesStr) {
                    const gameId = data.id as string || '';
                    games.push({
                        moves: movesStr,
                        createdAt: data.createdAt as number,
                        gameUrl: `https://lichess.org/${gameId}`,
                    });
                    onProgress(games.length);
                }
            } catch { /* skip */ }
        }
    } finally {
        reader.cancel().catch(() => {});
    }

    return games;
}

// ---------------------------------------------------------------------------
// Chess.com download
// ---------------------------------------------------------------------------

interface ChesscomGame {
    url: string;
    pgn: string;
    time_class: string;
    end_time: number;
    rules: string;
    uuid: string;
}

async function downloadChesscomGames(
    username: string,
    onProgress: (downloaded: number) => void,
    signal?: AbortSignal
): Promise<ParsedOpponentGame[]> {
    // Fetch archives list
    const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
    const archivesResp = await fetch(archivesUrl, { signal });
    if (!archivesResp.ok) {
        throw new Error(`Chess.com API error: ${archivesResp.status} ${archivesResp.statusText}`);
    }
    const archivesData = await archivesResp.json();
    const archives: string[] = (archivesData.archives || []).slice().reverse(); // newest first

    const games: ParsedOpponentGame[] = [];

    for (const archiveUrl of archives) {
        if (games.length >= MAX_GAMES) break;

        const resp = await fetch(archiveUrl, { signal });
        if (!resp.ok) continue;
        const data = await resp.json();
        const monthGames: ChesscomGame[] = data.games || [];

        // Sort newest first within each month
        monthGames.sort((a, b) => b.end_time - a.end_time);

        for (const g of monthGames) {
            if (games.length >= MAX_GAMES) break;
            // Exclude bullet and non-standard
            if (g.time_class === 'bullet' || g.time_class === 'daily' || g.rules !== 'chess') continue;

            if (!g.pgn) continue;

            // Extract moves from PGN by stripping headers and comments
            const movesOnly = extractMovesFromPgn(g.pgn);
            if (!movesOnly) continue;

            games.push({
                moves: movesOnly,
                createdAt: g.end_time * 1000,
                gameUrl: g.url || '',
            });
            onProgress(games.length);
        }
    }

    return games;
}

/**
 * Extract SAN moves from a Chess.com PGN string.
 * Returns a space-separated string of SAN moves (like Lichess `moves` field).
 */
function extractMovesFromPgn(pgn: string): string | null {
    let chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        try {
            const cleaned = pgn.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ');
            chess = new Chess();
            chess.loadPgn(cleaned);
        } catch {
            return null;
        }
    }
    const history = chess.history();
    return history.length > 0 ? history.join(' ') : null;
}

// ---------------------------------------------------------------------------
// FEN matching analysis
// ---------------------------------------------------------------------------

interface MatchResult {
    beforeMatches: OpponentGameRef[];
    afterMatches: OpponentGameRef[];
}

function analyzeGamesForPositions(
    games: ParsedOpponentGame[],
    fenBefore: string,
    fenAfter: string,
    targetPly: number,
    excludeGameUrl?: string
): MatchResult {
    const beforeMatches: OpponentGameRef[] = [];
    const afterMatches: OpponentGameRef[] = [];

    for (const game of games) {
        if (excludeGameUrl && game.gameUrl === excludeGameUrl) continue;

        const sans = game.moves.split(/\s+/).filter(Boolean);
        const chess = new Chess();
        let matchedBefore = false;
        let matchedAfter = false;

        const maxPly = Math.min(sans.length, targetPly + 1);
        for (let i = 0; i < maxPly; i++) {
            try {
                chess.move(sans[i]);
            } catch {
                break;
            }

            const normalizedFen = normalizeFenResetHalfmoveClock(chess.fen());

            if (!matchedBefore && normalizedFen === fenBefore) {
                matchedBefore = true;
                beforeMatches.push({ date: game.createdAt, url: game.gameUrl });
            }
            if (!matchedAfter && normalizedFen === fenAfter) {
                matchedAfter = true;
                afterMatches.push({ date: game.createdAt, url: game.gameUrl });
            }

            if (matchedBefore && matchedAfter) break;
        }
    }

    // Sort newest first
    beforeMatches.sort((a, b) => b.date - a.date);
    afterMatches.sort((a, b) => b.date - a.date);

    return { beforeMatches, afterMatches };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function analyzeOpponentGames(
    params: AnalyzeOpponentParams,
    onProgress?: (progress: OpponentAnalysisProgress) => void,
    signal?: AbortSignal
): Promise<OpponentAnalysisResult> {
    const progressCb = (downloaded: number) => {
        onProgress?.({ gamesDownloaded: downloaded, phase: 'downloading' });
    };

    const games = params.platform === 'chess.com'
        ? await downloadChesscomGames(params.opponentUsername, progressCb, signal)
        : await downloadLichessGames(params.opponentUsername, progressCb, signal);

    const { beforeMatches, afterMatches } = analyzeGamesForPositions(
        games,
        params.fenBefore,
        params.fenAfter,
        params.targetPly,
        params.excludeGameUrl
    );

    const positionBeforeCount = beforeMatches.length;
    const positionAfterCount = afterMatches.length;

    onProgress?.({ gamesDownloaded: games.length, phase: 'complete' });

    return {
        gameId: params.gameId,
        opponentUsername: params.opponentUsername,
        platform: params.platform,
        gamesAnalyzed: games.length,
        positionBeforeCount,
        positionAfterCount,
        recentBeforeGames: beforeMatches.slice(0, MAX_RECENT_REFS),
        recentAfterGames: afterMatches.slice(0, MAX_RECENT_REFS),
        opponentMoveSan: params.opponentMoveSan,
        userMoveSan: params.userMoveSan,
        threatLevel: computeThreatLevel(positionBeforeCount),
        analyzedAt: Date.now(),
    };
}
