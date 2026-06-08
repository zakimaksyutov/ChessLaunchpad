import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Chess } from 'chess.js';
import { runIngest, IngestProgress } from './GameIngestService';
import { setLinkedAccounts, getAccountKey } from './LinkedAccountsService';
import { RepertoireData } from '../models/RepertoireData';
import { IDataAccessLayer, DataAccessError } from '../data/DataAccessLayer';
import { FSRSService } from './FSRSService';
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
    async fetchEtagOnly(): Promise<void> {
        this.retrieveCount += 1;
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

    it('filters out games older than 5 days', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);
        const game = lichessGame({
            id: 'g7',
            createdAt: FAKE_NOW.getTime() - 6 * 24 * 60 * 60 * 1000, // 6 days ago
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
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

    it('retries on 412 conflict and succeeds on retry', async () => {
        const variant = makeVariant('1. e4 e5 2. Nf3', 'white');
        const data = makeData([variant]);

        const game = lichessGame({
            id: 'g10',
            createdAt: FAKE_NOW.getTime() - 60 * 60 * 1000,
            userIsWhite: true,
            moves: 'e4 e5 Nf3',
        });
        mockLichessOnce([game]);
        mockLichessOnce([game]); // for the retry — pipeline refetches games too

        setAccounts(data, [{ platform: 'lichess', username: 'me' }]);
        const dal = new MockDal(data);
        dal.nextStoreError = new DataAccessError('precondition failed', 412);

        const result = await runIngest(dal);
        expect(result.didWrite).toBe(true);
        expect(dal.retrieveCount).toBeGreaterThanOrEqual(2);
        expect(dal.storeCount).toBe(2); // first try (412) + retry success
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
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'ETag': 'cc-etag' }),
            text: async () => '',
            json: async () => ({ games: [chesscomGameData] }),
        } as unknown as Response);

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
        // Bootstraps the card into Review state via direct FSRSService calls,
        // then deviates to provoke a real recall failure that must be recorded.
        it('records a deviation Again on a Review-state card with source `ingest`', async () => {
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

            // The persisted blob now has an audit entry for the Nf3 card
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
