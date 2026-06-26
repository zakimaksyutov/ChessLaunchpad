import { test, expect } from '@playwright/test';
import { Chess } from 'chess.js';
import { State } from 'ts-fsrs';
import { FSRSService } from '../src/services/FSRSService';
import { FSRSCardData } from '../src/models/FSRSCardData';
import { normalizeFenResetHalfmoveClock } from '../src/utils/FenUtils';
import {
  buildRepertoireData,
  setupMockEnvironment,
  setupMockLichess,
} from './helpers';

// Some Actions tile entries carry an opt-in "why" explainer for new users,
// triggered by a 💡 segment fused onto the action button. The trigger lives
// outside the navigating part of the action, so expanding it reveals the
// rationale without navigating away. Its accessible name names the owning
// action so multiple explainers stay distinguishable for assistive tech.

test.describe('Dashboard — action "why" explainers', () => {
  const USERNAME = 'testuser';

  test('explains "Link a chess account" behind a 💡 button', async ({ page }) => {
    // Empty repertoire, no linked account → Link a chess account leads.
    await setupMockEnvironment(page, buildRepertoireData([]), USERNAME);
    await page.goto('/#/');

    // The navigating part of the action (exact match so it doesn't also catch
    // the 💡 button, whose label *contains* the action name).
    await expect(
      page.getByRole('button', { name: 'Link a chess account', exact: true }),
    ).toBeVisible();

    const why = page.getByRole('button', { name: 'Why Link a chess account?' });
    await expect(why).toBeVisible();
    // The rationale is present but hidden until requested.
    await expect(page.locator('.action-why-text')).toBeHidden();

    await why.click();
    await expect(page.locator('.action-why-text')).toBeVisible();
    await expect(page.locator('.action-why-text')).toContainText(/download your games/i);
    // Toggling the explainer must not navigate away to the action's route.
    expect(page.url()).not.toContain('settings');
    await expect(
      page.getByRole('button', { name: 'Link a chess account', exact: true }),
    ).toBeVisible();

    // It collapses again.
    await page.getByRole('button', { name: 'Hide explanation for Link a chess account' }).click();
    await expect(page.locator('.action-why-text')).toBeHidden();
  });
});

// ── "All caught up" empty state ──────────────────────────────────────

/** (normalized-fen, san) pairs for the user moves of a variant. */
function userMoveKeys(
  pgn: string,
  orientation: 'white' | 'black',
): Array<{ fen: string; san: string }> {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const moves = chess.history({ verbose: true });
  const sim = new Chess();
  const result: Array<{ fen: string; san: string }> = [];
  for (let i = 0; i < moves.length; i++) {
    const isUserMove = orientation === 'white' ? i % 2 === 0 : i % 2 === 1;
    const fenBefore = normalizeFenResetHalfmoveClock(sim.fen());
    const m = moves[i];
    sim.move({ from: m.from, to: m.to, promotion: m.promotion });
    if (isUserMove) result.push({ fen: fenBefore, san: m.san });
  }
  return result;
}

/**
 * A Review-state card whose due date is far in the future, so the dashboard
 * counts it as "mastered" (nothing due). No `lastReview` means
 * `computeDueDate` falls back to the stored (future) `due`.
 */
function masteredCard(): FSRSCardData {
  return {
    due: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    stability: 1000,
    difficulty: 5,
    elapsedDays: 0,
    scheduledDays: 60,
    learningSteps: 0,
    reps: 5,
    lapses: 0,
    state: State.Review,
  };
}

test.describe('Dashboard — "all caught up" empty state', () => {
  const USERNAME = 'testuser';

  test('shows the positive empty state when nothing is due and both repertoires are built', async ({ page }) => {
    const whitePgn = '1. e4';
    const blackPgn = '1. e4 e5';

    // Every user-turn edge gets a mastered (future-due) card so nothing is due.
    const seedCards: Record<string, FSRSCardData> = {};
    for (const { fen, san } of [
      ...userMoveKeys(whitePgn, 'white'),
      ...userMoveKeys(blackPgn, 'black'),
    ]) {
      seedCards[FSRSService.makeCardKey(fen, san)] = masteredCard();
    }

    const fixture = buildRepertoireData(
      [
        { pgn: whitePgn, orientation: 'white' },
        { pgn: blackPgn, orientation: 'black' },
      ],
      seedCards,
    );
    // A linked account suppresses the "Link a chess account" onboarding action.
    fixture.settings = {
      ...fixture.settings,
      linkedAccounts: [{ platform: 'lichess', username: USERNAME }],
    };

    await setupMockEnvironment(page, fixture, USERNAME);
    // The linked account makes the dashboard auto-sync on mount; mock Lichess
    // (empty response) so the test doesn't depend on a live request and no
    // games are ingested that would surface a "review games" action.
    await setupMockLichess(page, USERNAME);
    await page.goto('/#/');

    // Nothing to do AND both colors built → the positive empty state, and no
    // action rows or import buttons.
    await expect(page.locator('.actions-empty')).toContainText("You're all caught up");
    await expect(page.getByRole('button', { name: 'Start Training', exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Import (White|Black) PGN/ })).toHaveCount(0);
  });
});
