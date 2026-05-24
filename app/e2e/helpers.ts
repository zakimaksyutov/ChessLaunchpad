import { type Page } from '@playwright/test';

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
      errorEMA: 0,
      numberOfTimesPlayed: 0,
      lastSucceededEpoch: 0,
      successEMA: 0,
    })),
    currentEpoch: 1,
    lastPlayedDate: new Date().toISOString(),
    dailyPlayCount: 0,
    weightSettings: {
      recencyPower: 1,
      frequencyPower: 2,
      errorPower: 2,
    },
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
      // Return the most recently saved data if available, otherwise the fixture.
      const latestBody = saves.length > 0 ? saves[saves.length - 1].body : fixture;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { ETag: `"test-etag-${saves.length + 1}"` },
        body: JSON.stringify(latestBody),
      });
    }
    // PUT (save) — capture the body, then accept
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      if (body) saves.push({ body });
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
