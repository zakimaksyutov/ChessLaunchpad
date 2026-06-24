import { type Page } from '@playwright/test';
import {
    encodePersistedBlob,
    decodePersistedBlob,
    type PersistedBlobV3,
} from '../src/utils/BlobCodec';
import { extractFsrsCardsFromRepertoires } from '../src/utils/RepertoiresSerde';
import { type RepertoireData } from '../src/models/RepertoireData';
import { type FSRSCardData } from '../src/models/FSRSCardData';
import { pgnToRepertoires } from '../src/test-utils/repertoireBuilders';

const API_BASE = 'https://chess-prod-function.azurewebsites.net/api/user';

export interface VariantDef {
  pgn: string;
  orientation: 'white' | 'black';
}

/**
 * Build a v3-encoded RepertoireData payload matching the backend contract.
 *
 * Tests express their fixtures as PGN strings (the natural notation for an
 * opening line); this helper materializes them into the position-centric
 * v3 wire shape that `decodePersistedBlob` accepts in the app's read path.
 *
 * `seedCards` lets a test pre-rate user-turn moves (keyed by `<fen>::<san>`).
 * Cards are inlined onto the matching `moves[san].card` before the BFS
 * encode, so they survive the v3 round-trip and the app sees them as
 * already-rated. Cards whose key doesn't correspond to a user-turn edge
 * in any constructed repertoire are silently dropped — same semantics as
 * the production reconciliation.
 *
 * The app's normalize() (which runs in the browser after fetch) will
 * synthesize New-state cards for user-turn edges that have none.
 */
export function buildRepertoireData(
  variants: VariantDef[],
  seedCards: Record<string, FSRSCardData> = {},
): PersistedBlobV3 {
  const repertoires = pgnToRepertoires(variants, seedCards);
  const inMemory: RepertoireData = {
    repertoires,
    settings: {
      contextDepth: 2,
      retention: 0.97,
      maxInterval: 90,
    },
  };
  return encodePersistedBlob(inMemory);
}

/**
 * Captured PUT requests made by the app to save repertoire data.
 *
 * Since switching the wire format to v3 (positions as a deterministic-BFS
 * array with `"<SAN>:<idx>"` move keys, packed FSRS cards), the raw PUT
 * body no longer has a top-level `fsrsCards` flat map and its `positions`
 * are arrays. To keep the existing test assertion style
 * (`saved.fsrsCards[<fen>::<san>]`, `saved.repertoires[0].positions[<fen>]`)
 * working, the helper exposes a **decoded** view as `body`:
 *
 *   - `body.repertoires` — full-FEN keys, object-shaped cards (in-memory shape)
 *   - `body.fsrsCards`   — flat map hydrated from the position dict
 *
 * Plus all the top-level fields (`settings`, `activity`, `games`).
 *
 * The raw wire body is kept internally and used to feed subsequent GETs so
 * the app's decode path is exercised on every read.
 */
export interface CapturedSave {
  body: Record<string, unknown>;
}

/**
 * Seed localStorage so ProtectedRoute lets us through,
 * and intercept all backend API calls with the provided fixture.
 *
 * Returns a `saves` array that accumulates every PUT request body
 * so tests can assert on what was persisted.
 *
 * Subsequent GET requests return the latest saved body (if any),
 * so re-navigating after a save reflects updated FSRS state.
 */
export async function setupMockEnvironment(
  page: Page,
  fixture: ReturnType<typeof buildRepertoireData>,
  username = 'testuser',
) {
  const saves: CapturedSave[] = [];
  // Raw wire bodies parallel to `saves`, used to feed subsequent GETs verbatim
  // so the app's v3 decode path is exercised on every read.
  const rawWireBodies: Record<string, unknown>[] = [];

  // Bypass auth check (ProtectedRoute reads localStorage)
  await page.addInitScript(
    ({ username }: { username: string }) => {
      localStorage.setItem('username', username);
      localStorage.setItem('hashedPassword', 'fake-hash');
    },
    { username },
  );

  // Mock API calls
  await page.route(`${API_BASE}/${username}/variants`, async (route, request) => {
    if (request.method() === 'GET') {
      // Return the most recently saved RAW wire body (v3) if available,
      // otherwise the fixture (already v3-encoded by `buildRepertoireData`).
      const latestBody = rawWireBodies.length > 0
        ? rawWireBodies[rawWireBodies.length - 1]
        : fixture;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          ETag: `"test-etag-${saves.length + 1}"`,
          // Expose ETag across origins so SessionStore can read it.
          'Access-Control-Expose-Headers': 'ETag',
        },
        body: JSON.stringify(latestBody),
      });
    }
    // PUT (save) — capture the body, then accept
    if (request.method() === 'PUT') {
      const wireBody = request.postDataJSON();
      if (wireBody) {
        rawWireBodies.push(wireBody);
        saves.push({ body: decodeWireForTests(wireBody) });
      }
      return route.fulfill({
        status: 200,
        headers: {
          ETag: `"test-etag-${saves.length + 1}"`,
          // Expose ETag across origins so SessionStore can read it.
          'Access-Control-Expose-Headers': 'ETag',
        },
      });
    }
    return route.continue();
  });

  return { saves };
}

/**
 * Decode a captured v3 wire body into the in-memory shape that tests assert
 * against, including a hydrated `fsrsCards` flat map.
 */
function decodeWireForTests(wireBody: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodePersistedBlob(wireBody) as RepertoireData;
  const fsrsCards = extractFsrsCardsFromRepertoires(decoded.repertoires ?? []);
  return { ...decoded, fsrsCards } as unknown as Record<string, unknown>;
}

/**
 * Advance the in-page clock by the given number of minutes.
 *
 * Uses `addInitScript` so the offset persists across `page.goto()`
 * navigations (which cause a full page reload even with HashRouter).
 */
export async function advanceTime(page: Page, minutes: number) {
  const offsetMs = minutes * 60 * 1000;
  await page.addInitScript((offset: number) => {
    const RealDate = globalThis.Date;
    const origNow = RealDate.now;
    globalThis.Date = class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(origNow.call(RealDate) + offset);
        else super(...(args as [any]));
      }
      static override now() { return origNow.call(RealDate) + offset; }
    } as DateConstructor;
    globalThis.Date.parse = RealDate.parse;
    globalThis.Date.UTC = RealDate.UTC;
  }, offsetMs);
}

// ── Lichess game-ingest mocks ────────────────────────────────────────

export interface LichessGameOpts {
  id: string;
  createdAtMs: number;
  userIsWhite: boolean;
  /** Space-separated SAN move list, e.g. "e4 e5 Nf3". */
  moves: string;
  /** Defaults to the lichess username being mocked. */
  username: string;
  rated?: boolean;
  speed?: 'blitz' | 'rapid';
}

/**
 * Build a single Lichess game object in the shape that GameIngestService's
 * Lichess parser expects (matches the production NDJSON format closely
 * enough for fetch + parse + userColor detection + PGN reconstruction).
 */
export function buildLichessGame(opts: LichessGameOpts): Record<string, unknown> {
  const me = opts.username.toLowerCase();
  const opp = 'lichess_opponent';
  return {
    id: opts.id,
    createdAt: opts.createdAtMs,
    rated: opts.rated ?? true,
    speed: opts.speed ?? 'blitz',
    variant: 'standard',
    players: {
      white: { user: { id: opts.userIsWhite ? me : opp, name: opts.userIsWhite ? me : opp } },
      black: { user: { id: opts.userIsWhite ? opp : me, name: opts.userIsWhite ? opp : me } },
    },
    moves: opts.moves,
  };
}

export interface LichessMock {
  /** Number of /api/games/user/... requests intercepted so far. */
  callCount: () => number;
  /**
   * Make the NEXT (and only the next) intercepted call return the given
   * games as NDJSON. Subsequent calls revert to returning empty NDJSON.
   * This lets the test control exactly which sync sees which games,
   * regardless of how many mount-time syncs StrictMode/effects trigger.
   */
  armNext: (games: Record<string, unknown>[]) => void;
}

/**
 * Intercept Lichess `/api/games/user/{username}` and return NDJSON.
 *
 * By default every call returns an empty NDJSON body (no games). Use
 * `armNext(games)` to make the next call return a specific batch.
 */
export async function setupMockLichess(
  page: Page,
  username: string,
): Promise<LichessMock> {
  let calls = 0;
  let armed: Record<string, unknown>[] | null = null;

  const usernameLower = username.toLowerCase();
  // Lichess fetcher hits https://lichess.org/api/games/user/{username}?...
  // Match anything pointing at this user's games endpoint.
  const urlRegex = new RegExp(
    `^https://lichess\\.org/api/games/user/${usernameLower}(\\?|$)`,
  );

  await page.route(urlRegex, async (route) => {
    calls += 1;
    const games = armed ?? [];
    armed = null;
    const ndjson = games.map(g => JSON.stringify(g)).join('\n');
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson,
    });
  });

  return {
    callCount: () => calls,
    armNext: (games) => { armed = games; },
  };
}

// ── Chess.com game-ingest mocks ──────────────────────────────────────

export interface ChesscomGameOpts {
  uuid: string;
  endTimeMs: number;
  userIsWhite: boolean;
  /** PGN movetext, e.g. "1. e4 e5 2. Nf3". */
  moves: string;
  /** Defaults to the chess.com username being mocked. */
  username: string;
  rated?: boolean;
  timeClass?: 'blitz' | 'rapid';
}

/**
 * Build a single Chess.com monthly-archive game object in the shape the
 * GameIngestService parser + GameRecordBuilder expect (PGN movetext +
 * white/black `username`, `end_time` in seconds).
 */
export function buildChesscomGame(opts: ChesscomGameOpts): Record<string, unknown> {
  const me = opts.username.toLowerCase();
  const opp = 'chesscom_opponent';
  const white = opts.userIsWhite ? me : opp;
  const black = opts.userIsWhite ? opp : me;
  const pgn = `[Event "Live Chess"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]\n\n${opts.moves} *`;
  return {
    url: `https://www.chess.com/game/live/${opts.uuid}`,
    pgn,
    time_control: '180+0',
    end_time: Math.floor(opts.endTimeMs / 1000),
    rated: opts.rated ?? true,
    time_class: opts.timeClass ?? 'blitz',
    rules: 'chess',
    uuid: opts.uuid,
    white: { username: white, rating: 1500, result: 'win' },
    black: { username: black, rating: 1500, result: 'lose' },
  };
}

export interface ChesscomMock {
  /** Number of `/games/archives` index requests intercepted so far. */
  indexCallCount: () => number;
  /** Number of monthly-archive requests intercepted so far. */
  monthCallCount: () => number;
  /**
   * Make the NEXT first-run fetch sequence (one `/archives` index read plus the
   * monthly-archive reads it triggers) serve the given games. The archives
   * index is derived from the months the games fall in. Once a sequence
   * consumes the arm, subsequent sequences see an empty index (no games),
   * mirroring `setupMockLichess.armNext`'s one-shot semantics so StrictMode's
   * mount-time double-sync doesn't double-count.
   */
  armNext: (games: Record<string, unknown>[]) => void;
}

function chesscomMonthLabel(game: Record<string, unknown>): string {
  const d = new Date((game.end_time as number) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Intercept the Chess.com first-run endpoints for `username`:
 *   - `GET /pub/player/{username}/games/archives` → `{ archives: [monthUrl…] }`
 *   - `GET /pub/player/{username}/games/{yyyy}/{mm}` → `{ games: [...] }`
 *
 * By default both return empty. `armNext(games)` arms the next first-run
 * sequence; the index is adopted (and the pending arm cleared) on the index
 * read, so the monthly reads of that same sequence still see the games while a
 * following sequence sees nothing. GameIngestService's in-process lock
 * serializes runs, so sequences never interleave.
 */
export async function setupMockChesscom(
  page: Page,
  username: string,
): Promise<ChesscomMock> {
  let indexCalls = 0;
  let monthCalls = 0;
  let armed: Record<string, unknown>[] | null = null;
  let active: Record<string, unknown>[] | null = null;

  const userLower = username.toLowerCase();
  const indexRegex = new RegExp(
    `^https://api\\.chess\\.com/pub/player/${userLower}/games/archives$`,
  );
  const monthRegex = new RegExp(
    `^https://api\\.chess\\.com/pub/player/${userLower}/games/(\\d{4})/(\\d{2})(\\?|$)`,
  );

  await page.route(indexRegex, async (route) => {
    indexCalls += 1;
    active = armed;
    armed = null;
    const labels = active
      ? [...new Set(active.map(chesscomMonthLabel))].sort()
      : [];
    const archives = labels.map((l) => {
      const [y, m] = l.split('-');
      return `https://api.chess.com/pub/player/${userLower}/games/${y}/${m}`;
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ archives }),
    });
  });

  await page.route(monthRegex, async (route) => {
    monthCalls += 1;
    const m = monthRegex.exec(route.request().url())!;
    const label = `${m[1]}-${m[2]}`;
    const games = (active ?? []).filter((g) => chesscomMonthLabel(g) === label);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { ETag: `"cc-${label}"`, 'Access-Control-Expose-Headers': 'ETag' },
      body: JSON.stringify({ games }),
    });
  });

  return {
    indexCallCount: () => indexCalls,
    monthCallCount: () => monthCalls,
    armNext: (games) => { armed = games; },
  };
}
