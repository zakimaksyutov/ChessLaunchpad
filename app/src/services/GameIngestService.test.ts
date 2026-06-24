import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Chess } from 'chess.js';
import { runIngest, IngestProgress } from './GameIngestService';
import { setLinkedAccounts, getAccountKey } from './LinkedAccountsService';
import { RepertoireData } from '../models/RepertoireData';
import { IDataAccessLayer, DataAccessError } from '../data/DataAccessLayer';
import { FSRSService } from './FSRSService';
import { AuditService } from './AuditService';
import { buildRepertoireFenSets } from '../models/RepertoireFenSet';
import { normalizeFenResetHalfmoveClock } from '../utils/FenUtils';
import { RepertoireDataUtils } from '../utils/RepertoireDataUtils';
import { extractFsrsCardsFromRepertoires } from '../utils/RepertoiresSerde';
import { pgnToRepertoires, PgnVariantInput } from '../test-utils/repertoireBuilders';

// ── Test helpers ──────────────────────────────────────────────────────

const FAKE_NOW = new Date('2026-05-25T12:00:00Z');

function makeVariant(pgn: string, orientation: 'white' | 'black'): PgnVariantInput {
    return {
        pgn,
        orientation,
    };
}

function makeData(variants: PgnVariantInput[] = []): RepertoireData {
    // Build position-centric repertoires from PGN test fixtures, then run
    // normalize() so module-level state (FSRSService etc.) is hydrated.
    const data: RepertoireData = {
        repertoires: pgnToRepertoires(variants),
        fsrsCards: {},
        settings: {},
        activity: {
            practiceLog: [],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        },
    };
    RepertoireDataUtils.normalize(data);
    return data;
}

class MockDal implements IDataAccessLayer {
    data: RepertoireData;
    retrieveCount = 0;
    storeCount = 0;
    /** If non-null, the next storeRepertoireData throws a 412; reset after firing. */
    nextStoreError: DataAccessError | null = null;

    constructor(initial: RepertoireData) {
        this.data = clone(initial);
    }
    async createAccount() {}
    async deleteAccount() {}
    async retrieveRepertoireData(): Promise<RepertoireData> {
        this.retrieveCount += 1;
        return clone(this.data);
    }
    async storeRepertoireData(data: RepertoireData): Promise<void> {
        this.storeCount += 1;
        if (this.nextStoreError) {
            const err = this.nextStoreError;
            this.nextStoreError = null;
            throw err;
        }
        this.data = clone(data);
    }
}

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

/**
 * Per-test helper: keep the module-level cache in sync AND populate
 * data.settings.linkedAccounts so runIngest (which now reads from the
 * fresh blob, not the cache) picks them up.
 */
function setAccounts(
    data: RepertoireData,
    accounts: Array<{ platform: 'lichess' | 'chess.com'; username: string }>
): void {
    setLinkedAccounts(accounts);
    if (!data.settings) data.settings = {};
    data.settings.linkedAccounts = accounts;
}

// ── Lichess game fixtures ────────────────────────────────────────────

function buildLichessGameNdjson(games: Record<string, unknown>[]): string {
    return games.map(g => JSON.stringify(g)).join('\n');
}

function lichessGame(opts: {
    id: string;
    createdAt: number;
    userIsWhite: boolean;
    moves: string;            // SAN-encoded ply list, e.g. "e4 c5 Nf3"
    rated?: boolean;
    speed?: string;
    variant?: string;
}): Record<string, unknown> {
    return {
        id: opts.id,
        createdAt: opts.createdAt,
        rated: opts.rated ?? true,
        speed: opts.speed ?? 'blitz',
        variant: opts.variant ?? 'standard',
        players: {
            white: { user: { id: opts.userIsWhite ? 'me' : 'opp', name: opts.userIsWhite ? 'me' : 'opp' } },
            black: { user: { id: opts.userIsWhite ? 'opp' : 'me', name: opts.userIsWhite ? 'opp' : 'me' } },
        },
        moves: opts.moves,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('GameIngestService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(FAKE_NOW);
        setLinkedAccounts([]);
        // Reset fetch mock between tests.
        vi.spyOn(globalThis, 'fetch').mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function mockLichessOnce(games: Record<string, unknown>[]) {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () => buildLichessGameNdjson(games),
            json: async () => ({}),
        } as unknown as Response);
    }

    /**
     * Mocks the first-run Chess.com fetch sequence: the `/archives` index (one
     * URL per supplied month, ascending) followed by each month's archive in the
     * most-recent-first order the fetcher walks them.
     */
    function mockChesscomFirstRun(
        months: Array<{ label: string; games: Record<string, unknown>[]; etag?: string }>,
    ) {
        const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
        const ascending = [...months].map(m => m.label).sort();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                archives: ascending.map(l => {
                    const [y, mm] = l.split('-');
                    return `https://api.chess.com/pub/player/me/games/${y}/${mm}`;
                }),
            }),
            text: async () => '',
        } as unknown as Response);
        const recentFirst = [...months].sort((a, b) =>
            a.label < b.label ? 1 : a.label > b.label ? -1 : 0,
        );
        for (const m of recentFirst) {
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers(m.etag ? { 'ETag': m.etag } : {}),
                json: async () => ({ games: m.games }),
                text: async () => JSON.stringify({ games: m.games }),
            } as unknown as Response);
        }
    }

    /** Mocks a single fetch response (status/body controllable). */
    function mockFetchOnce(opts: {
        ok?: boolean;
        status?: number;
        json?: unknown;
        etag?: string;
    }) {
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: opts.ok ?? true,
            status: opts.status ?? 200,
            statusText: 'X',
            headers: new Headers(opts.etag ? { 'ETag': opts.etag } : {}),
            json: async () => opts.json ?? {},
            text: async () => JSON.stringify(opts.json ?? {}),
        } as unknown as Response);
    }

    /** Mocks the Chess.com `/archives` index for the supplied month labels. */
    function mockChesscomArchiveIndex(labels: string[], ok = true) {
        mockFetchOnce({
            ok,
            status: ok ? 200 : 404,
            json: {
                archives: [...labels].sort().map(l => {
                    const [y, mm] = l.split('-');
                    return `https://api.chess.com/pub/player/me/games/${y}/${mm}`;
                }),
            },
        });
    }

    it('returns early when no linked accounts', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
        expect(result.gamesProcessed).toBe(0);
        // We still call retrieve once to learn the user has no linked accounts.
        expect(dal.retrieveCount).toBe(1);
        expect(dal.storeCount).toBe(0);
    });

    it('rates Good on in-repertoire user move (white)', async () => {
        // White repertoire: 1. e4 e5 2. Nf3
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        const game = lichessGame({
            id: 'g1',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000, // 1h ago
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);

        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
        const dal = new MockDal(data);
        const result = await runIngest(dal);

        expect(result.didWrite).toBe(true);
        expect(result.gamesProcessed).toBe(1);
        // Verify per-day counter
        const entry = dal.data.activity!.practiceLog.find(e => e.games);
        expect(entry).toBeDefined();
        expect(entry!.games!.ingested).toBe(1);
        expect(entry!.games!.reviewed).toBe(2); // e4 and Nf3 are both user moves in-repertoire
        expect(entry!.games!.mistakes).toBe(0);

        // Verify account state
        const acctKey = getAccountKey('lichess', 'me');
        const accountState = dal.data.games?.[acctKey];
        expect(accountState).toBeDefined();
        expect(accountState!.watermarkMs).toBe(game.createdAt);
        expect(accountState!.recentIds).toEqual([{ id: 'g1', ts: game.createdAt }]);
    });

    it('rates Again on deviation across every sibling card sharing fenBefore', async () => {
        // White repertoire: 1. e4 e5 2. Nf3  AND  1. e4 e5 2. Bc4
        // (so the after-e4-e5 position has cards for Nf3 and Bc4 — both should be rated Again on deviation)
        const v1 = makeVariant('1. e4 e5 2. Nf3', 'white');
        const v2 = makeVariant('1. e4 e5 2. Bc4', 'white');
        const data = makeData([v1, v2]);

        // User plays 1. e4 e5 2. d3 — deviates at move 2 (white-to-move position after 1...e5)
        const game = lichessGame({
            id: 'g2',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 d3',
        });
        mockLichessOnce([game]);

        // Find card keys for Nf3 and Bc4 at the e4-e5 position
        const { whiteFens } = buildRepertoireFenSets(pgnToRepertoires([v1, v2]));
        const positionChess = new Chess();
        positionChess.move('e4'); positionChess.move('e5');
        const normFen = normalizeFenResetHalfmoveClock(positionChess.fen());
        const nf3Key = FSRSService.makeCardKey(normFen, 'Nf3');
        const bc4Key = FSRSService.makeCardKey(normFen, 'Bc4');

        // Sanity — these cards should exist
        expect(data.fsrsCards![nf3Key]).toBeDefined();
        expect(data.fsrsCards![bc4Key]).toBeDefined();

        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
        const dal = new MockDal(data);
        await runIngest(dal);

        const finalCards = extractFsrsCardsFromRepertoires(dal.data.repertoires!);
        // Both sibling cards should have advanced (reps > 0) due to Again rating.
        expect(finalCards[nf3Key].reps).toBeGreaterThan(0);
        expect(finalCards[bc4Key].reps).toBeGreaterThan(0);
        // Both should be in Learning state (state=1) — Again on a new card.
        expect(finalCards[nf3Key].state).toBe(1);
        expect(finalCards[bc4Key].state).toBe(1);

        // Per-day counter
        const entry = dal.data.activity!.practiceLog.find(e => e.games);
        expect(entry!.games!.mistakes).toBe(1);
        // Move 1 (e4) was in-repertoire → +1 reviewed
        expect(entry!.games!.reviewed).toBe(1);

        // Suppress unused-import lint
        expect(whiteFens.size).toBeGreaterThan(0);
    });

    it('stops processing after the first deviation in a game', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5', 'white');
        const data = makeData([variant]);

        // User plays 1. e4 e5 2. d3 (deviation) — would have continued 3. Bg5 etc., but we should stop.
        const game = lichessGame({
            id: 'g3',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 d3 Nc6 Bg5',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        await runIngest(dal);

        const entry = dal.data.activity!.practiceLog.find(e => e.games);
        // Only 1 deviation should be counted, not multiple
        expect(entry!.games!.mistakes).toBe(1);
        // Only e4 was in-repertoire before the deviation — Nc6 and Bg5 never get evaluated.
        expect(entry!.games!.reviewed).toBe(1);
    });

    it('filters out unrated games', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const game = lichessGame({
            id: 'g4',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
            rated: false,
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
        expect(dal.storeCount).toBe(0);
    });

    it('filters out bullet (non blitz/rapid) games', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const game = lichessGame({
            id: 'g5',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
            speed: 'bullet',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
    });

    it('filters out non-standard variants', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const game = lichessGame({
            id: 'g6',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
            variant: 'chess960',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
    });

    it('filters out games older than 5 days (steady state)', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const game = lichessGame({
            id: 'g7',
            createdAt: FAKE_NOW.getTime() - 6 * 24 * 60 * 60 * 1000, // 6 days ago
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        // Pre-existing account state → not a first run, so the 5-day age window
        // applies. Watermark is older than the game so only the age gate filters.
        const acctKey = getAccountKey('lichess', 'me');
        data.games = {
            [acctKey]: { watermarkMs: FAKE_NOW.getTime() - 10 * 24 * 60 * 60 * 1000, recentIds: [] },
        };
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
    });

    it('skips games already covered by watermark', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const gameCreatedAt = FAKE_NOW.getTime() - 60 * 60 * 1000;
        const acctKey = getAccountKey('lichess', 'me');
        // Pre-populate watermark to the game's createdAt
        data.games = {
            [acctKey]: { watermarkMs: gameCreatedAt, recentIds: [] },
        };

        const game = lichessGame({
            id: 'g8',
            createdAt: gameCreatedAt,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
    });

    it('skips games whose id is in recentIds (boundary dedup)', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const gameCreatedAt = FAKE_NOW.getTime() - 60 * 60 * 1000;
        const acctKey = getAccountKey('lichess', 'me');
        data.games = {
            [acctKey]: { watermarkMs: gameCreatedAt - 1000, recentIds: [{ id: 'g9', ts: gameCreatedAt }] },
        };

        const game = lichessGame({
            id: 'g9',
            createdAt: gameCreatedAt,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
    });

    it('advances watermark to max processed createdAt', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const t1 = FAKE_NOW.getTime() - 3 * 60 * 60 * 1000;
        const t2 = FAKE_NOW.getTime() - 1 * 60 * 60 * 1000;

        const g1 = lichessGame({ id: 'a', createdAt: t1, userIsWhite: true, moves: 'e4 e5 Nf3' });
        const g2 = lichessGame({ id: 'b', createdAt: t2, userIsWhite: true, moves: 'e4 e5 Nf3' });
        mockLichessOnce([g1, g2]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        await runIngest(dal);

        const acctKey = getAccountKey('lichess', 'me');
        const state = dal.data.games![acctKey];
        expect(state.watermarkMs).toBe(t2);
    });

    it('caps recentIds at 50, ordered by createdAt desc then id asc', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        // 55 games at successive timestamps within the 5-day window.
        const baseMs = FAKE_NOW.getTime() - 24 * 60 * 60 * 1000; // 1 day ago
        const games = Array.from({ length: 55 }, (_, i) => lichessGame({
            id: `g${String(i).padStart(3, '0')}`,
            createdAt: baseMs + i * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        }));
        mockLichessOnce(games);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        await runIngest(dal);

        const acctKey = getAccountKey('lichess', 'me');
        const state = dal.data.games![acctKey];
        expect(state.recentIds).toHaveLength(50);
        // Top of list is the most recent (last-numbered) game
        expect(state.recentIds[0]).toEqual({ id: 'g054', ts: baseMs + 54 * 1000 });
        // Watermark should be the last game's createdAt
        expect(state.watermarkMs).toBe(baseMs + 54 * 1000);
    });

    it('on 412 conflict, ingest fails silently without retry (modal-reload owns recovery)', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        const game = lichessGame({
            id: 'g10',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);

        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
        const dal = new MockDal(data);
        dal.nextStoreError = new DataAccessError('precondition failed', 412);

        // On 412 the app-root <ConflictModal> owns recovery (via SessionStore's
        // notifyConflict, fired before the error is rethrown). runIngest must
        // therefore stay silent: no console.error telemetry, and — critically
        // — no trailing `done` progress emit, since Dashboard's handler would
        // flip syncStatus to "synced" and flash a green badge under the modal.
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const events: IngestProgress[] = [];
            const result = await runIngest(dal, (p) => events.push(p));
            // 412 is swallowed by runIngest's top-level catch; reports a no-op.
            expect(result.didWrite).toBe(false);
            expect(result.gamesProcessed).toBe(0);
            expect(dal.storeCount).toBe(1); // single attempt, no retry
            // No "GameIngest: failed" telemetry on the 412 path.
            expect(errSpy).not.toHaveBeenCalled();
            // The pipeline still emits its `fetching` events (the PUT only
            // fails at the end), but the trailing `done` is suppressed.
            expect(events.find(p => p.phase === 'done')).toBeUndefined();
            expect(events.some(p => p.phase === 'fetching')).toBe(true);
        } finally {
            errSpy.mockRestore();
        }
    });

    it('handles black orientation correctly', async () => {
        // Black repertoire: against 1. e4 we play 1...c5 (Sicilian first move)
        const variant = makeVariant('1. e4 c5', 'black');
        const data = makeData([variant]);

        const game = lichessGame({
            id: 'b1',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: false,
            moves: 'e4 c5',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(true);
        const entry = dal.data.activity!.practiceLog.find(e => e.games);
        expect(entry!.games!.ingested).toBe(1);
        expect(entry!.games!.reviewed).toBe(1); // 1...c5 in-repertoire user move
    });

    it('skips rating Good if card was already reviewed more recently than the game', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        // Mark the e4 card with a last_review AFTER the game's createdAt
        const startFen = new Chess().fen();
        const normStartFen = normalizeFenResetHalfmoveClock(startFen);
        const e4Key = FSRSService.makeCardKey(normStartFen, 'e4');

        const gameCreatedAt = FAKE_NOW.getTime() - 24 * 60 * 60 * 1000;
        const lastReviewMs = gameCreatedAt + 60 * 60 * 1000; // 1h after the game
        data.fsrsCards![e4Key] = {
            ...data.fsrsCards![e4Key],
            lastReview: new Date(lastReviewMs).toISOString(),
            reps: 1,
        };
        const e4ReviewedBeforeIngest = data.fsrsCards![e4Key].reps;

        const game = lichessGame({
            id: 'g11',
            createdAt: gameCreatedAt,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        await runIngest(dal);

        // e4 should be unchanged (skipped). Nf3 should have been rated.
        const sim = new Chess(); sim.move('e4'); sim.move('e5');
        const nf3Key = FSRSService.makeCardKey(normalizeFenResetHalfmoveClock(sim.fen()), 'Nf3');
        const savedCards = extractFsrsCardsFromRepertoires(dal.data.repertoires!);
        expect(savedCards[e4Key].reps).toBe(e4ReviewedBeforeIngest);
        expect(savedCards[nf3Key].reps).toBeGreaterThan(0);
    });

    it('attributes counters to the date in local timezone', async () => {
        // Game at exactly noon UTC should land on today's date.
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        const game = lichessGame({
            id: 'g12',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        await runIngest(dal);

        const entry = dal.data.activity!.practiceLog.find(e => e.games);
        expect(entry).toBeDefined();
        // The exact date depends on local TZ — sanity-check that it's set
        expect(entry!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('does not write when fetch returns no eligible games and no cursor changes', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        mockLichessOnce([]); // empty
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
        expect(dal.storeCount).toBe(0);
    });

    it('does not throw when fetch fails — silently skips that account', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);

        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false);
    });

    it('processes games in createdAt ASC order across accounts', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        // Two accounts, with games interleaved in time
        const t1 = FAKE_NOW.getTime() - 3 * 60 * 60 * 1000;
        const t2 = FAKE_NOW.getTime() - 2 * 60 * 60 * 1000;
        const t3 = FAKE_NOW.getTime() - 1 * 60 * 60 * 1000;

        const game1 = lichessGame({ id: 'a1', createdAt: t1, userIsWhite: true, moves: 'e4 e5 Nf3' });
        const game2 = lichessGame({ id: 'a2', createdAt: t3, userIsWhite: true, moves: 'e4 e5 Nf3' });
        const game3 = lichessGame({ id: 'b1', createdAt: t2, userIsWhite: true, moves: 'e4 e5 Nf3' });

        // First lichess fetch (alice), second lichess fetch (bob)
        mockLichessOnce([game1, game2]);
        mockLichessOnce([game3]);

        setAccounts(data, [
            { platform: 'lichess', username: 'alice' },
            { platform: 'lichess', username: 'bob' },
        ]);
        const dal = new MockDal(data);
        await runIngest(dal);

        // Verify each account's watermark
        const aliceState = dal.data.games![getAccountKey('lichess', 'alice')];
        const bobState = dal.data.games![getAccountKey('lichess', 'bob')];
        expect(aliceState.watermarkMs).toBe(t3); // alice's latest
        expect(bobState.watermarkMs).toBe(t2);   // bob's only game
    });

    it('preserves existing chess.com providerCursor on 304', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        const acctKey = getAccountKey('chess.com', 'me');
        data.games = {
            [acctKey]: {
                watermarkMs: 0,
                recentIds: [],
                providerCursor: { month: '2026-05', etag: 'prev-etag' },
            },
        };

        // Mock 304 Not Modified
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: false,
            status: 304,
            statusText: 'Not Modified',
            headers: new Headers(),
            text: async () => '',
            json: async () => ({}),
        } as unknown as Response);

        setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(false); // No cursor change, no eligible games

        // State should be unchanged
        expect(dal.data.games![acctKey].providerCursor).toEqual({ month: '2026-05', etag: 'prev-etag' });
    });

    it('updates chess.com providerCursor when ETag changes', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        const acctKey = getAccountKey('chess.com', 'me');
        data.games = {
            [acctKey]: {
                watermarkMs: 0,
                recentIds: [],
                providerCursor: { month: '2026-05', etag: 'old-etag' },
            },
        };

        // Mock 200 with a new ETag and one new game
        const chesscomGameData = buildChesscomGame({
            uuid: 'cc-1',
            endTimeSec: Math.floor((FAKE_NOW.getTime() - 60 * 60 * 1000) / 1000),
            userIsWhite: true,
            moves: '1. e4 e5 2. Nf3',
        });
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'ETag': 'new-etag' }),
            text: async () => '',
            json: async () => ({ games: [chesscomGameData] }),
        } as unknown as Response);

        setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
        const dal = new MockDal(data);
        const result = await runIngest(dal);
        expect(result.didWrite).toBe(true);
        expect(dal.data.games![acctKey].providerCursor!.etag).toBe('new-etag');
    });

    // ── Progress callback ─────────────────────────────────────────────

    it('emits no progress events when there are no linked accounts', async () => {
        const data = makeData();
        const dal = new MockDal(data);
        const events: IngestProgress[] = [];
        await runIngest(dal, (p) => events.push(p));
        expect(events).toEqual([]);
    });

    it('emits a fetching event per linked account then a single done with gamesProcessed', async () => {
        // White repertoire: 1. e4 e5 2. Nf3
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        // Two linked accounts: one lichess (1 in-window game), one chess.com (1 in-window game)
        const lichessGameData = lichessGame({
            id: 'g-li',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([lichessGameData]);

        const chesscomGameData = buildChesscomGame({
            uuid: 'g-cc',
            endTimeSec: Math.floor((FAKE_NOW.getTime() - 30 * 60 * 1000) / 1000),
            userIsWhite: true,
            moves: '1. e4 e5 2. Nf3',
        });
        mockChesscomFirstRun([{ label: '2026-05', games: [chesscomGameData], etag: 'cc-etag' }]);

        setAccounts(data, [
            { platform: 'lichess', username: 'me' },
            { platform: 'chess.com', username: 'me' },
        ]);
        const dal = new MockDal(data);

        const events: IngestProgress[] = [];
        const result = await runIngest(dal, (p) => events.push(p));

        expect(result.didWrite).toBe(true);
        expect(result.gamesProcessed).toBe(2);

        // Exactly 3 events: 2 fetching (one per account, in order) + 1 done.
        expect(events.length).toBe(3);
        expect(events[0]).toEqual({
            phase: 'fetching',
            accountIndex: 1,
            accountTotal: 2,
            platform: 'lichess',
            username: 'me',
        });
        expect(events[1]).toEqual({
            phase: 'fetching',
            accountIndex: 2,
            accountTotal: 2,
            platform: 'chess.com',
            username: 'me',
        });
        expect(events[2]).toEqual({ phase: 'done', gamesProcessed: 2 });
    });

    it('emits done with gamesProcessed=0 when fetches succeed but nothing is in window', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        // Pre-existing watermark ahead of any returned games — nothing eligible.
        const acctKey = getAccountKey('lichess', 'me');
        data.games = { [acctKey]: { watermarkMs: FAKE_NOW.getTime(), recentIds: [] } };

        // Return a game older than the watermark.
        mockLichessOnce([lichessGame({
            id: 'old',
            createdAt: FAKE_NOW.getTime() - 24 * 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        })]);

        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
        const dal = new MockDal(data);

        const events: IngestProgress[] = [];
        const result = await runIngest(dal, (p) => events.push(p));

        expect(result.didWrite).toBe(false);
        expect(events.length).toBe(2);
        expect(events[0].phase).toBe('fetching');
        expect(events[1]).toEqual({ phase: 'done', gamesProcessed: 0 });
    });

    describe('FSRS audit integration', () => {
        // End-to-end coverage of the audit wiring through real game ingest.
        // Bootstraps the card into Review state, turns on tracking (as the
        // FSRS card list page would), then deviates to provoke a real recall
        // failure that must be appended to the tracked card's event log.
        it('appends a deviation Again on a tracked Review-state card with source `ingest`', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5', 'white');
            const data = makeData([variant]);
            const positionChess = new Chess();
            positionChess.move('e4'); positionChess.move('e5');
            const fenAfterE5 = normalizeFenResetHalfmoveClock(positionChess.fen());
            const nf3Key = FSRSService.makeCardKey(fenAfterE5, 'Nf3');

            // Bootstrap: advance the Nf3 card to Review state. Two Goods on
            // separate days take a New card through Learning → Review with
            // the short-term scheduler. We mutate data.fsrsCards directly
            // (no prepareDataForSave) so the MockDal clones a blob with the
            // bootstrapped flat map intact — the wire shape strips
            // fsrsCards, so going through prepareDataForSave first would
            // lose the bootstrap state.
            const fsrs1 = new FSRSService(data.fsrsCards!);
            fsrs1.rateCard(fenAfterE5, 'Nf3', true, new Date(FAKE_NOW.getTime() - 30 * 24 * 60 * 60 * 1000));
            fsrs1.rateCard(fenAfterE5, 'Nf3', true, new Date(FAKE_NOW.getTime() - 25 * 24 * 60 * 60 * 1000));
            expect(data.fsrsCards![nf3Key].state).toBe(2 /* Review */);

            // Turn on tracking for the Nf3 card before ingest. Ingest reuses
            // the same `data.audit` reference, so its AuditService sees this
            // tracked entry and appends events for it.
            data.audit = [];
            const tracked = new AuditService(data.audit).track(nf3Key, data.fsrsCards![nf3Key]);
            expect(tracked).toBe(true);

            // Now ingest a game that deviates at move 2 — user plays d4 instead of Nf3
            const game = lichessGame({
                id: 'g-audit',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 d4',
            });
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);

            // The tracked entry now carries the ingest deviation event.
            expect(dal.data.audit).toBeDefined();
            expect(dal.data.audit).toHaveLength(1);
            const entry = dal.data.audit![0];
            expect(entry.k).toBe(nf3Key);
            expect(entry.events).toHaveLength(1);
            expect(entry.events[0].s).toBe('ingest');
            expect(entry.events[0].r).toBe(1 /* Again */);
            // before is packed; element 8 is `state` and must be Review (=2).
            expect(entry.before[8]).toBe(2);
        });

        it('does NOT auto-create an audit entry for an untracked card on ingest deviation', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3 Nc6 3. Bb5', 'white');
            const data = makeData([variant]);
            const positionChess = new Chess();
            positionChess.move('e4'); positionChess.move('e5');
            const fenAfterE5 = normalizeFenResetHalfmoveClock(positionChess.fen());
            const nf3Key = FSRSService.makeCardKey(fenAfterE5, 'Nf3');

            const fsrs1 = new FSRSService(data.fsrsCards!);
            fsrs1.rateCard(fenAfterE5, 'Nf3', true, new Date(FAKE_NOW.getTime() - 30 * 24 * 60 * 60 * 1000));
            fsrs1.rateCard(fenAfterE5, 'Nf3', true, new Date(FAKE_NOW.getTime() - 25 * 24 * 60 * 60 * 1000));
            expect(data.fsrsCards![nf3Key].state).toBe(2 /* Review */);

            const game = lichessGame({
                id: 'g-audit-untracked',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 d4',
            });
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);

            // No tracking was set up → audit stays empty (no auto-capture).
            expect(dal.data.audit ?? []).toHaveLength(0);
        });
    });

    describe('game-record capture', () => {
        it('appends a GameRecord to the per-day games.records', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            const game = lichessGame({
                id: 'rec1',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);

            const entry = dal.data.activity!.practiceLog.find(e => e.games);
            expect(entry).toBeDefined();
            expect(entry!.games!.records).toBeDefined();
            expect(entry!.games!.records!.length).toBe(1);
            const rec = entry!.games!.records![0];
            expect(rec.id).toBe('rec1');
            expect(rec.p).toBe('l');
            expect(rec.t).toBe(game.createdAt);
            expect(rec.m).toBe('e4 e5 Nf3');
        });

        it('preserves provider casing on wa/ba in the persisted record', async () => {
            const variant = makeVariant('1. e4 e5', 'white');
            const data = makeData([variant]);
            const game = lichessGame({
                id: 'rec-casing',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5',
            });
            // Override the players to use mixed-case display names. The `id`
            // field is the lichess-canonical lowercase form.
            game.players = {
                white: { user: { id: 'me', name: 'Me' } },
                black: { user: { id: 'opp', name: 'DrNykterstein' } },
            };
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);
            const rec = dal.data.activity!.practiceLog[0].games!.records![0];
            expect(rec.wa).toBe('Me');
            expect(rec.ba).toBe('DrNykterstein');
        });

        it('extracts the opening name from a Chess.com ECOUrl before stripping the PGN', async () => {
            const variant = makeVariant('1. e4 c5', 'white');
            const data = makeData([variant]);
            const game = buildChesscomGame({
                uuid: 'cc-rec1',
                endTimeSec: Math.floor((FAKE_NOW.getTime() - 60 * 60 * 1000) / 1000),
                userIsWhite: true,
                moves: '1. e4 c5',
            });
            // Splice an ECOUrl header into the PGN.
            game.pgn = (game.pgn as string).replace(
                '[Result "*"]',
                '[Result "*"]\n[ECOUrl "https://www.chess.com/openings/Sicilian-Defense"]',
            );
            mockChesscomFirstRun([{ label: '2026-05', games: [game] }]);
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);
            const rec = dal.data.activity!.practiceLog[0].games!.records![0];
            expect(rec.o).toBe('Sicilian Defense');
            // m is the SAN-only form.
            expect(rec.m.startsWith('e4 c5')).toBe(true);
        });

        it('captures per-ply evals (with null sentinels) for Lichess games', async () => {
            const variant = makeVariant('1. e4 e5', 'white');
            const data = makeData([variant]);
            const game = lichessGame({
                id: 'rec-ev',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            game.analysis = [
                { eval: 20 },
                {},          // missing → null
                { mate: 3 }, // mate → MATE_CP
            ];
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);
            // The fetch must request server evals or `analysis` never arrives.
            const fetchedUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(fetchedUrl).toContain('evals=true');
            const rec = dal.data.activity!.practiceLog[0].games!.records![0];
            expect(rec.ev).toEqual([20, null, 10_000]);
        });

        it('requests the opening block on bulk Lichess fetches and stores the name', async () => {
            const variant = makeVariant('1. e4 e5', 'white');
            const data = makeData([variant]);
            const game = lichessGame({
                id: 'rec-op',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3 Nc6',
            });
            // The bulk endpoint returns `opening` only when `opening=true` is on
            // the URL — without that flag the freshly-ingested record would land
            // with `o` undefined and the /games row would show no opening name
            // until the user hit Re-annotate.
            game.opening = { name: "King's Knight Opening", eco: 'C40', ply: 3 };
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);
            const fetchedUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(fetchedUrl).toContain('opening=true');
            const rec = dal.data.activity!.practiceLog[0].games!.records![0];
            expect(rec.o).toBe("King's Knight Opening");
        });

        it('does not populate ev on Chess.com records', async () => {
            const variant = makeVariant('1. e4 e5', 'white');
            const data = makeData([variant]);
            const game = buildChesscomGame({
                uuid: 'cc-no-ev',
                endTimeSec: Math.floor((FAKE_NOW.getTime() - 60 * 60 * 1000) / 1000),
                userIsWhite: true,
                moves: '1. e4 e5',
            });
            mockChesscomFirstRun([{ label: '2026-05', games: [game] }]);
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);
            const rec = dal.data.activity!.practiceLog[0].games!.records![0];
            expect(rec.ev).toBeUndefined();
            expect(rec.p).toBe('c');
        });

        it('applies the 100-record eviction (oldest-day whole)', async () => {
            const variant = makeVariant('1. e4 e5', 'white');
            const data = makeData([variant]);
            // Pre-seed activity with 100 records on a "yesterday" date so any
            // newly-ingested game today pushes us over the cap and evicts the
            // older day whole.
            const yesterday = new Date(FAKE_NOW.getTime() - 24 * 60 * 60 * 1000);
            const yyyy = yesterday.getFullYear();
            const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
            const dd = String(yesterday.getDate()).padStart(2, '0');
            const dateStr = `${yyyy}-${mm}-${dd}`;
            const existingRecords = Array.from({ length: 100 }, (_, i) => ({
                id: `old${i}`,
                p: 'l' as const,
                t: yesterday.getTime() + i * 1000,
                m: 'e4 e5',
                wa: 'me',
                ba: 'opp',
                res: 'draw' as const,
                rt: 1 as const,
            }));
            data.activity!.practiceLog.push({
                date: dateStr,
                reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0,
                games: { ingested: 100, reviewed: 0, mistakes: 0, records: existingRecords },
            });

            const newGame = lichessGame({
                id: 'newToday',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([newGame]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);

            // Oldest day's records should be wiped; counters preserved.
            const oldDay = dal.data.activity!.practiceLog.find(e => e.date === dateStr)!;
            expect(oldDay.games!.records!.length).toBe(0);
            expect(oldDay.games!.ingested).toBe(100); // counter preserved

            // Today should have the new record.
            const todayDay = dal.data.activity!.practiceLog.find(e => e.date !== dateStr)!;
            expect(todayDay.games!.records!.length).toBe(1);
            expect(todayDay.games!.records![0].id).toBe('newToday');
        });
    });

    describe('first-run backfill', () => {
        it('backfills a game older than 5 days on first run (within the newest N)', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            // No pre-existing account state → first run. A 6-day-old game would be
            // filtered by the steady-state age window, but first-run keeps it
            // because it's among the newest FIRST_RUN_MIN_GAMES.
            const game = lichessGame({
                id: 'old1',
                createdAt: FAKE_NOW.getTime() - 6 * 24 * 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.didWrite).toBe(true);
            expect(result.gamesProcessed).toBe(1);
        });

        it('caps the first-run backfill at FIRST_RUN_MIN_GAMES when all games predate the window', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            // 60 games, all older than the 5-day window (6..65 days ago). First
            // run should keep only the newest 50 (the count floor).
            const games = Array.from({ length: 60 }, (_, i) => lichessGame({
                id: `g${String(i).padStart(3, '0')}`,
                createdAt: FAKE_NOW.getTime() - (6 + i) * 24 * 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            }));
            mockLichessOnce(games);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.gamesProcessed).toBe(50);
            // Watermark is the newest game (g000, 6 days ago); the oldest games
            // beyond the 50-game floor are never processed.
            const acctKey = getAccountKey('lichess', 'me');
            expect(dal.data.games![acctKey].watermarkMs).toBe(games[0].createdAt);
        });

        it('keeps every in-window game on first run even beyond the count floor', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            // 55 games all inside the 5-day window: the union(window, newest 50)
            // keeps all 55, not just the newest 50.
            const baseMs = FAKE_NOW.getTime() - 24 * 60 * 60 * 1000;
            const games = Array.from({ length: 55 }, (_, i) => lichessGame({
                id: `w${String(i).padStart(3, '0')}`,
                createdAt: baseMs + i * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            }));
            mockLichessOnce(games);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.gamesProcessed).toBe(55);
        });

        it('uses dateDesc without `since` on first run, then dateAsc + `since` once state exists', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            const game = lichessGame({
                id: 'fr1',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([game]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            await runIngest(dal);

            const firstUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(firstUrl).toContain('sort=dateDesc');
            expect(firstUrl).not.toContain('since=');

            // Second run: state now exists → incremental steady-state query.
            const game2 = lichessGame({
                id: 'fr2',
                createdAt: FAKE_NOW.getTime() - 30 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([game2]);
            await runIngest(dal);
            const secondUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
            expect(secondUrl).toContain('sort=dateAsc');
            expect(secondUrl).toContain('since=');
        });

        it('walks the Chess.com archives index to backfill older months on first run', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            const recentGame = buildChesscomGame({
                uuid: 'cc-recent',
                endTimeSec: Math.floor((FAKE_NOW.getTime() - 60 * 60 * 1000) / 1000),
                userIsWhite: true,
                moves: '1. e4 e5 2. Nf3',
            });
            const oldGame = buildChesscomGame({
                uuid: 'cc-old',
                endTimeSec: Math.floor((FAKE_NOW.getTime() - 80 * 24 * 60 * 60 * 1000) / 1000),
                userIsWhite: true,
                moves: '1. e4 e5 2. Nf3',
            });
            // Two months in the index; the older month is outside the 5-day
            // window but is still backfilled (within the count floor).
            mockChesscomFirstRun([
                { label: '2026-03', games: [oldGame] },
                { label: '2026-05', games: [recentGame], etag: 'cc-etag' },
            ]);
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.gamesProcessed).toBe(2);
            // Cursor seeded from the current month for the next steady-state run.
            const acctKey = getAccountKey('chess.com', 'me');
            expect(dal.data.games![acctKey].providerCursor).toEqual({ month: '2026-05', etag: 'cc-etag' });
        });

        it('does NOT replay out-of-window backfilled games into FSRS (display/heatmap only)', async () => {
            // Established user with a repertoire (so processGame *would* rate
            // in-repertoire moves). On first run, only the in-window game should
            // feed FSRS; the 6-day-old backfilled game is recorded but not rated.
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            const oldGame = lichessGame({
                id: 'old',
                createdAt: FAKE_NOW.getTime() - 6 * 24 * 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            const recentGame = lichessGame({
                id: 'recent',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([oldGame, recentGame]);
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);

            // Both games are backfilled (display + activity)…
            expect(result.gamesProcessed).toBe(2);
            const entries = dal.data.activity!.practiceLog.filter(e => e.games);
            const ingestedSum = entries.reduce((s, e) => s + (e.games!.ingested ?? 0), 0);
            expect(ingestedSum).toBe(2);
            // …but only the in-window game (e4 + Nf3) produced FSRS reviews.
            const reviewedSum = entries.reduce((s, e) => s + (e.games!.reviewed ?? 0), 0);
            expect(reviewedSum).toBe(2);
        });

        it('does not persist state for an account whose first-run fetch fails (backfill retried next run)', async () => {
            // Account A (lichess) succeeds and triggers the persist; account B
            // (chess.com) fails its first-run fetch. B must be left state-less so
            // its one-time backfill is retried, not silently downgraded.
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            const okGame = lichessGame({
                id: 'ok1',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([okGame]);
            // chess.com first run: index ok, but the month archive 500s → the
            // whole account fetch throws → fetchSucceeded === false.
            mockChesscomArchiveIndex(['2026-05']);
            mockFetchOnce({ ok: false, status: 500 });
            setAccounts(data, [
                { platform: 'lichess', username: 'me' },
                { platform: 'chess.com', username: 'me' },
            ]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);

            expect(result.didWrite).toBe(true);
            expect(dal.data.games![getAccountKey('lichess', 'me')]).toBeDefined();
            expect(dal.data.games![getAccountKey('chess.com', 'me')]).toBeUndefined();
        });

        it('caps the Chess.com first-run walk at FIRST_RUN_MAX_ARCHIVES months', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            // 8 months in the index, one game each (well under the 50-game floor,
            // so the walk never early-stops). Only the newest 6 may be fetched.
            const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
            const monthFixtures = months.map((label, i) => ({
                label,
                games: [buildChesscomGame({
                    uuid: `cc-${label}`,
                    endTimeSec: Math.floor((FAKE_NOW.getTime() - (5 + i) * 24 * 60 * 60 * 1000) / 1000),
                    userIsWhite: true,
                    moves: '1. e4 e5 2. Nf3',
                })],
            }));
            mockChesscomFirstRun(monthFixtures);
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);

            // 1 index fetch + 6 month fetches (the 2 oldest months are skipped).
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(7);
            expect(result.gamesProcessed).toBe(6);
        });

        it('stops the Chess.com walk early once the count floor and window are covered', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            // Newest month already supplies >= FIRST_RUN_MIN_GAMES in-window
            // games; an older month exists but must NOT be fetched (break fired).
            const recentGames = Array.from({ length: 50 }, (_, i) => buildChesscomGame({
                uuid: `cc-r${i}`,
                endTimeSec: Math.floor((FAKE_NOW.getTime() - (i + 1) * 60 * 1000) / 1000),
                userIsWhite: true,
                moves: '1. e4 e5 2. Nf3',
            }));
            mockChesscomFirstRun([
                { label: '2026-02', games: [buildChesscomGame({
                    uuid: 'cc-older',
                    endTimeSec: Math.floor((FAKE_NOW.getTime() - 100 * 24 * 60 * 60 * 1000) / 1000),
                    userIsWhite: true,
                    moves: '1. e4 e5 2. Nf3',
                })] },
                { label: '2026-05', games: recentGames },
            ]);
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);

            // 1 index + 1 month (2026-05) only — 2026-02 never fetched.
            expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
            expect(result.gamesProcessed).toBe(50);
        });

        it('treats a 404 Chess.com archives index as no games (no crash, no state churn)', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            mockChesscomArchiveIndex([], false); // index 404 → definitive "no archives"
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.didWrite).toBe(false);
            expect(result.gamesProcessed).toBe(0);
        });

        it('retries the first run (no state persisted) when the archives index fails transiently', async () => {
            // A 5xx on the archives index must NOT degrade to a current-month-only
            // fetch that consumes the one-time backfill — the account fetch fails
            // so it stays state-less and is retried next run.
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            const okGame = lichessGame({
                id: 'ok2',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            mockLichessOnce([okGame]); // a second account persists, exposing the gap
            mockFetchOnce({ ok: false, status: 503 }); // chess.com archives index 5xx
            setAccounts(data, [
                { platform: 'lichess', username: 'me' },
                { platform: 'chess.com', username: 'me' },
            ]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.didWrite).toBe(true);
            expect(dal.data.games![getAccountKey('chess.com', 'me')]).toBeUndefined();
        });

        it('skips a 404 month mid-walk and keeps ingesting older months', async () => {
            const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
            const data = makeData([variant]);
            mockChesscomArchiveIndex(['2026-03', '2026-05']);
            mockFetchOnce({ ok: false, status: 404 }); // 2026-05 archive missing
            const oldGame = buildChesscomGame({
                uuid: 'cc-mar',
                endTimeSec: Math.floor((FAKE_NOW.getTime() - 80 * 24 * 60 * 60 * 1000) / 1000),
                userIsWhite: true,
                moves: '1. e4 e5 2. Nf3',
            });
            mockFetchOnce({ json: { games: [oldGame] } }); // 2026-03 archive
            setAccounts(data, [{ platform: 'chess.com', username: 'me' }]);
            const dal = new MockDal(data);
            const result = await runIngest(dal);
            expect(result.gamesProcessed).toBe(1);
        });
    });

    describe('AbortSignal', () => {
        it('throws AbortError when signal is pre-aborted before the first retrieve', async () => {
            const data = makeData();
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const controller = new AbortController();
            controller.abort();
            await expect(runIngest(dal, undefined, controller.signal))
                .rejects.toMatchObject({ name: 'AbortError' });
            expect(dal.storeCount).toBe(0);
        });

        it('does not call PUT after abort fires between fetch and PUT', async () => {
            const data = makeData();
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const controller = new AbortController();
            // Mock the lichess GET so it succeeds, then abort right
            // after the fetch returns but before the PUT fires.
            const game = lichessGame({
                id: 'newGame',
                createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
                userIsWhite: true,
                moves: 'e4 e5 Nf3',
            });
            (globalThis.fetch as ReturnType<typeof vi.fn>)
                .mockImplementationOnce(async () => {
                    controller.abort();
                    return {
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        headers: new Headers(),
                        text: async () => buildLichessGameNdjson([game]),
                        json: async () => ({}),
                    } as unknown as Response;
                });
            await expect(runIngest(dal, undefined, controller.signal))
                .rejects.toMatchObject({ name: 'AbortError' });
            expect(dal.storeCount).toBe(0);
        });

        it('skips emitting the done progress event when aborted', async () => {
            const data = makeData();
            setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
            const dal = new MockDal(data);
            const controller = new AbortController();
            controller.abort();
            const progresses: any[] = [];
            try {
                await runIngest(dal, p => progresses.push(p), controller.signal);
            } catch { /* abort propagation */ }
            expect(progresses.find(p => p.phase === 'done')).toBeUndefined();
        });
    });
});

function buildChesscomGame(opts: {
    uuid: string;
    endTimeSec: number;
    userIsWhite: boolean;
    moves: string;            // PGN moves text, e.g. "1. e4 e5 2. Nf3"
    rated?: boolean;
    time_class?: string;
    rules?: string;
}): Record<string, unknown> {
    const pgn = `[Event "Live Chess"]\n[White "${opts.userIsWhite ? 'me' : 'opp'}"]\n[Black "${opts.userIsWhite ? 'opp' : 'me'}"]\n[Result "*"]\n\n${opts.moves} *`;
    return {
        url: 'https://chess.com/game/123',
        pgn,
        time_control: '180+0',
        end_time: opts.endTimeSec,
        rated: opts.rated ?? true,
        time_class: opts.time_class ?? 'blitz',
        rules: opts.rules ?? 'chess',
        uuid: opts.uuid,
        white: { username: opts.userIsWhite ? 'me' : 'opp', rating: 1500, result: 'win' },
        black: { username: opts.userIsWhite ? 'opp' : 'me', rating: 1500, result: 'lose' },
    };
}
