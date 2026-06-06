import { type Page } from '@playwright/test';
import { decodePersistedBlob } from '../src/utils/BlobCodec';
import { extractFsrsCardsFromRepertoires } from '../src/utils/RepertoiresSerde';
import { type RepertoireData } from '../src/models/RepertoireData';

const API_BASE = 'https://chess-prod-function.azurewebsites.net/api/user';

export interface VariantDef {
  pgn: string;
  orientation: 'white' | 'black';
  classifications?: string[];
}

/**
 * Build a minimal RepertoireData payload matching the backend contract.
 *
 * The app's normalize() (which runs in the browser after fetch) will
 * reconcile FSRS cards, hydrate defaults, etc. — so we only need to
 * supply the variant list and sensible top-level defaults.
 */
export function buildRepertoireData(variants: VariantDef[]) {
  return {
    data: variants.map(v => ({
      pgn: v.pgn,
      orientation: v.orientation,
      classifications: v.classifications ?? [],
      numberOfTimesPlayed: 0,
      // V1 stubs — backend requires these as numbers
      errorEMA: 0,
      lastSucceededEpoch: 0,
      successEMA: 0,
    })),
    currentEpoch: 0,
    lastPlayedDate: new Date().toISOString(),
    dailyPlayCount: 0,
    fsrsCards: {},
    settings: {
      contextDepth: 2,
      retention: 0.97,
      maxInterval: 90,
    },
  };
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
 * Plus all the top-level fields (`currentEpoch`, `lastPlayedDate`,
 * `dailyPlayCount`, `settings`, `activity`, `games`).
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
      // otherwise the fixture (legacy v1 shape — passes through decode).
      const latestBody = rawWireBodies.length > 0
        ? rawWireBodies[rawWireBodies.length - 1]
        : fixture;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { ETag: `"test-etag-${saves.length + 1}"` },
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
        headers: { ETag: `"test-etag-${saves.length + 1}"` },
      });
    }
    return route.continue();
  });

  return { saves };
}

/**
 * Decode a captured v3 wire body into the in-memory shape that tests assert
 * against, including a hydrated `fsrsCards` flat map. v1 (no `v` field)
 * passes through unchanged.
 */
function decodeWireForTests(wireBody: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodePersistedBlob(wireBody) as RepertoireData;
  // For v1 pass-through, `decoded` may not have `repertoires` (legacy `data`
  // shape — no fsrsCards hydration needed; the test will see the raw shape).
  if (!decoded.repertoires) {
    return decoded as unknown as Record<string, unknown>;
  }
  const fsrsCards = extractFsrsCardsFromRepertoires(decoded.repertoires);
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
