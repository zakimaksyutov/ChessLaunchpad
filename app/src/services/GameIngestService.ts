import { Chess } from 'chess.js';
import { IRepertoireDataStore } from '../data/DataAccessProxyLayer';
import { FSRSService } from './FSRSService';
import { AuditService } from './AuditService';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import {
    LinkedAccount,
    Platform,
    getAccountKey,
} from './LinkedAccountsService';
import {
    ensureActivity,
    getOrCreateEntryByDate,
    getDateStringForTimestamp,
} from './ActivityService';
import { getUserColor, buildPgn } from './GameAnnotationService';
import { buildGameRecord } from './GameRecordBuilder';
import { appendGameRecord, evictOverflowingRecords } from './GameRecordStore';
import {
    RepertoireData,
    GameIngestState,
    RecentGameId,
    ChesscomProviderCursor,
    GamesIngestMap,
} from '../models/RepertoireData';

const AGE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_RECENT_IDS = 50;
const LICHESS_MAX_PER_REQUEST = 500;

interface IngestGame {
    id: string;
    createdAt: number;
    platform: Platform;
    username: string;         // linked-account username (lowercase)
    accountKey: string;
    gameData: Record<string, unknown>;
}

interface AccountFetchResult {
    accountKey: string;
    games: IngestGame[];
    /** chess.com only: cursor to write back on success. */
    providerCursor?: ChesscomProviderCursor;
    fetchSucceeded: boolean;
}

export interface IngestSummary {
    /** A blob write happened — caller may want to refresh repertoire data. */
    didWrite: boolean;
    /** Total games processed across all accounts. */
    gamesProcessed: number;
}

/**
 * Progress events emitted by runIngest for UI feedback (e.g. Dashboard banner).
 *
 * - `fetching`: emitted before each per-account fetch. accountIndex is 1-based.
 *   On 412 retries the pipeline restarts and these events are re-emitted from 1.
 * - `done`: emitted exactly once at the end, even on caught failures
 *   (gamesProcessed == 0 in that case). Callers can treat "done with 0" as a
 *   silent no-op since failures and "nothing new" are indistinguishable here.
 *
 * Never emitted at all when the user has no linked accounts.
 */
export type IngestProgress =
    | { phase: 'fetching'; accountIndex: number; accountTotal: number; platform: Platform; username: string }
    | { phase: 'done'; gamesProcessed: number };

export type IngestProgressCallback = (progress: IngestProgress) => void;

/**
 * Top-level entry — Dashboard calls this on mount.
 *
 * Pipeline:
 *   1. Fetch recent games per linked account.
 *   2. Retrieve fresh blob.
 *   3. Filter eligible games (age, watermark, recentIds, rated, blitz/rapid, standard).
 *   4. Sort all eligible games globally by createdAt ASC, id ASC.
 *   5. Replay each game; for each user move:
 *        - In-repertoire move → Good (timestamped at game.createdAt)
 *        - First deviation → Again on every sibling card sharing fenBefore, then stop.
 *   6. Update per-day game counters and per-account state.
 *   7. PUT with If-Match (single attempt; the app-root `<ConflictModal>`
 *      handles 412 recovery via page reload).
 *
 * Never throws — all errors are logged and swallowed, except `AbortError`
 * which is re-raised so callers can distinguish "I asked it to stop"
 * from "ingest failed". Optional `signal` aborts between phases and is
 * forwarded to provider HTTP fetches.
 */
export async function runIngest(
    dal: IRepertoireDataStore,
    onProgress?: IngestProgressCallback,
    signal?: AbortSignal,
): Promise<IngestSummary> {
    const failureSummary: IngestSummary = { didWrite: false, gamesProcessed: 0 };
    const runNowMs = Date.now();
    let result: IngestSummary = failureSummary;
    let emittedAny = false;
    const wrappedProgress: IngestProgressCallback | undefined = onProgress
        ? (p) => { emittedAny = true; onProgress(p); }
        : undefined;
    try {
        result = await runIngestInternal(dal, runNowMs, wrappedProgress, signal);
    } catch (e) {
        // Abort is an expected control-flow signal — re-raise so callers
        // can distinguish "I asked it to stop" from "ingest failed".
        if (signal?.aborted || (e as { name?: string })?.name === 'AbortError') {
            throw e;
        }
        // Telemetry only — never surface to UI.
        // eslint-disable-next-line no-console
        console.error('GameIngest: failed', e);
        result = failureSummary;
    }
    // Only emit `done` if we ever emitted `fetching` — preserves the
    // "no linked accounts → never notify" contract.
    if (onProgress && emittedAny && !signal?.aborted) {
        onProgress({ phase: 'done', gamesProcessed: result.gamesProcessed });
    }
    return result;
}

async function runIngestInternal(
    dal: IRepertoireDataStore,
    runNowMs: number,
    onProgress?: IngestProgressCallback,
    signal?: AbortSignal,
): Promise<IngestSummary> {
    const summary: IngestSummary = { didWrite: false, gamesProcessed: 0 };

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const data = await dal.retrieveRepertoireData();

    // Source the linked-accounts list from the freshest blob — not from the
    // process-local cache, which can be stale during initial Dashboard mount
    // and is shared across user sessions in a single SPA process. Falls back
    // to an empty list if the user has none.
    const linkedAccountsRaw = data.settings?.linkedAccounts ?? [];
    const linkedAccounts: LinkedAccount[] = linkedAccountsRaw.map(a => ({
        platform: a.platform || 'lichess',
        username: a.username.toLowerCase(),
    }));
    if (linkedAccounts.length === 0) return summary;

    const fetches = await fetchAllAccounts(linkedAccounts, data.games, runNowMs, onProgress, signal);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const eligible = composeEligibleGames(data.games, fetches, runNowMs);
    const hasCursorChange = fetches.some(af => providerCursorChanged(data.games?.[af.accountKey], af));

    if (eligible.length === 0 && !hasCursorChange) {
        // Nothing to persist.
        return summary;
    }

    applyIngest(data, eligible, linkedAccounts);
    updateAccountStates(data, fetches, eligible);

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    // Project in-memory state into the position-centric blob shape
    // before persisting — re-syncs the position dict with FSRSService's
    // in-place card mutations.
    const blobForSave = RepertoireDataUtils.prepareDataForSave(data);
    // Single attempt: on 412 the underlying SessionStore.save fires the
    // global conflict notifier (app-root <ConflictModal> shows a Reload
    // prompt) and rethrows; the top-level catch in runIngest swallows
    // the error and the next Dashboard visit re-runs ingest.
    await dal.storeRepertoireData(blobForSave, signal);
    return { didWrite: true, gamesProcessed: eligible.length };
}

async function fetchAllAccounts(
    accounts: LinkedAccount[],
    gamesMap: GamesIngestMap | undefined,
    runNowMs: number,
    onProgress?: IngestProgressCallback,
    signal?: AbortSignal,
): Promise<AccountFetchResult[]> {
    const results: AccountFetchResult[] = [];
    for (let i = 0; i < accounts.length; i++) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const acct = accounts[i];
        const accountKey = getAccountKey(acct.platform, acct.username);
        const state = gamesMap?.[accountKey];
        onProgress?.({
            phase: 'fetching',
            accountIndex: i + 1,
            accountTotal: accounts.length,
            platform: acct.platform,
            username: acct.username,
        });
        try {
            if (acct.platform === 'lichess') {
                const games = await fetchLichessGames(acct.username, state, runNowMs, signal);
                results.push({ accountKey, games, fetchSucceeded: true });
            } else {
                const { games, providerCursor } = await fetchChesscomGames(acct.username, state, runNowMs, signal);
                results.push({ accountKey, games, providerCursor, fetchSucceeded: true });
            }
        } catch (e) {
            if (signal?.aborted) throw e;
            // eslint-disable-next-line no-console
            console.error(`GameIngest: fetch failed for ${accountKey}`, e);
            results.push({ accountKey, games: [], fetchSucceeded: false });
        }
    }
    return results;
}

function providerCursorChanged(
    prev: GameIngestState | undefined,
    af: AccountFetchResult,
): boolean {
    const next = af.providerCursor;
    if (!next) return false;
    const old = prev?.providerCursor;
    if (!old) return true;
    return old.etag !== next.etag || old.month !== next.month;
}

function composeEligibleGames(
    gamesMap: GamesIngestMap | undefined,
    fetches: AccountFetchResult[],
    runNowMs: number,
): IngestGame[] {
    const eligible: IngestGame[] = [];
    for (const af of fetches) {
        const state = gamesMap?.[af.accountKey];
        const watermarkMs = state?.watermarkMs ?? 0;
        const recentIds = new Set((state?.recentIds ?? []).map(r => r.id));
        for (const g of af.games) {
            if (g.createdAt <= watermarkMs) continue;
            if (recentIds.has(g.id)) continue;
            if (runNowMs - g.createdAt > AGE_WINDOW_MS) continue;
            if (g.createdAt > runNowMs) continue;
            eligible.push(g);
        }
    }
    // Sort by createdAt ASC, then id ASC for determinism.
    eligible.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return eligible;
}

function applyIngest(
    data: RepertoireData,
    games: IngestGame[],
    linkedAccounts: LinkedAccount[],
): void {
    if (games.length === 0) return;

    const activity = ensureActivity(data);
    const { whiteFens, blackFens } = buildRepertoireFenSets(data.repertoires);
    if (!data.fsrsCards) data.fsrsCards = {};
    // Seed the audit array if missing so AuditService can mutate a stable
    // reference (decode preserves an existing array verbatim; normalize seeds
    // it too — this is a belt-and-braces guard for ingest paths that may
    // construct a sparse blob in tests). See `docs/product-specs/FSRS-AUDIT.md`.
    if (!data.audit) data.audit = [];
    const fsrs = new FSRSService(data.fsrsCards, new AuditService(data.audit));

    // accountKey → linked-account info (for getUserColor)
    const acctLookup = new Map<string, { username: string; platform: Platform }>();
    for (const a of linkedAccounts) {
        acctLookup.set(getAccountKey(a.platform, a.username), { username: a.username, platform: a.platform });
    }

    for (const game of games) {
        const acct = acctLookup.get(game.accountKey);
        if (!acct) continue;

        const userColor = getUserColor(game.gameData, acct.username, acct.platform);
        if (!userColor) continue;

        const repFens = userColor === 'white' ? whiteFens : blackFens;
        const result = processGame(game, userColor, repFens, fsrs);

        const date = getDateStringForTimestamp(game.createdAt);
        const entry = getOrCreateEntryByDate(activity, date);
        if (!entry.games) entry.games = { ingested: 0, reviewed: 0, mistakes: 0 };
        entry.games.ingested += 1;
        entry.games.reviewed += result.reviewed;
        entry.games.mistakes += result.hadMistake ? 1 : 0;

        // Persist a compact `GameRecord` alongside the counters so the
        // /games page can render this game across devices. The record
        // captures display facts only — analysis verdicts (`an`/`op`) are
        // written later by the /games analysis pass. Build failures (e.g.
        // unparseable provider payload) are silent — the game still counts
        // for ingest, we just have no record to render.
        const record = buildGameRecord(game.gameData, acct.username, acct.platform);
        if (record) {
            appendGameRecord(activity, record);
        }
    }

    // Eviction is part of the shared record-append write path: every time
    // records are appended we re-trim to MAX_TOTAL_RECORDS. Running this
    // here (not on the read side) means the /games landing flow only ever
    // analyzes surviving records — masters budget is never spent on games
    // about to be dropped.
    evictOverflowingRecords(activity);

    // FSRSService mutates the shared cards object passed in the constructor, so
    // data.fsrsCards is already up to date. Set it explicitly for clarity.
    data.fsrsCards = fsrs.getCards();
}

function processGame(
    game: IngestGame,
    userColor: 'white' | 'black',
    repertoireFens: Set<string>,
    fsrs: FSRSService,
): { reviewed: number; hadMistake: boolean } {
    const pgn = buildPgn(game.gameData, game.platform);
    if (!pgn) return { reviewed: 0, hadMistake: false };

    const chess = new Chess();
    try {
        chess.loadPgn(pgn);
    } catch {
        return { reviewed: 0, hadMistake: false };
    }
    chess.deleteComments();

    const moves = chess.history({ verbose: true });
    const sim = new Chess();
    const gameCreatedAt = new Date(game.createdAt);
    let reviewed = 0;

    for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        const fenBefore = sim.fen();
        const normFenBefore = normalizeFenResetHalfmoveClock(fenBefore);
        try {
            sim.move({ from: move.from, to: move.to, promotion: move.promotion });
        } catch {
            // Malformed game — abandon further processing.
            break;
        }
        const normFenAfter = normalizeFenResetHalfmoveClock(sim.fen());

        // ply 0 = white's first move. User plays white → user moves at even ply (0,2,4,...).
        const isUserMove = userColor === 'white' ? i % 2 === 0 : i % 2 === 1;
        if (!isUserMove) continue;

        const beforeIn = repertoireFens.has(normFenBefore);
        const afterIn = repertoireFens.has(normFenAfter);

        if (beforeIn && afterIn) {
            // In-repertoire user move → Good rating if card exists and not already
            // reviewed at-or-after this game's timestamp.
            const key = FSRSService.makeCardKey(normFenBefore, move.san);
            const card = fsrs.getCards()[key];
            if (card && shouldApplyRating(card.lastReview, game.createdAt)) {
                fsrs.rateCard(normFenBefore, move.san, true, gameCreatedAt, 'ingest');
                reviewed += 1;
            }
        } else if (beforeIn && !afterIn) {
            // First deviation — Again on every sibling card sharing fenBefore.
            const prefix = `${normFenBefore}::`;
            const cards = fsrs.getCards();
            const keys = Object.keys(cards).filter(k => k.startsWith(prefix));
            for (const k of keys) {
                if (!shouldApplyRating(cards[k].lastReview, game.createdAt)) continue;
                fsrs.rateCardByKey(k, false, gameCreatedAt, 'ingest');
            }
            return { reviewed, hadMistake: true };
        }
        // else: skipped (transposition into repertoire, or fenBefore out of repertoire).
    }

    return { reviewed, hadMistake: false };
}

/**
 * Returns true if a rating with this gameCreatedAt should be applied (i.e. would
 * not move the card's last_review backward).
 */
function shouldApplyRating(lr: string | undefined, gameCreatedAt: number): boolean {
    if (!lr) return true;
    const lrMs = new Date(lr).getTime();
    if (isNaN(lrMs)) return true;
    return lrMs <= gameCreatedAt;
}

function updateAccountStates(
    data: RepertoireData,
    fetches: AccountFetchResult[],
    processedGames: IngestGame[],
): void {
    if (!data.games) data.games = {};

    const processedByAccount = new Map<string, IngestGame[]>();
    for (const g of processedGames) {
        const list = processedByAccount.get(g.accountKey) ?? [];
        list.push(g);
        processedByAccount.set(g.accountKey, list);
    }

    for (const af of fetches) {
        const prev: GameIngestState = data.games[af.accountKey] ?? { watermarkMs: 0, recentIds: [] };
        const processed = processedByAccount.get(af.accountKey) ?? [];

        let newWatermark = prev.watermarkMs;
        for (const g of processed) {
            if (g.createdAt > newWatermark) newWatermark = g.createdAt;
        }

        // Merge recentIds: carry over the prior ring + add freshly-processed entries.
        // Each entry carries its real `createdAt`, so eviction by (ts desc, id asc) is
        // deterministic across concurrent clients without needing any synthetic stamp.
        const recentMap = new Map<string, number>();
        for (const r of prev.recentIds) {
            recentMap.set(r.id, r.ts);
        }
        for (const g of processed) {
            recentMap.set(g.id, g.createdAt);
        }

        const sorted = Array.from(recentMap.entries()).sort((a, b) => {
            const [idA, tsA] = a;
            const [idB, tsB] = b;
            if (tsA !== tsB) return tsB - tsA;
            return idA < idB ? -1 : idA > idB ? 1 : 0;
        });

        const recentIds: RecentGameId[] = sorted
            .slice(0, MAX_RECENT_IDS)
            .map(([id, ts]) => ({ id, ts }));

        const next: GameIngestState = {
            watermarkMs: newWatermark,
            recentIds,
        };
        if (af.providerCursor) {
            next.providerCursor = af.providerCursor;
        } else if (prev.providerCursor) {
            next.providerCursor = prev.providerCursor;
        }

        data.games[af.accountKey] = next;
    }
}

// ── Lichess fetcher ──────────────────────────────────────────────────

async function fetchLichessGames(
    username: string,
    state: GameIngestState | undefined,
    runNowMs: number,
    signal?: AbortSignal,
): Promise<IngestGame[]> {
    const watermark = state?.watermarkMs ?? 0;
    // Use the max of (watermark+1, runNow - AGE_WINDOW) so initial runs don't pull years of history.
    const sinceMs = Math.max(watermark + 1, runNowMs - AGE_WINDOW_MS);

    const params = new URLSearchParams({
        rated: 'true',
        perfType: 'blitz,rapid',
        sort: 'dateAsc',
        max: LICHESS_MAX_PER_REQUEST.toString(),
        since: sinceMs.toString(),
        // Per-ply server evals — GameRecordBuilder stores them as `record.ev`,
        // which drives eval-drop badges and ambiguous-zone masters checks.
        evals: 'true',
        // Opening name — GameRecordBuilder reads `opening.name` into `record.o`
        // and the /games page renders it next to each row. Without this flag
        // the bulk endpoint omits the `opening` block entirely, so freshly
        // ingested rows would show no opening name until a per-game
        // Re-annotate refetched through `/game/export/{id}?opening=true`.
        opening: 'true',
    });

    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;

    const response = await fetch(url, {
        headers: { 'Accept': 'application/x-ndjson' },
        signal,
    });
    if (!response.ok) {
        throw new Error(`Lichess API error: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    const accountKey = getAccountKey('lichess', username);
    const games: IngestGame[] = [];
    let rawLineCount = 0;

    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let gd: Record<string, unknown>;
        try {
            gd = JSON.parse(trimmed);
        } catch {
            continue;
        }
        rawLineCount += 1;
        const variant = gd.variant as string | undefined;
        if (variant && variant !== 'standard') continue;
        const speed = gd.speed as string | undefined;
        if (speed !== 'blitz' && speed !== 'rapid') continue;
        if (gd.rated !== true) continue;
        const id = gd.id as string | undefined;
        const createdAt = gd.createdAt as number | undefined;
        if (!id || typeof createdAt !== 'number') continue;
        games.push({
            id,
            createdAt,
            platform: 'lichess',
            username,
            accountKey,
            gameData: gd,
        });
    }

    // Lichess returns at most LICHESS_MAX_PER_REQUEST raw rows per call and we
    // don't paginate. We use sort=dateAsc, so the truncation drops the *newest*
    // games beyond the cap — but those will reappear in the next ingest run
    // because the watermark only advances to the highest createdAt we did
    // process. The warn is purely an observability signal: if it ever fires in
    // production telemetry we should implement pagination so a single ingest
    // run sees the full window.
    if (rawLineCount >= LICHESS_MAX_PER_REQUEST) {
        // eslint-disable-next-line no-console
        console.warn(
            `GameIngest: Lichess fetch for ${username} returned ${rawLineCount} rows — at LICHESS_MAX_PER_REQUEST cap. Newer games in window deferred until next run; consider adding pagination if this recurs.`
        );
    }
    return games;
}

// ── Chess.com fetcher ────────────────────────────────────────────────

function archiveLabelFromMs(runNowMs: number): string {
    const d = new Date(runNowMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${yyyy}-${mm}`;
}

function archiveUrlForLabel(username: string, label: string): string {
    const [yyyy, mm] = label.split('-');
    return `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${yyyy}/${mm}`;
}

async function fetchChesscomGames(
    username: string,
    state: GameIngestState | undefined,
    runNowMs: number,
    signal?: AbortSignal,
): Promise<{ games: IngestGame[]; providerCursor?: ChesscomProviderCursor }> {
    const currentLabel = archiveLabelFromMs(runNowMs);
    const accountKey = getAccountKey('chess.com', username);

    // If the 5-day window crosses a month boundary, also fetch the previous month.
    const ageBoundaryMs = runNowMs - AGE_WINDOW_MS;
    const ageBoundaryLabel = archiveLabelFromMs(ageBoundaryMs);
    const labelsToFetch: string[] = [];
    if (ageBoundaryLabel !== currentLabel) labelsToFetch.push(ageBoundaryLabel);
    labelsToFetch.push(currentLabel);

    const allGames: IngestGame[] = [];
    let newCursor: ChesscomProviderCursor | undefined;

    for (const label of labelsToFetch) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const url = archiveUrlForLabel(username, label);
        const headers: Record<string, string> = {};
        const prevCursor = state?.providerCursor;
        // Only attempt conditional fetch when our cursor matches this month.
        if (label === currentLabel && prevCursor && prevCursor.month === label && prevCursor.etag) {
            headers['If-None-Match'] = prevCursor.etag;
        }

        const response = await fetch(url, { headers, signal });
        if (response.status === 304) {
            // No changes — preserve cursor.
            if (label === currentLabel && prevCursor) newCursor = prevCursor;
            continue;
        }
        if (response.status === 404) {
            // No archive for this month (e.g., new month with no games yet).
            continue;
        }
        if (!response.ok) {
            throw new Error(`Chess.com API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const etag = response.headers.get('ETag') ?? undefined;
        if (label === currentLabel && etag) {
            newCursor = { month: label, etag };
        }

        const monthGames = Array.isArray(json?.games) ? json.games : [];
        for (const g of monthGames as Array<Record<string, unknown>>) {
            if (g.rules !== 'chess') continue;
            const speed = g.time_class as string | undefined;
            if (speed !== 'blitz' && speed !== 'rapid') continue;
            if (g.rated !== true) continue;
            const uuid = g.uuid as string | undefined;
            const endTime = g.end_time as number | undefined;
            if (!uuid || typeof endTime !== 'number') continue;
            const createdAt = endTime * 1000;
            allGames.push({
                id: uuid,
                createdAt,
                platform: 'chess.com',
                username,
                accountKey,
                gameData: g,
            });
        }
    }

    return { games: allGames, providerCursor: newCursor };
}
