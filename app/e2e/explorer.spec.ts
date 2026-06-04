import { test, expect, Page } from '@playwright/test';
import { buildRepertoireData, setupMockEnvironment } from './helpers';

// ── Board piece helpers (local; mirror the small helpers in training.spec.ts) ─

async function expectPiece(page: Page, square: string, piece: string) {
    const loc = page.locator(`[data-square="${square}"] [data-piece="${piece}"]`);
    await expect(loc).toBeAttached({ timeout: 2_000 });
}

async function expectEmpty(page: Page, square: string) {
    const loc = page.locator(`[data-square="${square}"] [data-piece]`);
    await expect(loc).not.toBeAttached();
}

async function expectStartingPosition(page: Page) {
    await Promise.all([
        expectPiece(page, 'e2', 'wp'),
        expectPiece(page, 'e7', 'bp'),
        expectPiece(page, 'g1', 'wn'),
        expectEmpty(page, 'e4'),
        expectEmpty(page, 'e5'),
    ]);
}

// ── Test ─────────────────────────────────────────────────────────────

test.describe('Explorer page — navigation and URL sync', () => {
    test('click plies update URL, board, "How you got here", and history', async ({ page }) => {
        // Two white variants that share the 1.e4 root: this gives a
        // branching node (e4 → e5 | c5) and a unique continuation (e5 → Nf3).
        const variants = [
            { pgn: '1. e4 e5 2. Nf3', orientation: 'white' as const },
            { pgn: '1. e4 c5',        orientation: 'white' as const },
        ];
        const fixture = buildRepertoireData(variants);
        const { saves } = await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');

        // ── Initial load ────────────────────────────────────────────
        const board = page.locator('[data-testid="chessboard"]');
        await expect(board).toBeVisible({ timeout: 10_000 });

        // URL canonicalized to include ?o=white.
        await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/[?&]o=white/);

        // Board: starting position.
        await expectStartingPosition(page);

        // "How you got here" at root shows only the static start pill — no
        // clickable start button (we're already at root), and no empty-state
        // hint (the repertoire is not empty).
        const howYouGotHere = page.locator('.explorer-how-you-got-here');
        await expect(howYouGotHere.locator('.explorer-path-start-static')).toBeVisible();
        await expect(howYouGotHere.locator('button.explorer-path-start')).toHaveCount(0);
        await expect(howYouGotHere.locator('.explorer-empty-path')).toHaveCount(0);

        // White's turn → "Your moves from here".
        const moves = page.locator('.explorer-moves');
        await expect(moves.locator('.explorer-section-title')).toHaveText('Your moves from here');

        // Exactly one move row: 1. e4 (shared prefix of both variants).
        const moveRows = moves.locator('.explorer-move-row');
        await expect(moveRows).toHaveCount(1);
        const e4Row = moveRows.first();
        await expect(e4Row.locator('.explorer-move-row-prefix')).toHaveText('1.');
        await expect(e4Row.locator('button.explorer-move-san')).toHaveText('e4');
        // New, unrated user move → 'New' pill, no meta strip.
        await expect(e4Row.locator('.explorer-state-pill.state-new')).toBeVisible();
        await expect(e4Row.locator('.explorer-meta')).toHaveCount(0);
        // The continuation is an immediate branch listing both opponent replies.
        const e4Cont = e4Row.locator('.explorer-continuation-line');
        await expect(e4Cont).toContainText('e5');
        await expect(e4Cont).toContainText('c5');

        // ── Click e4 in the move list ───────────────────────────────
        await e4Row.locator('button.explorer-move-san').click();

        // URL gains a fen= param.
        await expect.poll(() => page.url(), { timeout: 5_000 }).toContain('fen=');

        // Board: pawn moved e2 → e4.
        await expectPiece(page, 'e4', 'wp');
        await expectEmpty(page, 'e2');

        // "How you got here" now shows: clickable start pill + 1.e4.
        const path = howYouGotHere.locator('.explorer-paths .explorer-path-line').first();
        await expect(path.locator('button.explorer-path-start')).toBeVisible();
        await expect(path.getByRole('button', { name: 'e4', exact: true })).toBeVisible();

        // Heading switches to "Opponent's replies".
        await expect(moves.locator('.explorer-section-title')).toHaveText("Opponent's replies");

        // Two opponent rows: e5 and c5, no FSRS pills (opponent moves skip
        // the FSRS cluster entirely per EXPLORER.md).
        await expect(moveRows).toHaveCount(2);
        const sans = moves.locator('.explorer-move-row button.explorer-move-san');
        await expect(sans).toHaveText(['e5', 'c5']);
        await expect(moves.locator('.explorer-move-row.opponent')).toHaveCount(2);
        await expect(moves.locator('.explorer-state-pill')).toHaveCount(0);

        // ── Click the e5 reply ──────────────────────────────────────
        await moves.getByRole('button', { name: 'e5', exact: true }).click();

        // Board: black pawn now on e5 too.
        await expectPiece(page, 'e4', 'wp');
        await expectPiece(page, 'e5', 'bp');

        // "How you got here" path now includes both 1.e4 and 1…e5.
        await expect(path.getByRole('button', { name: 'e4', exact: true })).toBeVisible();
        await expect(path.getByRole('button', { name: 'e5', exact: true })).toBeVisible();

        // Heading back to "Your moves from here".
        await expect(moves.locator('.explorer-section-title')).toHaveText('Your moves from here');

        // One row: Nf3 with `New` pill and NO meta strip (New-row rule).
        await expect(moveRows).toHaveCount(1);
        const nf3Row = moveRows.first();
        await expect(nf3Row.locator('button.explorer-move-san')).toHaveText('Nf3');
        await expect(nf3Row.locator('.explorer-state-pill.state-new')).toBeVisible();
        await expect(nf3Row.locator('.explorer-meta')).toHaveCount(0);

        // ── Click the start pill in "How you got here" ──────────────
        // Capture the after-e5 URL first so the goBack assertion below can
        // confirm the start-pill click actually pushed a new history entry.
        const urlAfterE5 = page.url();
        await howYouGotHere.locator('button.explorer-path-start').first().click();

        // Board returns to the starting position. (The URL keeps fen= set to
        // the root FEN — the page does not drop the param, it just navigates
        // to the root position; the visible signal is the board + the
        // static start pill replacing the path list.)
        await expectStartingPosition(page);
        await expect(howYouGotHere.locator('.explorer-path-start-static')).toBeVisible();
        await expect(howYouGotHere.locator('button.explorer-path-start')).toHaveCount(0);
        // URL must have changed from the after-e5 entry (a new history
        // entry was pushed, otherwise goBack below would be a no-op).
        expect(page.url()).not.toBe(urlAfterE5);

        // ── Browser Back walks to the previous position (after 1.e4 e5) ─
        await page.goBack();
        await expect.poll(() => page.url(), { timeout: 5_000 }).toContain('fen=');
        await expectPiece(page, 'e4', 'wp');
        await expectPiece(page, 'e5', 'bp');
        // Same Nf3 row should be back.
        await expect(moves.locator('.explorer-move-row button.explorer-move-san')).toHaveText(['Nf3']);

        // Explorer is read-only — no PUTs captured throughout.
        expect(saves).toHaveLength(0);
    });
});
