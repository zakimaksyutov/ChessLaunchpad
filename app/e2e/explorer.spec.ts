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

        // "How you got here" at root: the Home/Back/Forward toolbar is present
        // but every button is disabled (nowhere to go yet), and there is no
        // empty-state hint (the repertoire is not empty).
        const howYouGotHere = page.locator('.explorer-how-you-got-here');
        const homeBtn = howYouGotHere.getByRole('button', { name: 'Go to starting position' });
        const backBtn = howYouGotHere.getByRole('button', { name: 'Back to previous position' });
        const fwdBtn = howYouGotHere.getByRole('button', { name: 'Forward to next position' });
        await expect(homeBtn).toHaveAttribute('aria-disabled', 'true');
        await expect(backBtn).toHaveAttribute('aria-disabled', 'true');
        await expect(fwdBtn).toHaveAttribute('aria-disabled', 'true');
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

        // "How you got here" now shows the 1.e4 path, and the toolbar's Home
        // and Back buttons light up (we navigated away from root).
        await expect(homeBtn).toHaveAttribute('aria-disabled', 'false');
        await expect(backBtn).toHaveAttribute('aria-disabled', 'false');
        const path = howYouGotHere.locator('.explorer-paths .explorer-path-line').first();
        await expect(path.getByRole('button', { name: 'e4', exact: true })).toBeVisible();

        // Heading switches to "Opponent's replies".
        await expect(moves.locator('.explorer-section-title')).toHaveText("Opponent's replies");

        // Two opponent rows: c5 and e5, no FSRS pills (opponent moves skip
        // the FSRS cluster entirely per EXPLORER.md).
        // Order: SANs from the v3 wire are emitted in `Array.prototype.sort()`
        // order (alphabetical), so 'c5' renders before 'e5'.
        await expect(moveRows).toHaveCount(2);
        const sans = moves.locator('.explorer-move-row button.explorer-move-san');
        await expect(sans).toHaveText(['c5', 'e5']);
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

        // ── Click the Home button in "How you got here" ─────────────
        // Capture the after-e5 URL first so we can confirm the Home click
        // actually pushed a new history entry.
        const urlAfterE5 = page.url();
        await homeBtn.click();

        // Board returns to the starting position. (The URL keeps fen= set to
        // the root FEN — the page does not drop the param, it just navigates
        // to the root position; the visible signal is the board + the Home
        // button going disabled now that we're back at root.)
        await expectStartingPosition(page);
        await expect(homeBtn).toHaveAttribute('aria-disabled', 'true');
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

    test('Home/Back/Forward toolbar traverses in-page history', async ({ page }) => {
        const variants = [
            { pgn: '1. e4 e5 2. Nf3', orientation: 'white' as const },
        ];
        const fixture = buildRepertoireData(variants);
        await setupMockEnvironment(page, fixture);

        await page.goto('/#/explorer');

        const board = page.locator('[data-testid="chessboard"]');
        await expect(board).toBeVisible({ timeout: 10_000 });

        const howYouGotHere = page.locator('.explorer-how-you-got-here');
        const homeBtn = howYouGotHere.getByRole('button', { name: 'Go to starting position' });
        const backBtn = howYouGotHere.getByRole('button', { name: 'Back to previous position' });
        const fwdBtn = howYouGotHere.getByRole('button', { name: 'Forward to next position' });
        const moves = page.locator('.explorer-moves');

        // Navigate root → 1.e4 → 1…e5 via the move list.
        await moves.getByRole('button', { name: 'e4', exact: true }).click();
        await expectPiece(page, 'e4', 'wp');
        await moves.getByRole('button', { name: 'e5', exact: true }).click();
        await expectPiece(page, 'e5', 'bp');
        await expect(fwdBtn).toHaveAttribute('aria-disabled', 'true');

        // Back walks to the 1.e4 position (e5 retracted).
        await expect(backBtn).toHaveAttribute('aria-disabled', 'false');
        await backBtn.click();
        await expectPiece(page, 'e4', 'wp');
        await expectEmpty(page, 'e5');
        await expect(fwdBtn).toHaveAttribute('aria-disabled', 'false');

        // Back again returns to the root position; Back/Home now bottom out.
        await backBtn.click();
        await expectStartingPosition(page);
        await expect(backBtn).toHaveAttribute('aria-disabled', 'true');
        await expect(homeBtn).toHaveAttribute('aria-disabled', 'true');

        // Forward replays root → 1.e4, then 1.e4 → 1…e5.
        await fwdBtn.click();
        await expectPiece(page, 'e4', 'wp');
        await expectEmpty(page, 'e5');
        await fwdBtn.click();
        await expectPiece(page, 'e5', 'bp');
        await expect(fwdBtn).toHaveAttribute('aria-disabled', 'true');

        // A fresh navigation after going Back truncates the forward stack:
        // step Back to 1.e4, then Home — Forward must disable.
        await backBtn.click();
        await expectPiece(page, 'e4', 'wp');
        await homeBtn.click();
        await expectStartingPosition(page);
        await expect(fwdBtn).toHaveAttribute('aria-disabled', 'true');
    });

    test('cross-orientation Back returns to the exact prior entry (no phantom snap)', async ({ page }) => {
        // White line through 1.e4; the Black line is unrelated (1.d4 d5), so
        // the white e4-position is NOT in the Black repertoire. This exercises
        // the orientation-toggle-that-snaps-to-root path, where `currentFen`
        // and `resolvedOrientation` momentarily disagree — the history stack
        // must still record only the real positions.
        const variants = [
            { pgn: '1. e4 e5', orientation: 'white' as const },
            { pgn: '1. d4 d5', orientation: 'black' as const },
        ];
        const fixture = buildRepertoireData(variants);
        await setupMockEnvironment(page, fixture);

        const e4Fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        await page.goto(`/#/explorer?o=white&fen=${encodeURIComponent(e4Fen)}`);

        const board = page.locator('[data-testid="chessboard"]');
        await expect(board).toBeVisible({ timeout: 10_000 });
        await expectPiece(page, 'e4', 'wp');

        // Toggle to Black: the e4 position isn't in the Black repertoire, so the
        // page snaps to the Black root (start position).
        await page.getByRole('button', { name: 'Black', exact: true }).click();
        await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/[?&]o=black/);
        await expectStartingPosition(page);

        // Back must return to the EXACT prior entry — the e4 position in White —
        // not a phantom {e4, black} that would immediately re-snap to root.
        const backBtn = page.locator('.explorer-history-back');
        await backBtn.click();
        await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/[?&]o=white/);
        await expectPiece(page, 'e4', 'wp');
    });

    test('"How you got here" merges transposition paths as PGN variations', async ({ page }) => {
        // Two white variants reaching the same position after 1.e4 c5 2.Nf3
        // by different move orders.
        const variants = [
            { pgn: '1. e4 c5 2. Nf3', orientation: 'white' as const },
            { pgn: '1. Nf3 c5 2. e4', orientation: 'white' as const },
        ];
        const fixture = buildRepertoireData(variants);
        await setupMockEnvironment(page, fixture);

        // Target FEN: position after 1.e4 c5 2.Nf3 (== position after 1.Nf3 c5 2.e4),
        // normalized (halfmove=0, fullmove=1) per FenUtils.normalizeFenResetHalfmoveClock.
        const targetFen = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 0 1';
        await page.goto(`/#/explorer?o=white&fen=${encodeURIComponent(targetFen)}`);

        const board = page.locator('[data-testid="chessboard"]');
        await expect(board).toBeVisible({ timeout: 10_000 });

        const howYouGotHere = page.locator('.explorer-how-you-got-here');
        await expect(howYouGotHere.locator('.explorer-section-title')).toHaveText('How you got here');

        // The two paths collapse into a single PGN-with-variations line
        // (the old multi-row UL is gone for multi-path targets).
        const lines = howYouGotHere.locator('.explorer-paths .explorer-path-line');
        await expect(lines).toHaveCount(1);
        const line = lines.first();

        // Home button is enabled (we're at a non-root position).
        await expect(howYouGotHere.getByRole('button', { name: 'Go to starting position' })).toHaveAttribute('aria-disabled', 'false');

        // Variation segment is wrapped in PGN parens and styled distinctly.
        const variation = line.locator('.explorer-path-variation');
        await expect(variation).toHaveCount(1);
        await expect(variation.locator('.explorer-path-paren')).toHaveCount(2);
        // The variation's plies are clickable buttons, each marked with the
        // de-emphasized variation class.
        const varPlies = variation.locator('button.explorer-ply.explorer-ply-variation');
        await expect(varPlies).toHaveCount(3);
        await expect(varPlies).toHaveText(['Nf3', 'c5', 'e4']);

        // Main-line plies are everything outside the variation: e4, c5, Nf3.
        const mainPlies = line.locator(':scope > .explorer-ply-token button.explorer-ply');
        await expect(mainPlies).toHaveCount(3);
        await expect(mainPlies).toHaveText(['e4', 'c5', 'Nf3']);
        // Main plies must NOT carry the variation class.
        await expect(line.locator(':scope > .explorer-ply-token .explorer-ply-variation')).toHaveCount(0);

        // First variation ply opens with `1.` (full prefix at variation start);
        // first main ply after the variation regains its `1…` prefix.
        await expect(variation.locator('.explorer-ply-token').first()).toContainText('1.Nf3');
        const mainPlyTokens = line.locator(':scope > .explorer-ply-token');
        await expect(mainPlyTokens.nth(1)).toContainText('1\u2026c5');
    });
});
