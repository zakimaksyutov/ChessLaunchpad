import { test, expect } from '@playwright/test';
import {
  buildRepertoireData,
  setupMockEnvironment,
} from './helpers';

// The Actions tile offers a lower-priority "Import <color> PGN" row only for
// repertoire colors that are still empty. These tests cover the gating
// (which buttons show) and the end-to-end import (decode → save → re-fetch →
// the imported color's button drops away).

test.describe('Dashboard — import repertoire as PGN', () => {
  const USERNAME = 'testuser';

  /** Empty repertoire (both colors), with a linked account so no other action
   *  competes — the import row is the tile's sole content. */
  function emptyFixture() {
    const fixture = buildRepertoireData([]);
    fixture.settings = {
      ...fixture.settings,
      linkedAccounts: [{ platform: 'lichess', username: USERNAME }],
    };
    return fixture;
  }

  test('shows both import buttons when both repertoires are empty', async ({ page }) => {
    await setupMockEnvironment(page, emptyFixture(), USERNAME);
    await page.goto('/#/');

    await expect(page.getByRole('button', { name: 'Import White PGN' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import Black PGN' })).toBeVisible();
    // The positive empty state must NOT show — a brand-new user has work to do.
    await expect(page.locator('.actions-empty')).toHaveCount(0);
  });

  test('importing a White PGN saves it and removes the White button', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, emptyFixture(), USERNAME);
    await page.goto('/#/');

    const whiteBtn = page.getByRole('button', { name: 'Import White PGN' });
    await expect(whiteBtn).toBeVisible();

    const whitePgn = '[Repertoire "White"]\n\n1. e4 e5 2. Nf3 *';
    const fileChooserPromise = page.waitForEvent('filechooser');
    await whiteBtn.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'white.pgn',
      mimeType: 'application/x-chess-pgn',
      buffer: Buffer.from(whitePgn),
    });

    // A PUT persists the imported repertoire.
    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1);
    const saved = saves[0].body as {
      repertoires: Array<{ orientation: string; positions: Record<string, unknown> }>;
    };
    const savedWhite = saved.repertoires.find(r => r.orientation === 'white');
    expect(Object.keys(savedWhite!.positions).length).toBeGreaterThan(0);

    // Success feedback shows, the White button drops away (no longer empty),
    // and Black remains importable.
    await expect(page.locator('.actions-import-toast--success')).toContainText(/Imported \d+ White move/);
    await expect(page.getByRole('button', { name: 'Import White PGN' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import Black PGN' })).toBeVisible();
  });

  test('rejects a PGN whose color does not match the chosen button', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, emptyFixture(), USERNAME);
    await page.goto('/#/');

    const whiteBtn = page.getByRole('button', { name: 'Import White PGN' });
    await expect(whiteBtn).toBeVisible();

    // A Black-headered file picked under the White button must be refused.
    const blackPgn = '[Repertoire "Black"]\n\n1. e4 c5 *';
    const fileChooserPromise = page.waitForEvent('filechooser');
    await whiteBtn.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'black.pgn',
      mimeType: 'application/x-chess-pgn',
      buffer: Buffer.from(blackPgn),
    });

    await expect(page.locator('.actions-import-toast--error')).toContainText(/Black repertoire.*import White/);
    // Nothing persisted, both buttons still offered.
    await expect.poll(() => saves.length, { timeout: 2_000 }).toBe(0);
    await expect(page.getByRole('button', { name: 'Import White PGN' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import Black PGN' })).toBeVisible();
  });
});
