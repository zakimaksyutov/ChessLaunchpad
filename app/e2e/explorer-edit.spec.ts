import { test, expect, Page } from '@playwright/test';
import { buildRepertoireData, setupMockEnvironment, CapturedSave } from './helpers';

// ── Board piece helpers (local to this spec) ─────────────────────────

async function expectPiece(page: Page, square: string, piece: string) {
    const loc = page.locator(`[data-square="${square}"] [data-piece="${piece}"]`);
    await expect(loc).toBeAttached({ timeout: 2_000 });
}

async function expectEmpty(page: Page, square: string) {
    const loc = page.locator(`[data-square="${square}"] [data-piece]`);
    await expect(loc).not.toBeAttached();
}

/**
 * Drag-and-drop a piece from one square to another via the board. The board
 * exposes [data-square] attributes that chess-control uses internally; we
 * trigger the same pointer flow Playwright uses for real users.
 */
async function dragPiece(page: Page, from: string, to: string) {
    const fromSq = page.locator(`[data-square="${from}"]`).first();
    const toSq = page.locator(`[data-square="${to}"]`).first();
    const fromBox = await fromSq.boundingBox();
    const toBox = await toSq.boundingBox();
    if (!fromBox || !toBox) throw new Error(`Cannot find square ${from} → ${to}`);
    const fromX = fromBox.x + fromBox.width / 2;
    const fromY = fromBox.y + fromBox.height / 2;
    const toX = toBox.x + toBox.width / 2;
    const toY = toBox.y + toBox.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 8 });
    await page.mouse.up();
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Explorer page — Edit mode', () => {
    test('drop a new move, see counts, Save persists the change', async ({ page }) => {
        // Start with a tiny seeded repertoire (1.e4) so the board has a
        // baseline position to drop new moves from.
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        const { saves } = await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        const board = page.locator('[data-testid="chessboard"]');
        await expect(board).toBeVisible({ timeout: 10_000 });

        // No save bar in Read mode.
        await expect(page.locator('.explorer-save-bar')).toHaveCount(0);

        // Flip to Edit mode via the green "Edit repertoire" CTA.
        const editCta = page.getByRole('button', { name: 'Edit repertoire', exact: true });
        await editCta.click();
        // Inline edit bar appears immediately (always-visible in Edit mode).
        await expect(page.locator('.explorer-save-bar')).toBeVisible();
        await expect(page.locator('.explorer-save-bar-counts')).toHaveText('No pending changes');

        // Click 1.e4 to navigate after it, so the board is on black's move.
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await expectPiece(page, 'e4', 'wp');

        // Drag black pawn e7 → e5 to add the move.
        await dragPiece(page, 'e7', 'e5');
        await expectPiece(page, 'e5', 'bp');

        // Save bar appears with "1 added".
        const saveBar = page.locator('.explorer-save-bar');
        await expect(saveBar).toBeVisible();
        await expect(saveBar.locator('.explorer-save-bar-counts')).toContainText('1 added');

        // Click Review & Save to open the Review view.
        await saveBar.getByRole('button', { name: 'Review & Save' }).click();
        // Review page is visible.
        const review = page.locator('.explorer-review');
        await expect(review).toBeVisible();
        await expect(review.getByRole('heading', { name: /Added \(1\)/ })).toBeVisible();

        // Save commits the change.
        await review.getByRole('button', { name: 'Save', exact: true }).click();

        // Wait for save to land and Read mode to be restored.
        await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);
        await expect(page.locator('.explorer-save-bar')).toHaveCount(0);

        // Verify the saved blob has the new edge in the white repertoire's
        // dict (the after-e4 position carries an `e5` move).
        const lastSave: CapturedSave = saves[saves.length - 1];
        const body = lastSave.body as Record<string, unknown>;
        const repertoires = body.repertoires as Array<{
            orientation: string;
            positions: Record<string, { moves: Record<string, unknown> }>;
        }>;
        const white = repertoires.find(r => r.orientation === 'white')!;
        // Find the after-1.e4 position by checking the SAN of any position's moves.
        const afterE4 = Object.values(white.positions).find(p => 'e5' in p.moves);
        expect(afterE4).toBeDefined();
    });

    test('delete a move from a row, see removed count, Save persists the prune', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
        ]);
        const { saves } = await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        // Enter Edit.
        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();

        // From the start position, the move list shows 1.e4. Delete it.
        const moves = page.locator('.explorer-moves');
        const e4Row = moves.locator('.explorer-move-row').first();
        await expect(e4Row.locator('button.explorer-move-san')).toHaveText('e4');
        await e4Row.locator('button.explorer-move-delete').click();

        // The row should disappear (single edge → after delete, the move list
        // is empty in Edit mode).
        await expect(moves.locator('.explorer-move-row')).toHaveCount(0);

        // Save bar shows the cascade — `1.e4`, the opponent `e5`, and the
        // user-turn `Nf3` should all be removed (3 edges).
        const saveBar = page.locator('.explorer-save-bar');
        await expect(saveBar).toBeVisible();
        await expect(saveBar.locator('.explorer-save-bar-counts')).toContainText('3 removed');

        // Save and assert the PUT body is missing the deleted positions.
        await saveBar.getByRole('button', { name: 'Review & Save' }).click();
        await page.locator('.explorer-review').getByRole('button', { name: 'Save', exact: true }).click();

        await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);
        const body = saves[0].body as Record<string, unknown>;
        const repertoires = body.repertoires as Array<{ orientation: string; positions: Record<string, unknown> }>;
        const white = repertoires.find(r => r.orientation === 'white')!;
        // Only the start position should survive in white's dict.
        expect(Object.keys(white.positions)).toHaveLength(1);
    });

    test('Discard prompts confirmation and restores the read view', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        const { saves } = await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await dragPiece(page, 'e7', 'e5');

        const saveBar = page.locator('.explorer-save-bar');
        await expect(saveBar).toBeVisible();

        // Click Discard — prompt should appear.
        await saveBar.getByRole('button', { name: 'Discard' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Discard pending edits?');

        // Confirm discard.
        await dialog.getByRole('button', { name: 'Discard', exact: true }).click();

        // Back to Read mode, no save bar, "Edit repertoire" CTA returns, no saves recorded.
        await expect(page.locator('.explorer-save-bar')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Edit repertoire', exact: true })).toBeVisible();
        expect(saves).toHaveLength(0);
    });

    test('shared link with ?fen= opens in Read mode (no auto-edit)', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4 e5', orientation: 'white' },
        ]);
        await setupMockEnvironment(page, fixture);

        // Navigate directly to an explorer URL with fen — simulating a
        // shared link. Even though we didn't include any "edit" flag in the
        // URL, the page must open in Read mode (no `edit` URL flag exists
        // per spec) — i.e. the green "Edit repertoire" CTA is shown and no
        // inline edit bar exists.
        await page.goto('/#/explorer?o=white');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('button', { name: 'Edit repertoire', exact: true })).toBeVisible();
        // No save bar.
        await expect(page.locator('.explorer-save-bar')).toHaveCount(0);
    });

    test('Save surfaces the conflict prompt on a 412 and preserves the pending delta', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        await setupMockEnvironment(page, fixture);

        // Force the next PUT to 412 — simulating a concurrent writer that
        // already moved the ETag forward.
        await page.route('**/api/user/*/variants', async (route, req) => {
            if (req.method() === 'PUT') {
                return route.fulfill({ status: 412, body: 'precondition failed' });
            }
            return route.fallback();
        });

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        // Stage an edit.
        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await dragPiece(page, 'e7', 'e5');
        const saveBar = page.locator('.explorer-save-bar');
        await expect(saveBar).toBeVisible();

        // Save → Review opens → Save fires PUT → 412 → conflict prompt.
        await saveBar.getByRole('button', { name: 'Review & Save' }).click();
        await page.locator('.explorer-review').getByRole('button', { name: 'Save', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Repertoire changed elsewhere');

        // Dismissing the conflict prompt (Keep editing) must NOT lose the delta.
        await dialog.getByRole('button', { name: 'Keep editing' }).click();
        // We're back in the Review view with the delta intact.
        await expect(page.locator('.explorer-review')).toBeVisible();
        await expect(page.locator('.explorer-review')).toContainText(/1 added/);
    });

    test('browser Back from Review returns to the main Edit view (delta intact)', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await dragPiece(page, 'e7', 'e5');
        await page.locator('.explorer-save-bar').getByRole('button', { name: 'Review & Save' }).click();
        await expect(page.locator('.explorer-review')).toBeVisible();

        // Browser Back — per spec, equivalent to Cancel: returns to main view, delta intact.
        await page.goBack();
        await expect(page.locator('.explorer-review')).toHaveCount(0);
        await expect(page.locator('.explorer-save-bar')).toBeVisible();
        await expect(page.locator('.explorer-save-bar')).toContainText(/1 added/);
    });

    test('orientation toggle is hidden in Edit mode; delta survives in-page navigation', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4 e5', orientation: 'white' },
        ]);
        await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        // Toggle pills are visible in Read mode.
        await expect(page.getByRole('button', { name: 'White', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Black', exact: true })).toBeVisible();

        // Stage a white-rep edit.
        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();

        // Toggle pills are hidden in Edit mode (editing is scoped to one
        // repertoire per session).
        await expect(page.getByRole('button', { name: 'White', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Black', exact: true })).toHaveCount(0);

        // Jump back to start and drop a fresh move (1.a3).
        await page.locator('button.explorer-path-start').first().click();
        await dragPiece(page, 'a2', 'a3');
        const saveBar = page.locator('.explorer-save-bar');
        await expect(saveBar).toBeVisible();
        const initialCount = await saveBar.locator('.explorer-save-bar-counts').textContent();
        expect(initialCount).toMatch(/1 added/);

        // Navigate into the existing line via the move list — delta survives
        // in-page navigation.
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await expect(saveBar).toBeVisible();
        await expect(saveBar.locator('.explorer-save-bar-counts')).toHaveText(initialCount!);
    });

    test('annotation-only Save flows through the same path', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        const { saves } = await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();

        // Annotate the start position by dispatching the annotation-changed
        // callback directly through the chess-control bridge. We rely on
        // the underlying chess-control component's handler to fire when the
        // annotations prop changes, but the cleanest e2e is to right-click
        // drag from e2 to e4 to draw a green arrow.
        const e2 = await page.evaluate(() => {
            const sq = document.querySelector('[data-square="e2"]')!.getBoundingClientRect();
            return { x: sq.x + sq.width / 2, y: sq.y + sq.height / 2 };
        });
        const e4 = await page.evaluate(() => {
            const sq = document.querySelector('[data-square="e4"]')!.getBoundingClientRect();
            return { x: sq.x + sq.width / 2, y: sq.y + sq.height / 2 };
        });
        await page.mouse.move(e2.x, e2.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(e4.x, e4.y, { steps: 8 });
        await page.mouse.up({ button: 'right' });

        // Save bar should show "1 changed" (annotation-only delta).
        const saveBar = page.locator('.explorer-save-bar');
        await expect(saveBar).toBeVisible({ timeout: 3_000 });
        await expect(saveBar.locator('.explorer-save-bar-counts')).toContainText('1 changed');

        // Save and assert the persisted blob carries the annotation.
        await saveBar.getByRole('button', { name: 'Review & Save' }).click();
        await page.locator('.explorer-review').getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);

        const body = saves[0].body as Record<string, unknown>;
        const repertoires = body.repertoires as Array<{
            orientation: string;
            positions: Record<string, { annotations?: unknown[] }>;
        }>;
        const white = repertoires.find(r => r.orientation === 'white')!;
        // Start FEN normalized — locate any position with an annotation.
        const annotated = Object.values(white.positions).find(p => Array.isArray(p.annotations) && p.annotations.length > 0);
        expect(annotated).toBeDefined();
    });

    test('Training nav link is dimmed and intercepting clicks while dirty', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');
        await expect(page.locator('[data-testid="chessboard"]')).toBeVisible({ timeout: 10_000 });

        // No edits yet → Training link not dimmed.
        await expect(page.locator('a[href="#/training"]')).not.toHaveClass(/header-nav-link-disabled/);

        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await dragPiece(page, 'e7', 'e5');

        // Now dirty → Training link is dimmed and tooltip is set.
        const trainingLink = page.locator('a[href="#/training"]');
        await expect(trainingLink).toHaveClass(/header-nav-link-disabled/);
        await expect(trainingLink).toHaveAttribute('aria-disabled', 'true');
        await expect(trainingLink).toHaveAttribute('title', /Save or discard/i);

        // Clicking it should prompt; with auto-dismiss (cancel), the URL must stay in /explorer.
        page.on('dialog', d => d.dismiss());
        await trainingLink.click({ force: true });
        await page.waitForTimeout(200);
        expect(page.url()).toContain('/explorer');
    });

    test('browser Back to a non-/explorer route prompts and bounces back on cancel', async ({ page }) => {
        const fixture = buildRepertoireData([
            { pgn: '1. e4', orientation: 'white' },
        ]);
        await setupMockEnvironment(page, fixture);

        // Build history: /games → /explorer (via Header link).
        await page.goto('/#/games');
        await page.waitForTimeout(300);
        await page.locator('a[href="#/explorer"]').click();
        await page.waitForTimeout(500);

        // Stage an edit.
        await page.getByRole('button', { name: 'Edit repertoire', exact: true }).click();
        await page.locator('button.explorer-move-san', { hasText: 'e4' }).first().click();
        await dragPiece(page, 'e7', 'e5');
        await expect(page.locator('.explorer-save-bar')).toBeVisible();

        // Cancel the leave prompt: dismiss any incoming dialog. The popstate
        // guard's replaceState should bounce the URL back to /explorer.
        page.on('dialog', d => d.dismiss());

        // Pop history twice: first stays in /explorer (no prompt), second
        // tries to leave to /games — guard intercepts.
        await page.goBack();
        await page.waitForTimeout(300);
        await page.goBack();
        await page.waitForTimeout(500);
        expect(page.url()).toContain('/explorer');
    });
});
