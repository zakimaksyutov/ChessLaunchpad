import { Chess } from 'chess.js';
import { GameRecord } from '../models/RepertoireData';
import type { Platform } from './LinkedAccountsService';
import { parseChesscomTimeControl } from './ChesscomTimeControl';

const CHESSCOM_DRAW_RESULTS = new Set([
    'agreed',
    'repetition',
    'stalemate',
    'insufficient',
    '50move',
    'timevsinsufficient',
    'drawn',
]);

const MATE_CP = 10_000;

/**
 * Cap on the SAN move list `m` stored per record. Capped at 60 plies
 * (= 30 full moves) so a 100-record blob's `m` payload stays bounded
 * regardless of how long the underlying games ran. Repertoire-deviation
 * analysis only ever looks at the opening into early middlegame; 60 plies
 * is the same `maxPlies` budget the annotation engine uses by default
 * (`annotateGame(...maxPlies: 30)` plus headroom for transposition tails).
 *
 * Truncation is silent — the wire never carries the moves past this cap,
 * and the page re-renders against the truncated list.
 */
export const MAX_RECORD_PLIES = 60;

/**
 * Build a compact `GameRecord` from a provider game payload.
 *
 * Returns `null` when the game is too malformed to render (no SAN moves,
 * user color not derivable). Callers should still count the game as
 * "processed" for ingest purposes (watermark advances, recentIds adds);
 * we just don't keep a display record for it.
 *
 * Storage normalization rules:
 *   - `wa` / `ba` are stored in **provider casing** (not lowercased), so the
 *     UI keeps `DrNykterstein` rather than `drnykterstein`. Compare
 *     case-insensitively at read time.
 *   - For Chess.com, the opening name lives only in the PGN `[ECOUrl …]`
 *     header. We extract it here, **before** the PGN is reduced to bare SAN.
 *   - `m` is space-separated SAN built from chess.js history (no headers,
 *     comments, NAGs, or move numbers).
 *   - `ev` carries per-ply centipawn evals (Lichess `analysis[]`) when
 *     available; absent on Chess.com.
 */
export function buildGameRecord(
    gameData: Record<string, unknown>,
    accountUsernameLower: string,
    platform: Platform,
): GameRecord | null {
    if (platform === 'chess.com') {
        return buildChesscomRecord(gameData, accountUsernameLower);
    }
    return buildLichessRecord(gameData, accountUsernameLower);
}

// ── Lichess ────────────────────────────────────────────────────────────

function buildLichessRecord(
    gameData: Record<string, unknown>,
    accountUsernameLower: string,
): GameRecord | null {
    const id = gameData.id as string | undefined;
    const createdAt = gameData.createdAt as number | undefined;
    const movesStr = gameData.moves as string | undefined;
    if (!id || typeof createdAt !== 'number' || !movesStr) return null;

    const players = gameData.players as Record<string, unknown> | undefined;
    if (!players) return null;

    const whitePI = getLichessPlayer(players, 'white');
    const blackPI = getLichessPlayer(players, 'black');

    const userColor = resolveUserColor(
        accountUsernameLower,
        whitePI.nameLower,
        blackPI.nameLower,
    );
    if (!userColor) return null;

    // Build SAN-only `m` from chess.js — strips clock comments, headers,
    // move numbers, etc. Defensive: drop trailing illegal SANs rather than
    // discarding the whole game. Cap at `MAX_RECORD_PLIES` to bound the
    // per-record wire payload (a full rapid game is ~200 plies); the
    // annotation engine only ever looks at the opening into early
    // middlegame, so truncating is lossless for the page's purposes.
    const sanList = movesStr.split(/\s+/).filter(Boolean);
    const replay = new Chess();
    const validSans: string[] = [];
    for (const san of sanList) {
        if (validSans.length >= MAX_RECORD_PLIES) break;
        try {
            const moved = replay.move(san);
            if (!moved) break;
            validSans.push(moved.san);
        } catch {
            break;
        }
    }
    if (validSans.length === 0) return null;
    const m = validSans.join(' ');

    const res = resolveLichessResult(gameData, userColor);

    const clock = gameData.clock as Record<string, unknown> | undefined;
    let tc: string | undefined;
    if (clock && typeof clock.initial === 'number' && typeof clock.increment === 'number') {
        // Lichess `clock.initial` is in seconds. We store the display form
        // "M+I" (matches `parseChesscomTimeControl` output). For non-
        // integer minute controls (e.g. 30s = 0.5+0, 90s = 1.5+0) we
        // emit the decimal so `parseTcToClock` on the render side can
        // round-trip the value.
        const initialMin = clock.initial / 60;
        const minStr = String(initialMin);
        tc = `${minStr}+${clock.increment}`;
    }

    const sp = typeof gameData.speed === 'string' ? gameData.speed : undefined;
    const rt = gameData.rated === true ? 1 : 0;

    const opening = gameData.opening as Record<string, unknown> | undefined;
    const o = typeof opening?.name === 'string' ? (opening.name as string) : undefined;

    const ev = extractLichessEvals(gameData, validSans.length);

    const record: GameRecord = {
        id,
        p: 'l',
        t: createdAt,
        m,
        wa: whitePI.name,
        ba: blackPI.name,
        res,
        rt: rt as 0 | 1,
    };
    if (whitePI.rating !== undefined) record.wr = whitePI.rating;
    if (blackPI.rating !== undefined) record.br = blackPI.rating;
    if (tc) record.tc = tc;
    if (sp) record.sp = sp;
    if (o) record.o = o;
    if (ev) record.ev = ev;
    return record;
}

interface LichessPlayer {
    /** Display name in provider casing. */
    name: string;
    /** Lowercase variant for matching. */
    nameLower: string;
    rating?: number;
}

function getLichessPlayer(
    players: Record<string, unknown>,
    side: 'white' | 'black',
): LichessPlayer {
    const sideObj = (players[side] as Record<string, unknown>) ?? {};
    const user = (sideObj.user as Record<string, unknown>) ?? {};
    const name = (user.name as string) || (user.id as string) || 'Unknown';
    // Lichess `id` field is canonical lowercase. `name` may carry casing.
    const nameLower = (user.id as string)?.toLowerCase()
        || name.toLowerCase();
    const ratingRaw = sideObj.rating;
    const rating = typeof ratingRaw === 'number' ? ratingRaw : undefined;
    return { name, nameLower, rating };
}

function resolveLichessResult(
    gameData: Record<string, unknown>,
    userColor: 'white' | 'black',
): 'win' | 'draw' | 'loss' {
    const winner = gameData.winner as string | undefined;
    const status = gameData.status as string | undefined;
    if (!winner || status === 'draw' || status === 'stalemate') return 'draw';
    if (winner === userColor) return 'win';
    return 'loss';
}

/**
 * Per-ply centipawn eval array as stored on `GameRecord.ev`. `null` means
 * the position had no eval data at that ply (raw Lichess `analysis[i]` was
 * absent or carried neither `eval` nor `mate`) — distinct from a real `0 cp`
 * value. The render-side `extractEmbeddedEvals` returns `null` for missing
 * plies, so we round-trip the distinction by using `null` here rather than
 * a sentinel zero. JSON natively supports `null` inside number arrays.
 */
export type RecordPlyEval = number | null;

/**
 * Extract per-ply centipawn evals from a Lichess `analysis[]` array.
 * Returns `null` when the array is absent or empty (no analysis on the game).
 *
 * Lichess stores per-ply analysis as `{ eval: cp }` or `{ mate: N }` —
 * we coalesce mate values to ±MATE_CP. Plies with neither field (rare —
 * possible on incomplete analyses) become `null` so we don't collide with
 * a real `0 cp` eval at render time. Trailing plies past `analysis.length`
 * also stay `null`. The returned array length matches `plyCount` (≤
 * MAX_RECORD_PLIES) so wire payload stays bounded and indices align 1:1
 * with the record's `m`.
 *
 * White's perspective per Lichess convention (positive = white better).
 */
function extractLichessEvals(
    gameData: Record<string, unknown>,
    plyCount: number,
): RecordPlyEval[] | undefined {
    const analysis = gameData.analysis as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(analysis) || analysis.length === 0) return undefined;

    const limit = Math.min(plyCount, MAX_RECORD_PLIES);
    const out: RecordPlyEval[] = new Array(limit).fill(null);
    for (let i = 0; i < Math.min(analysis.length, limit); i++) {
        const e = analysis[i];
        if (!e || typeof e !== 'object') continue;
        if (typeof e.eval === 'number') out[i] = e.eval;
        else if (typeof e.mate === 'number') out[i] = e.mate > 0 ? MATE_CP : -MATE_CP;
    }
    return out;
}

// ── Chess.com ──────────────────────────────────────────────────────────

function buildChesscomRecord(
    gameData: Record<string, unknown>,
    accountUsernameLower: string,
): GameRecord | null {
    const id = gameData.uuid as string | undefined;
    const endTime = gameData.end_time as number | undefined;
    if (!id || typeof endTime !== 'number') return null;
    const createdAt = endTime * 1000;

    const whitePI = getChesscomPlayer(gameData, 'white');
    const blackPI = getChesscomPlayer(gameData, 'black');

    const userColor = resolveUserColor(
        accountUsernameLower,
        whitePI.nameLower,
        blackPI.nameLower,
    );
    if (!userColor) return null;

    // Extract opening name BEFORE we throw the PGN away. Chess.com places
    // it in the `[ECOUrl …]` header; nothing else carries it. The header
    // value is a URL path slug ("Italian-Game"); collapse hyphens to spaces.
    const pgnRaw = gameData.pgn as string | undefined;
    let o: string | undefined;
    if (pgnRaw) {
        const m = pgnRaw.match(/\[ECOUrl "[^"]*\/([^"]+)"\]/);
        if (m) o = m[1].replace(/-/g, ' ');
    }

    // Replay the PGN to extract SAN-only moves. Chess.com PGNs include
    // `{ [%clk 0:05:00.0] }` comments interleaved with moves; chess.js
    // accepts them, but our fallback strips them defensively. Cap at
    // `MAX_RECORD_PLIES` for the wire-size budget (same reason as Lichess).
    const sans = parseChesscomMoves(pgnRaw);
    if (!sans || sans.length === 0) return null;
    const cappedSans = sans.slice(0, MAX_RECORD_PLIES);
    const m = cappedSans.join(' ');

    const res = resolveChesscomResult(gameData, userColor);

    const tcRaw = (gameData.time_control as string) || '';
    const tc = parseChesscomTimeControl(tcRaw) || undefined;
    const sp = typeof gameData.time_class === 'string' ? gameData.time_class : undefined;
    const rt = gameData.rated === true ? 1 : 0;

    const record: GameRecord = {
        id,
        p: 'c',
        t: createdAt,
        m,
        wa: whitePI.name,
        ba: blackPI.name,
        res,
        rt: rt as 0 | 1,
    };
    if (whitePI.rating !== undefined) record.wr = whitePI.rating;
    if (blackPI.rating !== undefined) record.br = blackPI.rating;
    if (tc) record.tc = tc;
    if (sp) record.sp = sp;
    if (o) record.o = o;
    // Persist the canonical Chess.com URL — public URLs use a numeric
    // live-game id that is NOT derivable from the API UUID we store in
    // `id`. Without this the page would synthesize a broken "View on
    // Chess.com" link and the opponent-analysis self-exclusion would
    // miss the source game.
    const url = typeof gameData.url === 'string' ? (gameData.url as string) : undefined;
    if (url) record.u = url;
    // Chess.com never carries per-ply evals — leave `ev` absent.
    return record;
}

interface ChesscomPlayer {
    name: string;
    nameLower: string;
    rating?: number;
}

function getChesscomPlayer(
    gameData: Record<string, unknown>,
    side: 'white' | 'black',
): ChesscomPlayer {
    const sideObj = (gameData[side] as Record<string, unknown>) ?? {};
    const name = (sideObj.username as string) || 'Unknown';
    const ratingRaw = sideObj.rating;
    const rating = typeof ratingRaw === 'number' ? ratingRaw : undefined;
    return { name, nameLower: name.toLowerCase(), rating };
}

function resolveChesscomResult(
    gameData: Record<string, unknown>,
    userColor: 'white' | 'black',
): 'win' | 'draw' | 'loss' {
    const opponentColor = userColor === 'white' ? 'black' : 'white';
    const userSide = gameData[userColor] as Record<string, unknown> | undefined;
    const opponentSide = gameData[opponentColor] as Record<string, unknown> | undefined;
    const userResult = ((userSide?.result as string) || '').toLowerCase();
    const opponentResult = ((opponentSide?.result as string) || '').toLowerCase();
    if (userResult === 'win') return 'win';
    if (opponentResult === 'win') return 'loss';
    if (CHESSCOM_DRAW_RESULTS.has(userResult) || CHESSCOM_DRAW_RESULTS.has(opponentResult)) {
        return 'draw';
    }
    return 'loss';
}

function parseChesscomMoves(pgn: string | undefined): string[] | null {
    if (!pgn) return null;
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
    return history.length > 0 ? history : null;
}

// ── Shared ─────────────────────────────────────────────────────────────

function resolveUserColor(
    accountUsernameLower: string,
    whiteLower: string,
    blackLower: string,
): 'white' | 'black' | null {
    if (whiteLower === accountUsernameLower) return 'white';
    if (blackLower === accountUsernameLower) return 'black';
    return null;
}

/**
 * Find the user's color in a stored `GameRecord`. Case-insensitive match
 * against `wa`/`ba` — record casing is provider-original. The supplied
 * `accountUsernameLower` is expected to already be lowercase (called from
 * code that normalizes account names) but we lowercase defensively in case
 * a caller passes a non-normalized value.
 */
export function getRecordUserColor(
    record: GameRecord,
    accountUsernameLower: string,
): 'white' | 'black' | null {
    const target = accountUsernameLower.toLowerCase();
    if (record.wa.toLowerCase() === target) return 'white';
    if (record.ba.toLowerCase() === target) return 'black';
    return null;
}
