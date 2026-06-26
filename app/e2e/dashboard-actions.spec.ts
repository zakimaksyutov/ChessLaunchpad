import { test, expect } from '@playwright/test';
import {
  buildRepertoireData,
  setupMockEnvironment,
} from './helpers';

// Some Actions tile entries carry an opt-in "why" explainer for new users,
// triggered by a 💡 segment fused onto the action button. The trigger lives
// outside the navigating part of the action, so expanding it reveals the
// rationale without navigating away.

test.describe('Dashboard — action "why" explainers', () => {
  const USERNAME = 'testuser';

  test('explains "Link a chess account" behind a 💡 button', async ({ page }) => {
    // Empty repertoire, no linked account → Link a chess account leads.
    await setupMockEnvironment(page, buildRepertoireData([]), USERNAME);
    await page.goto('/#/');

    await expect(page.getByRole('button', { name: 'Link a chess account' })).toBeVisible();

    const why = page.getByRole('button', { name: 'Why this action?' });
    await expect(why).toBeVisible();
    // The rationale is hidden until requested.
    await expect(page.locator('.action-why-text')).toHaveCount(0);

    await why.click();
    await expect(page.locator('.action-why-text')).toBeVisible();
    await expect(page.locator('.action-why-text')).toContainText(/download your games/i);
    // Toggling the explainer must not navigate away from the dashboard.
    expect(page.url()).toContain('#/');
    await expect(page.getByRole('button', { name: 'Link a chess account' })).toBeVisible();

    // It collapses again.
    await page.getByRole('button', { name: 'Hide explanation' }).click();
    await expect(page.locator('.action-why-text')).toHaveCount(0);
  });
});
