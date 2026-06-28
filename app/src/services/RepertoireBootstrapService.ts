import { Chess } from 'chess.js';
import { ExplorerEvals } from '../models/ExplorerEvals';
import { computeConservativeDrop, categorizeEvalDrop } from './EvalDropService';
import { normalizeFenResetHalfmoveClock, isUserTurnForOrientation } from '../utils/FenUtils';
import { getUserColor, extractEmbeddedEvals } from './GameAnnotationService';
import { parseChesscomMoves } from './GameRecordBuilder';
import { Platform } from './LinkedAccountsService';

/**
 * RepertoireBootstrapService — seed a brand-new user's repertoire from the
 * openings they already play. See `docs/product-specs/DASHBOARD.md` §1.5
 * (Actions Tile) for the high-level behavior.
 *
 * The module has three concerns, kept deliberately separate so the selection
 * algorithm is a *pure* function of a serializable input list:
 *
 *   1. Collection + enrichment (§2) — `collectBootstrapGames`. Bulk-fetches the
 *      user's recent games per linked account, normalizes every source into one
 *      homogeneous `BootstrapGame` list, and fills each position's engine eval
 *      from the game (Lichess) or the precomputed artifact. This is the **single
 *      producer** the run feeds to selection and the §5 "Download raw input"
 *      serializes — they can never diverge.
 *   2. Selection (§3) — `selectRepertoire`. A pure function of the
 *      `BootstrapGame[]` list: same input always yields the same repertoire.
 *   3. Serialization (§5) — `serializeBootstrapGames` / `parseBootstrapGames`.
 *      Round-trips the producer output as NDJSON so a run is fully replayable.
 */

export type BootstrapColor = 'white' | 'black';

/** Centipawn eval (White's perspective) for one position. */
interface PositionEval {
    eval: number;
}

/**
 * A single game normalized into one homogeneous, enriched shape — the §2
 * producer output and the §3 selection input.
 *
 * `analysis` is **position-indexed**: `analysis[k]` is the eval of the position
 * reached after `k` plies, so `analysis[0]` is the start position and the array
 * has length `plies + 1`. This intentionally differs from Lichess's native
 * per-move analysis (which omits the start) so the "before" eval of the very
 * first move (ply 0, White) is available — otherwise White's opening move could
 * never be seeded. `null` means no eval is known for that position; a known eval
 * is `{ eval: cp }` from White's perspective.
 *
 * Per §2 precedence, each entry is the Lichess per-game eval when present, else
 * the artifact eval; exactly one value per position (no blending).
 */
export interface BootstrapGame {
    id: string;
    platform: Platform;
    /** The user's color in this game. */
    color: BootstrapColor;
    /** Epoch ms the game was played (for recency ordering). */
    createdAt: number;
    /** Space-separated SAN, capped at `BOOTSTRAP_MAX_PLIES`. */
    moves: string;
    speed?: string;
    analysis: (PositionEval | null)[];
}

/** A proposed repertoire edge `(from --san-->)` under `orientation`. */
export interface BootstrapEdge {
    orientation: BootstrapColor;
    /** Normalized FEN of the parent position. */
    from: string;
    san: string;
}

export interface BootstrapSelection {
    white: BootstrapEdge[];
    black: BootstrapEdge[];
}

export interface BootstrapAccount {
    platform: Platform;
    username: string;
}

// ── Tunable constants ────────────────────────────────────────────────

/** Per-account bulk-fetch target (and hard cap). */
export const BOOTSTRAP_TARGET_GAMES = 2000;

/**
 * Global cap on games carried into analysis: after fetching up to
 * `BOOTSTRAP_TARGET_GAMES` per account, the union is sorted by recency and only
 * the most-recent `BOOTSTRAP_MAX_GAMES` across all accounts are kept. This keeps
 * the analyzed set (and the §5 download) bounded regardless of account count.
 */
export const BOOTSTRAP_MAX_GAMES = 2000;

/**
 * Cap on plies normalized per game. The selection depth cap is far shorter, so
 * this only bounds the producer payload (and the §5 download) — it never
 * affects which lines are seeded.
 */
export const BOOTSTRAP_MAX_PLIES = 40;

/** Consistency sample floor: fewer than this many games at a position → stop. */
const MIN_GAMES = 3;

/** Consistency window: the user's most-recent games that must agree. */
const CONSISTENCY_WINDOW = 5;

/** Depth cap (plies) — early-opening only. */
const MAX_DEPTH_PLIES = 20;

/** An opponent reply must appear in at least this share of games through its parent. */
const MIN_OPP_SHARE = 0.10;

/** Cap on opponent replies branched into at any position. */
const MAX_OPP_BRANCHES = 6;

// ── §2: Collection + enrichment (the single producer) ────────────────

export interface BootstrapCollectProgress {
    phase: 'downloading' | 'analyzing';
    done: number;
    total: number;
}

interface RawGame {
    platform: Platform;
    username: string;
    gameData: Record<string, unknown>;
}

/**
 * Bulk-fetch, normalize, and enrich the user's recent games — the one and only
 * seam between collection and selection. Reuses only the HTTP fetch/parse layer
 * (transport + Chess.com archive walking); the bulk pull and pagination are
 * net-new and do **not** go through `runIngest` or its first-run caps.
 */
export async function collectBootstrapGames(
    accounts: BootstrapAccount[],
    evals: ExplorerEvals,
    onProgress?: (p: BootstrapCollectProgress) => void,
    signal?: AbortSignal,
    options?: { maxGames?: number },
): Promise<BootstrapGame[]> {
    const maxGames = options?.maxGames ?? BOOTSTRAP_MAX_GAMES;
    // Phase 1 — download raw games (the only genuinely slow, network-bound step).
    const raw: RawGame[] = [];
    const downloadTotal = accounts.length * BOOTSTRAP_TARGET_GAMES;
    const onGame = (platform: Platform, username: string, gameData: Record<string, unknown>) => {
        raw.push({ platform, username, gameData });
        onProgress?.({ phase: 'downloading', done: raw.length, total: downloadTotal });
    };
    for (const acct of accounts) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (acct.platform === 'lichess') {
            await fetchLichessBulk(acct.username, gd => onGame('lichess', acct.username, gd), signal);
        } else {
            await fetchChesscomBulk(acct.username, gd => onGame('chess.com', acct.username, gd), signal);
        }
    }

    // Global recency cap: each account fetches up to BOOTSTRAP_TARGET_GAMES, but
    // we keep only the most-recent `maxGames` across all accounts, so the analyzed
    // set is bounded no matter how many accounts are linked. Sort newest first
    // (deterministic id tie-break) then truncate.
    raw.sort((a, b) => {
        const ta = rawCreatedAt(a);
        const tb = rawCreatedAt(b);
        if (ta !== tb) return tb - ta;
        const ia = rawId(a);
        const ib = rawId(b);
        return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    const kept = raw.slice(0, maxGames);

    // Phase 2 — normalize + enrich (parse, replay, eval lookup). Local-only and
    // chunked so the page stays responsive and the counter keeps animating.
    const games: BootstrapGame[] = [];
    for (let i = 0; i < kept.length; i++) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const r = kept[i];
        const g = normalizeGame(r.gameData, r.platform, r.username, evals);
        if (g) games.push(g);
        if (i % 50 === 0) {
            onProgress?.({ phase: 'analyzing', done: i + 1, total: kept.length });
            await yieldToEventLoop();
        }
    }
    onProgress?.({ phase: 'analyzing', done: kept.length, total: kept.length });
    return games;
}

/** Epoch-ms timestamp of a raw provider payload (for the global recency cap). */
function rawCreatedAt(r: RawGame): number {
    return extractIds(r.gameData, r.platform)?.createdAt ?? 0;
}

/** Provider game id of a raw payload (deterministic recency-sort tie-break). */
function rawId(r: RawGame): string {
    return extractIds(r.gameData, r.platform)?.id ?? '';
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Normalize one raw provider payload into a `BootstrapGame`, enriching every
 * position's eval. Pure given the artifact (`evals`). Returns `null` when the
 * game is unusable (color not derivable, no legal moves).
 */
export function normalizeGame(
    gameData: Record<string, unknown>,
    platform: Platform,
    username: string,
    evals: ExplorerEvals,
): BootstrapGame | null {
    const color = getUserColor(gameData, username, platform);
    if (!color) return null;

    const ids = extractIds(gameData, platform);
    if (!ids) return null;

    const rawSans = platform === 'chess.com'
        ? parseChesscomMoves(gameData.pgn as string | undefined)
        : (gameData.moves as string | undefined)?.split(/\s+/).filter(Boolean) ?? null;
    if (!rawSans || rawSans.length === 0) return null;

    // Lichess per-game evals (native `analysis[i]` = eval AFTER ply i).
    const lichessEval = platform === 'lichess' ? extractEmbeddedEvals(gameData) : null;

    const chess = new Chess();
    const fens: string[] = [chess.fen()];
    const validSans: string[] = [];
    for (const san of rawSans) {
        if (validSans.length >= BOOTSTRAP_MAX_PLIES) break;
        let moved;
        try {
            moved = chess.move(san);
        } catch {
            break;
        }
        if (!moved) break;
        validSans.push(moved.san);
        fens.push(chess.fen());
    }
    if (validSans.length === 0) return null;

    // Position-indexed analysis: index k = position after k plies. Lichess eval
    // wins (mapped from native index k-1), artifact fills the gaps.
    const analysis: (PositionEval | null)[] = [];
    for (let k = 0; k <= validSans.length; k++) {
        const native = k >= 1 && lichessEval ? lichessEval(k - 1) : null;
        const cp = native ?? evals.lookup(fens[k]);
        analysis.push(cp !== null && cp !== undefined ? { eval: cp } : null);
    }

    return {
        id: ids.id,
        platform,
        color,
        createdAt: ids.createdAt,
        moves: validSans.join(' '),
        speed: ids.speed,
        analysis,
    };
}

function extractIds(
    gameData: Record<string, unknown>,
    platform: Platform,
): { id: string; createdAt: number; speed?: string } | null {
    if (platform === 'chess.com') {
        const id = gameData.uuid as string | undefined;
        const endTime = gameData.end_time as number | undefined;
        if (!id || typeof endTime !== 'number') return null;
        const speed = typeof gameData.time_class === 'string' ? gameData.time_class : undefined;
        return { id, createdAt: endTime * 1000, speed };
    }
    const id = gameData.id as string | undefined;
    const createdAt = gameData.createdAt as number | undefined;
    if (!id || typeof createdAt !== 'number') return null;
    const speed = typeof gameData.speed === 'string' ? gameData.speed : undefined;
    return { id, createdAt, speed };
}

// ── §5: Serialization (replayable raw input) ─────────────────────────

export function serializeBootstrapGames(games: BootstrapGame[]): string {
    return games.map(g => JSON.stringify(g)).join('\n');
}

export function parseBootstrapGames(ndjson: string): BootstrapGame[] {
    const out: BootstrapGame[] = [];
    for (const line of ndjson.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            out.push(JSON.parse(trimmed) as BootstrapGame);
        } catch {
            // Skip malformed lines.
        }
    }
    return out;
}

// ── §3: Selection (pure) ─────────────────────────────────────────────

interface Observation {
    gameId: string;
    san: string;
    createdAt: number;
    /** Eval of the position the move is played from (White POV). */
    beforeEval: number | null;
    /** Eval of the position after the move (White POV). */
    afterEval: number | null;
}

interface TreeNode {
    /** One observation per game (first occurrence wins) — dedupes repetitions. */
    obs: Map<string, Observation>;
}

interface Candidate {
    san: string;
    to: string;
    isUser: boolean;
}

/**
 * Pure §3 selection: walk the games into a position-keyed tree (normalized FEN,
 * transpositions merged) and keep a move only when every gate passes. Same input
 * always yields the same repertoire.
 */
export function selectRepertoire(
    games: BootstrapGame[],
    colors: BootstrapColor[],
): BootstrapSelection {
    const result: BootstrapSelection = { white: [], black: [] };
    for (const color of colors) {
        result[color] = selectForColor(games.filter(g => g.color === color), color);
    }
    return result;
}

function selectForColor(games: BootstrapGame[], color: BootstrapColor): BootstrapEdge[] {
    const tree = buildTree(games);
    const root = normalizeFenResetHalfmoveClock(new Chess().fen());

    // Pass 1 — gather candidate edges via BFS, so each FEN is first reached (and
    // expanded once) at its MINIMUM depth. BFS makes the depth cap robust to
    // transpositions: a position reachable both shallow and deep is expanded with
    // the shallow budget, so an in-budget continuation is never dropped. A FEN's
    // multiple parents each still contribute their own connecting edge.
    const candidates = new Map<string, Candidate[]>();
    const visited = new Set<string>();
    const addCandidate = (from: string, c: Candidate) => {
        const list = candidates.get(from) ?? [];
        list.push(c);
        candidates.set(from, list);
    };

    const queue: { fen: string; depth: number }[] = [{ fen: root, depth: 0 }];
    while (queue.length > 0) {
        const { fen, depth } = queue.shift()!;
        if (depth >= MAX_DEPTH_PLIES || visited.has(fen)) continue;
        visited.add(fen);
        const node = tree.get(fen);
        if (!node) continue;

        if (isUserTurnForOrientation(fen, color)) {
            const move = chooseUserMove(node, color);
            if (!move) continue;
            const to = fenAfterNorm(fen, move);
            if (!to) continue;
            addCandidate(fen, { san: move, to, isUser: true });
            queue.push({ fen: to, depth: depth + 1 });
        } else {
            for (const san of chooseOpponentReplies(node, color)) {
                const to = fenAfterNorm(fen, san);
                if (!to) continue;
                addCandidate(fen, { san, to, isUser: false });
                queue.push({ fen: to, depth: depth + 1 });
            }
        }
    }

    // Pass 2 — prune opponent edges that lead nowhere (no user move below).
    const usefulMemo = new Map<string, boolean>();
    const inProgress = new Set<string>();
    const usefulFrom = (fen: string): boolean => {
        const cached = usefulMemo.get(fen);
        if (cached !== undefined) return cached;
        // Cycle guard (repetition transpositions). This is prune-only/safe: a node
        // resolved as `false` solely because its only useful path looped back to an
        // in-progress ancestor still reaches a user move via that ancestor (which is
        // itself reachable from root), so no user edge is lost — only a redundant
        // cyclic connector is dropped, consistent with the "fewer lines" bias.
        if (inProgress.has(fen)) return false;
        inProgress.add(fen);
        const list = candidates.get(fen) ?? [];
        const useful = list.some(c => c.isUser || usefulFrom(c.to));
        inProgress.delete(fen);
        usefulMemo.set(fen, useful);
        return useful;
    };
    const keepEdge = (c: Candidate) => c.isUser || usefulFrom(c.to);

    // Pass 3 — BFS from root so each edge's parent precedes it (PendingEditModel
    // requires `from` already reachable when an edge is added).
    const edges: BootstrapEdge[] = [];
    const seen = new Set<string>();
    const outQueue: string[] = [root];
    while (outQueue.length > 0) {
        const fen = outQueue.shift()!;
        if (seen.has(fen)) continue;
        seen.add(fen);
        for (const c of candidates.get(fen) ?? []) {
            if (!keepEdge(c)) continue;
            edges.push({ orientation: color, from: fen, san: c.san });
            outQueue.push(c.to);
        }
    }
    return edges;
}

function buildTree(games: BootstrapGame[]): Map<string, TreeNode> {
    const tree = new Map<string, TreeNode>();
    for (const game of games) {
        const sans = game.moves.split(/\s+/).filter(Boolean);
        const chess = new Chess();
        let fenBefore = normalizeFenResetHalfmoveClock(chess.fen());
        for (let p = 0; p < sans.length; p++) {
            let moved;
            try {
                moved = chess.move(sans[p]);
            } catch {
                break;
            }
            if (!moved) break;
            const node = tree.get(fenBefore) ?? { obs: new Map<string, Observation>() };
            if (!tree.has(fenBefore)) tree.set(fenBefore, node);
            // First occurrence of this FEN in this game wins (opening choice).
            if (!node.obs.has(game.id)) {
                node.obs.set(game.id, {
                    gameId: game.id,
                    san: moved.san,
                    createdAt: game.createdAt,
                    beforeEval: game.analysis[p]?.eval ?? null,
                    afterEval: game.analysis[p + 1]?.eval ?? null,
                });
            }
            fenBefore = normalizeFenResetHalfmoveClock(chess.fen());
        }
    }
    return tree;
}

/**
 * The user's seeded move at a user-turn position, or null if any gate fails:
 * recency + consistency (most-recent up-to-5 unanimous, floor 3) and soundness
 * (conservative eval drop < 30cp).
 */
function chooseUserMove(node: TreeNode, color: BootstrapColor): string | null {
    const obs = [...node.obs.values()];
    if (obs.length < MIN_GAMES) return null;

    // Recency: most-recent games first (deterministic tie-break by id).
    obs.sort((a, b) => b.createdAt - a.createdAt || (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));
    const window = obs.slice(0, Math.min(CONSISTENCY_WINDOW, obs.length));
    const san = window[0].san;
    if (!window.every(o => o.san === san)) return null;

    // Soundness: conservative drop computed PER GAME (a real before+after pair),
    // most user-favorable across the window. Unknown (no game with both evals) →
    // dropped, not assumed sound.
    const drop = conservativeDropAcrossSamples(window, color === 'white');
    if (drop === null || categorizeEvalDrop(drop) !== 'ok') return null;

    return san;
}

/**
 * Conservative eval drop over per-game (before, after) samples, reusing
 * `EvalDropService.computeConservativeDrop`. Each sample is one game's own
 * before+after pair — we never cross-pair one game's "before" with another's
 * "after". Returns null when no sample has BOTH evals (the move is unknown, so
 * the caller drops it). With multiple complete samples the most user-favorable
 * (minimum) drop is used, matching the conservative-highlighting semantics.
 */
function conservativeDropAcrossSamples(
    samples: { beforeEval: number | null; afterEval: number | null }[],
    isWhiteMove: boolean,
): number | null {
    let minDrop = Infinity;
    let found = false;
    for (const s of samples) {
        if (s.beforeEval === null || s.afterEval === null) continue;
        const drop = computeConservativeDrop([s.beforeEval], [s.afterEval], isWhiteMove);
        if (drop < minDrop) minDrop = drop;
        found = true;
    }
    return found ? minDrop : null;
}

/**
 * Opponent replies worth branching into at an opponent-turn position: common
 * enough (count ≥ floor and share ≥ threshold), not engine-dubious, capped.
 * Sorted by frequency (then SAN) for determinism.
 */
function chooseOpponentReplies(node: TreeNode, color: BootstrapColor): string[] {
    const obs = [...node.obs.values()];
    const total = obs.length;
    if (total === 0) return [];

    interface Group { count: number; samples: { beforeEval: number | null; afterEval: number | null }[]; }
    const groups = new Map<string, Group>();
    for (const o of obs) {
        const g = groups.get(o.san) ?? { count: 0, samples: [] };
        g.count += 1;
        g.samples.push({ beforeEval: o.beforeEval, afterEval: o.afterEval });
        groups.set(o.san, g);
    }

    // The opponent is the mover here; for the conservative drop, isWhiteMove is
    // true only when the user is Black (so the opponent plays White).
    const opponentIsWhite = color === 'black';
    const kept = [...groups.entries()].filter(([, g]) => {
        if (g.count < MIN_GAMES) return false;
        if (g.count / total < MIN_OPP_SHARE) return false;
        // Engine-dubious replies are pruned; unknown evals are not assumed dubious.
        const drop = conservativeDropAcrossSamples(g.samples, opponentIsWhite);
        if (drop !== null && categorizeEvalDrop(drop) !== 'ok') return false;
        return true;
    });

    kept.sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return kept.slice(0, MAX_OPP_BRANCHES).map(([san]) => san);
}

function fenAfterNorm(fromNormFen: string, san: string): string | null {
    try {
        const chess = new Chess(fromNormFen);
        const m = chess.move(san);
        if (!m) return null;
        return normalizeFenResetHalfmoveClock(chess.fen());
    } catch {
        return null;
    }
}

// ── Bulk fetchers (net-new; reuse only the transport/parse layer) ────

/**
 * Stream a Lichess games-export NDJSON response line-by-line, invoking `onGame`
 * for each eligible game. Streaming keeps the download counter animating during
 * the one genuinely slow phase; falls back to a buffered read when the runtime
 * has no `ReadableStream` body (e.g. jsdom).
 */
async function fetchLichessBulk(
    username: string,
    onGame: (gameData: Record<string, unknown>) => void,
    signal?: AbortSignal,
): Promise<void> {
    const params = new URLSearchParams({
        rated: 'true',
        perfType: 'blitz,rapid',
        sort: 'dateDesc',
        max: String(BOOTSTRAP_TARGET_GAMES),
        evals: 'true',
        clocks: 'false',
        opening: 'false',
    });
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;
    const response = await fetch(url, { headers: { Accept: 'application/x-ndjson' }, signal });
    if (!response.ok) {
        throw new Error(`Lichess API error: ${response.status} ${response.statusText}`);
    }

    const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let gd: Record<string, unknown>;
        try {
            gd = JSON.parse(trimmed);
        } catch {
            return;
        }
        if (isEligibleLichessGame(gd)) onGame(gd);
    };

    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = await response.text();
        for (const line of text.split('\n')) handleLine(line);
        return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            if (signal?.aborted) {
                throw new DOMException('aborted', 'AbortError');
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
                handleLine(buffer.slice(0, nl));
                buffer = buffer.slice(nl + 1);
                nl = buffer.indexOf('\n');
            }
        }
        // Flush any bytes held by the decoder, then the unterminated final line.
        buffer += decoder.decode();
        if (buffer) handleLine(buffer);
    } finally {
        // Always release the lock — on abort, a mid-stream throw, or normal end.
        await reader.cancel().catch(() => undefined);
    }
}

function isEligibleLichessGame(gd: Record<string, unknown>): boolean {
    const variant = gd.variant as string | undefined;
    if (variant && variant !== 'standard') return false;
    const speed = gd.speed as string | undefined;
    if (speed !== 'blitz' && speed !== 'rapid') return false;
    if (gd.rated !== true) return false;
    return typeof gd.id === 'string' && typeof gd.createdAt === 'number' && typeof gd.moves === 'string';
}

/**
 * Bulk-fetch Chess.com games by walking the monthly-archive index most-recent
 * first, stopping once the target count is reached. Reuses the archive-fetch
 * transport pattern; the per-game eval fill happens later (Chess.com carries no
 * per-game evals, so those positions come entirely from the artifact).
 */
async function fetchChesscomBulk(
    username: string,
    onGame: (gameData: Record<string, unknown>) => void,
    signal?: AbortSignal,
): Promise<void> {
    const idxUrl = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
    const idxResp = await fetch(idxUrl, { signal });
    if (idxResp.status === 404) return;
    if (!idxResp.ok) {
        throw new Error(`Chess.com API error: ${idxResp.status} ${idxResp.statusText}`);
    }
    const idxJson = await idxResp.json();
    const urls: unknown = (idxJson as { archives?: unknown })?.archives;
    const archiveUrls = Array.isArray(urls) ? [...(urls as string[])].reverse() : [];

    let count = 0;
    for (const archiveUrl of archiveUrls) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (count >= BOOTSTRAP_TARGET_GAMES) break;
        const resp = await fetch(archiveUrl, { signal });
        if (resp.status === 404) continue;
        if (!resp.ok) {
            throw new Error(`Chess.com API error: ${resp.status} ${resp.statusText}`);
        }
        const json = await resp.json();
        const monthGames = Array.isArray((json as { games?: unknown })?.games)
            ? (json as { games: unknown[] }).games
            : [];
        // Newest games sit at the end of a monthly archive; walk it in reverse so
        // we keep the most recent when the target cap is hit mid-month.
        for (let i = monthGames.length - 1; i >= 0; i--) {
            if (count >= BOOTSTRAP_TARGET_GAMES) break;
            const g = monthGames[i] as Record<string, unknown>;
            if (!isEligibleChesscomGame(g)) continue;
            onGame(g);
            count += 1;
        }
    }
}

function isEligibleChesscomGame(g: Record<string, unknown>): boolean {
    if (g.rules !== 'chess') return false;
    const speed = g.time_class as string | undefined;
    if (speed !== 'blitz' && speed !== 'rapid') return false;
    if (g.rated !== true) return false;
    return typeof g.uuid === 'string' && typeof g.end_time === 'number' && typeof g.pgn === 'string';
}
