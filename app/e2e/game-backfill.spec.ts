import { test, expect, type Page } from '@playwright/test';
import {
  buildRepertoireData,
  setupMockEnvironment,
  setupMockLichess,
  setupMockChesscom,
  buildLichessGame,
  buildChesscomGame,
  type CapturedSave,
} from './helpers';
import { getAccountKey } from '../src/services/LinkedAccountsService';
import { getDateStringForTimestamp } from '../src/services/ActivityService';

/**
 * First-run backfill (see docs/product-specs/GAME-INGEST.md §3): when a linked
 * account has no prior ingest state, the first sync seeds a starter set =
 * union(last 5 days, newest 50 games). The crux these tests pin down is that
 * games OLDER than the 5-day steady-state window are ingested on the first run
 * (they would be filtered in steady state) and surface in the activity feed.
 *
 * Both tests start from an empty repertoire so the backfill produces display +
 * activity records only (no FSRS replay), keeping the assertions focused on the
 * window-vs-count backfill behavior.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type SavedBlob = {
  games?: Record<string, { watermarkMs: number; recentIds: Array<{ id: string }> }>;
  activity?: {
    practiceLog: Array<{
      date: string;
      games?: { ingested: number; reviewed: number; mistakes: number; records?: Array<{ id: string }> };
    }>;
  };
};

/** Sum of `games.ingested` across every practice-log day. */
function totalIngested(blob: SavedBlob): number {
  return (blob.activity?.practiceLog ?? []).reduce(
    (sum, e) => sum + (e.games?.ingested ?? 0),
    0,
  );
}

/** The practice-log entry for a given timestamp's calendar day, if any. */
function dayEntry(blob: SavedBlob, ms: number) {
  const date = getDateStringForTimestamp(ms);
  return (blob.activity?.practiceLog ?? []).find(e => e.date === date);
}

/**
 * Mount the Dashboard, wait for the first (empty) auto-sync to settle, and
 * assert nothing was persisted yet — so the upcoming armed sync is the genuine
 * first run for the account.
 */
async function mountAndSettle(page: Page, saves: CapturedSave[]) {
  await page.goto('/#/');
  const syncIndicator = page.locator('.widget-sync-status');
  await expect(syncIndicator).toContainText(/Synced @/, { timeout: 10_000 });
  // Let any StrictMode-driven second mount-sync also complete (both empty).
  await page.waitForTimeout(500);
  expect(saves.length, 'no PUT on empty initial sync').toBe(0);
}

/** Click the manual ↻ Sync button and wait for exactly one PUT to land. */
async function clickSyncAndCapture(page: Page, saves: CapturedSave[]) {
  const syncButton = page.getByRole('button', { name: 'Sync games now' });
  await expect(syncButton).toBeEnabled();
  await syncButton.click();
  await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1);
}

test.describe('First-run game backfill', () => {
  test('Lichess: first sync backfills games older than 5 days and shows them in activity', async ({ page }) => {
    const USERNAME = 'testuser';

    const fixture = buildRepertoireData([]);
    fixture.settings = {
      ...fixture.settings,
      linkedAccounts: [{ platform: 'lichess', username: USERNAME }],
    };

    const { saves } = await setupMockEnvironment(page, fixture, USERNAME);
    const lichess = await setupMockLichess(page, USERNAME);

    await mountAndSettle(page, saves);

    // Three games spanning beyond the 5-day window: only the recent one would
    // survive steady-state eligibility; the 8- and 20-day-old games prove the
    // first-run backfill reaches past the window (they're within the newest 50).
    const recentMs = Date.now() - HOUR_MS;
    const midMs = Date.now() - 8 * DAY_MS;
    const oldMs = Date.now() - 20 * DAY_MS;

    lichess.armNext([
      buildLichessGame({ id: 'li-recent', createdAtMs: recentMs, userIsWhite: true, moves: 'e4 e5 Nf3', username: USERNAME }),
      buildLichessGame({ id: 'li-mid', createdAtMs: midMs, userIsWhite: true, moves: 'd4 d5 c4', username: USERNAME }),
      buildLichessGame({ id: 'li-old', createdAtMs: oldMs, userIsWhite: false, moves: 'e4 c5 Nf3', username: USERNAME }),
    ]);

    await clickSyncAndCapture(page, saves);

    const blob = saves[0].body as SavedBlob;

    // All three games ingested — including the two outside the 5-day window.
    expect(totalIngested(blob)).toBe(3);
    expect(dayEntry(blob, midMs)?.games?.ingested).toBe(1);
    expect(dayEntry(blob, oldMs)?.games?.ingested).toBe(1);
    expect(dayEntry(blob, midMs)?.games?.records?.length).toBe(1);
    expect(dayEntry(blob, oldMs)?.games?.records?.length).toBe(1);

    // Watermark advanced to the newest game so the next run is incremental.
    const acctKey = getAccountKey('lichess', USERNAME);
    expect(blob.games?.[acctKey]?.watermarkMs).toBe(recentMs);

    // The backfilled games surface in the Dashboard activity feed (one day per
    // game since they're 8/20 days apart).
    await expect(page.locator('.activity-feed .activity-day')).toHaveCount(3);
    await expect(page.locator('.activity-feed')).toContainText('Played 1 game');
  });

  test('Chess.com: first sync walks archives to backfill games older than 5 days and shows them in activity', async ({ page }) => {
    const USERNAME = 'testuser';

    const fixture = buildRepertoireData([]);
    fixture.settings = {
      ...fixture.settings,
      linkedAccounts: [{ platform: 'chess.com', username: USERNAME }],
    };

    const { saves } = await setupMockEnvironment(page, fixture, USERNAME);
    const chesscom = await setupMockChesscom(page, USERNAME);

    await mountAndSettle(page, saves);

    const recentMs = Date.now() - HOUR_MS;
    const midMs = Date.now() - 8 * DAY_MS;
    const oldMs = Date.now() - 20 * DAY_MS;
    // Chess.com createdAt = end_time (seconds) × 1000, so the watermark lands on
    // the floored-second boundary of the newest game.
    const recentCreatedAt = Math.floor(recentMs / 1000) * 1000;

    chesscom.armNext([
      buildChesscomGame({ uuid: 'cc-recent', endTimeMs: recentMs, userIsWhite: true, moves: '1. e4 e5 2. Nf3', username: USERNAME }),
      buildChesscomGame({ uuid: 'cc-mid', endTimeMs: midMs, userIsWhite: true, moves: '1. d4 d5 2. c4', username: USERNAME }),
      buildChesscomGame({ uuid: 'cc-old', endTimeMs: oldMs, userIsWhite: false, moves: '1. e4 c5 2. Nf3', username: USERNAME }),
    ]);

    await clickSyncAndCapture(page, saves);

    const blob = saves[0].body as SavedBlob;

    expect(totalIngested(blob)).toBe(3);
    expect(dayEntry(blob, midMs)?.games?.ingested).toBe(1);
    expect(dayEntry(blob, oldMs)?.games?.ingested).toBe(1);
    expect(dayEntry(blob, midMs)?.games?.records?.length).toBe(1);
    expect(dayEntry(blob, oldMs)?.games?.records?.length).toBe(1);

    const acctKey = getAccountKey('chess.com', USERNAME);
    expect(blob.games?.[acctKey]?.watermarkMs).toBe(recentCreatedAt);

    // The first run read the archives index and at least one monthly archive.
    expect(chesscom.indexCallCount()).toBeGreaterThanOrEqual(1);
    expect(chesscom.monthCallCount()).toBeGreaterThanOrEqual(1);

    await expect(page.locator('.activity-feed .activity-day')).toHaveCount(3);
    await expect(page.locator('.activity-feed')).toContainText('Played 1 game');
  });
});
