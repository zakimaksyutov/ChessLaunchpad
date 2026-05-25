import { test, expect, Page } from '@playwright/test';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { FSRSService } from '../src/services/FSRSService';
import { FSRSCardData } from '../src/models/FSRSCardData';
import { buildRepertoireData, setupMockEnvironment, advanceTime } from './helpers';

// ── Board helpers (adapted from ChessControl e2e) ────────────────────

async function getBoardInfo(page: Page) {
  const board = page.locator('[data-testid="chessboard"]');
  const boardBox = await board.boundingBox();
  expect(boardBox).not.toBeNull();
  const sqSize = boardBox!.width / 8;
  return { board, boardBox: boardBox!, sqSize };
}

function squareCenter(
  boardBox: { x: number; y: number; width: number },
  square: string,
  orientation: 'white' | 'black' = 'white',
) {
  const sqSize = boardBox.width / 8;
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1]) - 1;
  if (orientation === 'white') {
    return {
      x: boardBox.x + (file + 0.5) * sqSize,
      y: boardBox.y + (7 - rank + 0.5) * sqSize,
    };
  }
  return {
    x: boardBox.x + (7 - file + 0.5) * sqSize,
    y: boardBox.y + (rank + 0.5) * sqSize,
  };
}

async function dragPiece(
  page: Page,
  boardBox: { x: number; y: number; width: number },
  from: string,
  to: string,
  orientation: 'white' | 'black' = 'white',
) {
  const fromPos = squareCenter(boardBox, from, orientation);
  const toPos = squareCenter(boardBox, to, orientation);
  await page.mouse.move(fromPos.x, fromPos.y);
  await page.mouse.down();
  await page.mouse.move(toPos.x, toPos.y, { steps: 5 });
  await page.mouse.up();
}

/**
 * Assert that a green hint arrow points from `fromSq` to `toSq`.
 * The arrow-layer SVG uses board-relative pixel coords, so we compare
 * line endpoints against computed square centers (with a tolerance).
 */
async function expectHintArrow(
  page: Page,
  boardBox: { x: number; y: number; width: number },
  fromSq: string,
  toSq: string,
  orientation: 'white' | 'black' = 'white',
) {
  const arrow = page.locator('.arrow-layer line[stroke="#15781B"]:not([display="none"])');
  await expect(arrow.first()).toBeAttached({ timeout: 5_000 });

  const sqSize = boardBox.width / 8;
  // Arrow SVG coords are relative to the board (0,0 = top-left of board)
  const from = squareCenter(boardBox, fromSq, orientation);
  const to = squareCenter(boardBox, toSq, orientation);
  const relFrom = { x: from.x - boardBox.x, y: from.y - boardBox.y };
  const relTo   = { x: to.x   - boardBox.x, y: to.y   - boardBox.y };

  const x1 = Number(await arrow.first().getAttribute('x1'));
  const y1 = Number(await arrow.first().getAttribute('y1'));
  const x2 = Number(await arrow.first().getAttribute('x2'));
  const y2 = Number(await arrow.first().getAttribute('y2'));

  const tolerance = sqSize * 0.5;
  expect(Math.abs(x1 - relFrom.x)).toBeLessThan(tolerance);
  expect(Math.abs(y1 - relFrom.y)).toBeLessThan(tolerance);
  expect(Math.abs(x2 - relTo.x)).toBeLessThan(tolerance);
  expect(Math.abs(y2 - relTo.y)).toBeLessThan(tolerance);
}

/**
 * Assert that a specific piece (e.g. 'wp', 'bn') sits on `square`.
 * Piece codes: first char = color (w/b), second = type (p/n/b/r/q/k).
 */
async function expectPiece(page: Page, square: string, piece: string) {
  const loc = page.locator(`[data-square="${square}"] [data-piece="${piece}"]`);
  await expect(loc).toBeAttached({ timeout: 2_000 });
}

/** Assert that a square has no piece on it. */
async function expectEmpty(page: Page, square: string) {
  const loc = page.locator(`[data-square="${square}"] [data-piece]`);
  await expect(loc).not.toBeAttached();
}

/** Assert the board shows the starting position (spot-check key squares). */
async function expectStartingPosition(page: Page) {
  await Promise.all([
    expectPiece(page, 'e2', 'wp'),
    expectPiece(page, 'e7', 'bp'),
    expectPiece(page, 'g1', 'wn'),
    expectEmpty(page, 'e4'),
    expectEmpty(page, 'f3'),
  ]);
}

/** Assert the board shows position after 1. e4 e5 2. Nf3. */
async function expectPositionAfterNf3(page: Page) {
  await Promise.all([
    expectPiece(page, 'e4', 'wp'),
    expectPiece(page, 'e5', 'bp'),
    expectPiece(page, 'f3', 'wn'),
    expectEmpty(page, 'e2'),
    expectEmpty(page, 'g1'),
  ]);
}

/** Rate a fresh card Good `n` times and return serialized FSRS data. */
function rateGoodNTimes(n: number): FSRSCardData {
  const scheduler = fsrs({ enable_short_term: true });
  let card = createEmptyCard();
  for (let i = 0; i < n; i++) {
    const due = card.due;
    card = scheduler.next(card, due, Rating.Good).card;
  }
  return FSRSService.serialize(card);
}

const fixture = buildRepertoireData([
  { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
]);

// ── Tests ────────────────────────────────────────────────────────────

test.describe('Training page — one white variant (1. e4 e5 2. Nf3)', () => {

  test('loads and shows the chessboard with badges', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, fixture);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Error')).not.toBeVisible();
    await expect(page.locator('text=No variants available')).not.toBeVisible();
  });

  test('teaching mode autoplays and waits for user moves', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, fixture);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // New FSRS cards (st=0) → teaching mode.
    // White variant: user plays white moves, engine autoplays black.

    // Teaching mode shows a green arrow (SVG line) and a status bar
    const teachingBar = page.locator('.status-bar-teaching');
    await expect(teachingBar).toBeVisible({ timeout: 5_000 });
    await expect(teachingBar).toContainText('New moves');

    // Board should show starting position at the beginning of teaching
    await expectStartingPosition(page);

    const { boardBox } = await getBoardInfo(page);

    // Green hint arrow should point from e2 to e4
    await expectHintArrow(page, boardBox, 'e2', 'e4');

    // 1. e4 (follow the arrow)
    await dragPiece(page, boardBox, 'e2', 'e4');

    // Engine autoplays 1...e5, then teaching arrow should point g1→f3
    await expectHintArrow(page, boardBox, 'g1', 'f3');

    // 2. Nf3 (follow the arrow)
    await dragPiece(page, boardBox, 'g1', 'f3');

    // ── Recall pass ──────────────────────────────────────────────────
    // No save should have occurred yet (teaching doesn't trigger a save)
    expect(saves).toHaveLength(0);

    // After teaching, the engine resets the board and asks the user to
    // recall the same moves without arrows.
    const recallBar = page.locator('.status-bar-recall');
    await expect(recallBar).toBeVisible({ timeout: 5_000 });
    await expect(recallBar).toContainText('Recall');

    // Board should be reset to starting position for recall
    await expectStartingPosition(page);

    // No hint arrows should be present during recall
    const greenArrows = page.locator('.arrow-layer line[stroke="#15781B"]:not([display="none"])');
    await expect(greenArrows).toHaveCount(0);

    // 1. e4 (from memory)
    await dragPiece(page, boardBox, 'e2', 'e4');

    // Engine autoplays 1...e5 — wait for the pawn to land
    await expectPiece(page, 'e5', 'bp');

    // 2. Nf3 (from memory)
    await dragPiece(page, boardBox, 'g1', 'f3');

    // Board should show position after 1. e4 e5 2. Nf3
    await expectPositionAfterNf3(page);

    // ── Verify FSRS rating was persisted ────────────────────────────
    // Exactly one save should have occurred (after recall, not during teaching)
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);

    const saved = saves[0].body as {
      fsrsCards: Record<string, { st: number; r: number }>;
    };

    // Card keys: "{normalized_fen}::{SAN}"
    const e4Key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
    const nf3Key = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1::Nf3';

    expect(saved.fsrsCards[e4Key]).toBeDefined();
    expect(saved.fsrsCards[e4Key].st).toBeGreaterThan(0);   // no longer New
    expect(saved.fsrsCards[e4Key].r).toBeGreaterThan(0);     // has been reviewed
    expect(saved.fsrsCards[e4Key].ls).toBe(0);               // rated Again (ls=0)

    expect(saved.fsrsCards[nf3Key]).toBeDefined();
    expect(saved.fsrsCards[nf3Key].st).toBeGreaterThan(0);
    expect(saved.fsrsCards[nf3Key].r).toBeGreaterThan(0);
    expect(saved.fsrsCards[nf3Key].ls).toBe(0);              // rated Again (ls=0), not Good

    // Both cards should be due within 2 minutes (Again → 1-min learning step)
    const now = Date.now();
    const e4Due = new Date(saved.fsrsCards[e4Key].d).getTime();
    const nf3Due = new Date(saved.fsrsCards[nf3Key].d).getTime();
    const twoMinMs = 2 * 60 * 1000;
    expect(e4Due - now).toBeLessThan(twoMinMs);
    expect(nf3Due - now).toBeLessThan(twoMinMs);

    // ── After recall: cards are not immediately due ────────────────
    // After recall, cards are rated "Again" and enter Learning state
    // (st=1) with a short relearning interval (~1 min). The engine
    // correctly reports "No cards to train" until they become due.
    const noCardsMsg = page.getByText('No cards to train.');
    await expect(noCardsMsg).toBeVisible({ timeout: 5_000 });

    // ── Fast-forward time and re-enter training ─────────────────────
    await advanceTime(page, 2);

    // Navigate away and back to trigger a fresh startTraversal()
    // The GET mock now returns the saved data (with rated fsrsCards).
    await page.goto('/#/training');

    // ── Regular training (review pass) ──────────────────────────────
    // Cards are Learning (st=1) and now due → regular review mode.
    await expect(board).toBeVisible({ timeout: 10_000 });
    await expectStartingPosition(page);

    // Re-capture board box after navigation (may have changed)
    const { boardBox: reviewBoardBox } = await getBoardInfo(page);

    // Should NOT be teaching or recalling
    await expect(teachingBar).not.toBeVisible({ timeout: 3_000 });
    await expect(recallBar).not.toBeVisible();
    await expect(greenArrows).toHaveCount(0);

    // 1. e4 (regular review — no hints)
    await dragPiece(page, reviewBoardBox, 'e2', 'e4');

    // Engine autoplays 1...e5 — wait for the pawn to land
    await expectPiece(page, 'e5', 'bp');

    // 2. Nf3 (regular review)
    await dragPiece(page, reviewBoardBox, 'g1', 'f3');

    // Board should show final position
    await expectPositionAfterNf3(page);

    // Second save should arrive (after regular review)
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(2);

    // Verify due dates after regular review — both rated Good (ls=1),
    // next learning step is ~10 min, so due date should be well under 1 hour.
    const saved2 = saves[1].body as { fsrsCards: Record<string, { d: string; ls: number; st: number }> };
    const now2 = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    const e4Due2 = new Date(saved2.fsrsCards[e4Key].d).getTime();
    const nf3Due2 = new Date(saved2.fsrsCards[nf3Key].d).getTime();
    expect(e4Due2 - now2).toBeLessThan(oneHourMs);
    expect(nf3Due2 - now2).toBeLessThan(oneHourMs);
    // Both should have advanced to learning step 1
    expect(saved2.fsrsCards[e4Key].ls).toBe(1);
    expect(saved2.fsrsCards[nf3Key].ls).toBe(1);

    // Cards are not due yet (~10 min learning step) — should see empty state again
    await expect(page.getByText('No cards to train.')).toBeVisible({ timeout: 5_000 });
  });

});

// ── One black variant ─────────────────────────────────────────────────

const blackFixture = buildRepertoireData([
  { pgn: '1. e4 e5', orientation: 'black' },
]);

/** Assert the board shows position after 1. e4 (pawn moved, starting position otherwise intact). */
async function expectPositionAfterE4(page: Page) {
  await Promise.all([
    expectPiece(page, 'e4', 'wp'),
    expectPiece(page, 'e7', 'bp'),
    expectEmpty(page, 'e2'),
  ]);
}

/** Assert the board shows position after 1. e4 e5. */
async function expectPositionAfterE4E5(page: Page) {
  await Promise.all([
    expectPiece(page, 'e4', 'wp'),
    expectPiece(page, 'e5', 'bp'),
    expectEmpty(page, 'e2'),
    expectEmpty(page, 'e7'),
  ]);
}

test.describe('Training page — one black variant (1. e4 e5)', () => {

  test('loads and shows the chessboard with badges', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, blackFixture);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Error')).not.toBeVisible();
    await expect(page.locator('text=No variants available')).not.toBeVisible();
  });

  test('teaching mode autoplays opponent e4 then teaches user e5', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, blackFixture);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // New FSRS card (st=0) → teaching mode.
    // Black variant: engine autoplays white's e4, then user plays black's e5.

    const teachingBar = page.locator('.status-bar-teaching');
    await expect(teachingBar).toBeVisible({ timeout: 5_000 });
    await expect(teachingBar).toContainText('New moves');

    // Engine should have autoplayed 1. e4 (opponent move)
    const e4Piece = page.locator('[data-square="e4"] [data-piece="wp"]');
    await expect(e4Piece).toBeAttached({ timeout: 5_000 });

    const { boardBox } = await getBoardInfo(page);

    // Green hint arrow should point from e7 to e5 (black perspective)
    await expectHintArrow(page, boardBox, 'e7', 'e5', 'black');

    // 1...e5 (follow the arrow)
    await dragPiece(page, boardBox, 'e7', 'e5', 'black');

    // ── Recall pass ──────────────────────────────────────────────────
    // No save should have occurred yet (teaching doesn't trigger a save)
    expect(saves).toHaveLength(0);

    // After teaching, the engine resets the board and asks the user to
    // recall the same moves without arrows.
    const recallBar = page.locator('.status-bar-recall');
    await expect(recallBar).toBeVisible({ timeout: 5_000 });

    // Engine autoplays 1. e4 — wait for the pawn to land
    await expectPiece(page, 'e4', 'wp');

    // No hint arrows should be present during recall
    const greenArrows = page.locator('.arrow-layer line[stroke="#15781B"]:not([display="none"])');
    await expect(greenArrows).toHaveCount(0);

    // 1...e5 (from memory)
    await dragPiece(page, boardBox, 'e7', 'e5', 'black');

    // Board should show position after 1. e4 e5
    await expectPositionAfterE4E5(page);

    // ── Verify FSRS rating was persisted ────────────────────────────
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);

    const saved = saves[0].body as {
      fsrsCards: Record<string, { st: number; r: number; ls: number; d: string }>;
    };

    // Card key: "{normalized_fen_before_e5}::e5"
    const e5Key = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1::e5';

    expect(saved.fsrsCards[e5Key]).toBeDefined();
    expect(saved.fsrsCards[e5Key].st).toBeGreaterThan(0);   // no longer New
    expect(saved.fsrsCards[e5Key].r).toBeGreaterThan(0);     // has been reviewed
    expect(saved.fsrsCards[e5Key].ls).toBe(0);               // rated Again (ls=0)

    // Card should be due within 2 minutes (Again → 1-min learning step)
    const now = Date.now();
    const e5Due = new Date(saved.fsrsCards[e5Key].d).getTime();
    const twoMinMs = 2 * 60 * 1000;
    expect(e5Due - now).toBeLessThan(twoMinMs);

    // ── After recall: card is not immediately due ────────────────────
    const noCardsMsg = page.getByText('No cards to train.');
    await expect(noCardsMsg).toBeVisible({ timeout: 5_000 });

    // ── Fast-forward time and re-enter training ─────────────────────
    await advanceTime(page, 2);
    await page.goto('/#/training');

    // ── Regular training (review pass) ──────────────────────────────
    await expect(board).toBeVisible({ timeout: 10_000 });

    const { boardBox: reviewBoardBox } = await getBoardInfo(page);

    // Should NOT be teaching or recalling
    await expect(teachingBar).not.toBeVisible({ timeout: 3_000 });
    await expect(recallBar).not.toBeVisible();
    await expect(greenArrows).toHaveCount(0);

    // Engine autoplays 1. e4
    await expectPiece(page, 'e4', 'wp');

    // 1...e5 (regular review — no hints)
    await dragPiece(page, reviewBoardBox, 'e7', 'e5', 'black');

    // Board should show final position
    await expectPositionAfterE4E5(page);

    // Second save should arrive (after regular review)
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(2);

    // Verify due dates after regular review — rated Good (ls=1)
    const saved2 = saves[1].body as { fsrsCards: Record<string, { d: string; ls: number; st: number }> };
    const now2 = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    const e5Due2 = new Date(saved2.fsrsCards[e5Key].d).getTime();
    expect(e5Due2 - now2).toBeLessThan(oneHourMs);
    expect(saved2.fsrsCards[e5Key].ls).toBe(1);

    // Card is not due yet — should see empty state again
    await expect(page.getByText('No cards to train.')).toBeVisible({ timeout: 5_000 });
  });

});

// ── Mixed: same edge from both orientations ──────────────────────────

const mixedFixture = buildRepertoireData([
  { pgn: '1. e4 e5', orientation: 'black' },
  { pgn: '1. e4', orientation: 'white' },
]);

test.describe('Training page — shared edge from both colors', () => {

  // Card keys for verification
  const e4Key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
  const e5Key = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1::e5';

  test('trains both white e4 and black e5 in sequence', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, mixedFixture);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // ── 1st traversal: white e4 (teach + recall) ─────────────────────

    const teachingBar = page.locator('.status-bar-teaching');
    await expect(teachingBar).toBeVisible({ timeout: 5_000 });

    // Board starts in starting position (white orientation)
    await expectStartingPosition(page);

    const { boardBox: wb } = await getBoardInfo(page);

    // Teaching: play e4 following the hint
    await dragPiece(page, wb, 'e2', 'e4');

    // Recall: board resets, user plays e4 from memory
    const recallBar = page.locator('.status-bar-recall');
    await expect(recallBar).toBeVisible({ timeout: 5_000 });
    await expectStartingPosition(page);
    await dragPiece(page, wb, 'e2', 'e4');

    // Save should arrive after e4 recall
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);

    const saved1 = saves[0].body as {
      fsrsCards: Record<string, { st: number; r: number; ls: number }>;
    };
    expect(saved1.fsrsCards[e4Key]).toBeDefined();
    expect(saved1.fsrsCards[e4Key].st).toBeGreaterThan(0);

    // ── 2nd traversal: black e5 (teach + recall) ─────────────────────
    // Engine auto-starts the next card after a 300ms delay.
    // Board flips to black orientation.

    await expect(teachingBar).toBeVisible({ timeout: 5_000 });

    // Engine autoplays white's e4 (opponent move for black)
    await expectPiece(page, 'e4', 'wp');

    const { boardBox: bb } = await getBoardInfo(page);

    // Teaching: play e5 following the hint (black orientation)
    await dragPiece(page, bb, 'e7', 'e5', 'black');

    // Recall: board resets, engine autoplays e4, user recalls e5
    await expect(recallBar).toBeVisible({ timeout: 5_000 });
    await expectPiece(page, 'e4', 'wp');
    await dragPiece(page, bb, 'e7', 'e5', 'black');

    await expectPositionAfterE4E5(page);

    // Save should arrive after e5 recall
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(2);

    const saved2 = saves[1].body as {
      fsrsCards: Record<string, { st: number; r: number; ls: number }>;
    };
    expect(saved2.fsrsCards[e5Key]).toBeDefined();
    expect(saved2.fsrsCards[e5Key].st).toBeGreaterThan(0);

    // Both cards trained — no more cards to train
    await expect(page.getByText('No cards to train.')).toBeVisible({ timeout: 5_000 });

    // ── Fast-forward and review both ─────────────────────────────────
    await advanceTime(page, 2);
    await page.goto('/#/training');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // Review e4 (white) — regular mode, no teaching
    const { boardBox: rwb } = await getBoardInfo(page);
    await expect(teachingBar).not.toBeVisible({ timeout: 3_000 });
    await expectStartingPosition(page);
    await dragPiece(page, rwb, 'e2', 'e4');
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(3);

    // Wait for second traversal to start — autoplay glow signals
    // the engine is autoplaying white's e4 for the black review.
    await expect(page.locator('.board-glow-autoplay')).toBeVisible({ timeout: 5_000 });

    // Review e5 (black) — engine autoplays e4, then user plays e5
    await expectPiece(page, 'e4', 'wp');
    const { boardBox: rbb } = await getBoardInfo(page);
    await dragPiece(page, rbb, 'e7', 'e5', 'black');
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(4);

    // Verify final FSRS state — both cards rated Good (ls=1)
    const saved4 = saves[3].body as {
      fsrsCards: Record<string, { d: string; ls: number; st: number }>;
    };
    expect(saved4.fsrsCards[e4Key].ls).toBe(1);
    expect(saved4.fsrsCards[e5Key].ls).toBe(1);

    await expect(page.getByText('No cards to train.')).toBeVisible({ timeout: 5_000 });
  });

});

// ── Prefix-autoplay tests ────────────────────────────────────────────

test.describe('Teaching with known prefix (e4 studied, Nf3 new)', () => {

  // e4 card key from starting position
  const e4CardKey = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
  const nf3CardKey = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1::Nf3';

  // Build fixture with e4 pre-rated as well-studied (Good × 3)
  const studiedPrefixFixture = (() => {
    const f = buildRepertoireData([
      { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
    ]);
    f.fsrsCards = {
      [e4CardKey]: rateGoodNTimes(3),
    };
    return f;
  })();

  test('autoplays known prefix e4 during teach and recall of new Nf3', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, studiedPrefixFixture);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // Nf3 is New → teaching mode should trigger.
    // e4 is well-studied (Review state) and e5 is an opponent move.
    // Both should autoplay before teaching begins for Nf3.

    // ── Teaching pass ──────────────────────────────────────────────
    const teachingBar = page.locator('.status-bar-teaching');
    await expect(teachingBar).toBeVisible({ timeout: 10_000 });

    // When the teaching bar first appears, the board should already
    // show position after 1. e4 e5 (both autoplayed), NOT the
    // starting position. This is the key assertion: known prefix
    // moves are autoplayed, not presented for manual play.
    await expectPiece(page, 'e4', 'wp');
    await expectPiece(page, 'e5', 'bp');

    const { boardBox } = await getBoardInfo(page);

    // Hint arrow should point g1→f3 (the new card), not e2→e4
    await expectHintArrow(page, boardBox, 'g1', 'f3');

    // Play Nf3 (the only move the user should need to make)
    await dragPiece(page, boardBox, 'g1', 'f3');

    // ── Recall pass ───────────────────────────────────────────────
    const recallBar = page.locator('.status-bar-recall');
    await expect(recallBar).toBeVisible({ timeout: 10_000 });

    // Again, e4 and e5 should autoplay first. When recall becomes
    // interactive, the board should show position after 1. e4 e5.
    await expectPiece(page, 'e4', 'wp');
    await expectPiece(page, 'e5', 'bp');

    // No hint arrows during recall
    const greenArrows = page.locator('.arrow-layer line[stroke="#15781B"]:not([display="none"])');
    await expect(greenArrows).toHaveCount(0);

    // Recall Nf3 (the only move the user should recall)
    await dragPiece(page, boardBox, 'g1', 'f3');

    // Board should show final position
    await expectPositionAfterNf3(page);

    // ── Verify only Nf3 was rated ─────────────────────────────────
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);
    const saved = saves[0].body as {
      fsrsCards: Record<string, { st: number; r: number; ls: number }>;
    };

    // Nf3 should have been rated (no longer New)
    expect(saved.fsrsCards[nf3CardKey]).toBeDefined();
    expect(saved.fsrsCards[nf3CardKey].st).toBeGreaterThan(0);

    // e4 should remain untouched (it was autoplayed, not re-rated)
    expect(saved.fsrsCards[e4CardKey]).toBeDefined();
    expect(saved.fsrsCards[e4CardKey].st).toBe(2); // still Review
    expect(saved.fsrsCards[e4CardKey].r).toBe(3);  // reps unchanged from rateGoodNTimes(3)
  });
});

// ── PGN annotation rendering ────────────────────────────────────────

/**
 * Assert that an annotation arrow (SVG line) with the given stroke color
 * points from `fromSq` to `toSq`. Checks all matching lines and passes
 * if any one matches the expected coordinates.
 */
async function expectAnnotationArrow(
  page: Page,
  boardBox: { x: number; y: number; width: number },
  fromSq: string,
  toSq: string,
  strokeColor: string,
  orientation: 'white' | 'black' = 'white',
) {
  const arrows = page.locator(
    `.arrow-layer line[stroke="${strokeColor}"]:not([display="none"])`,
  );
  await expect(arrows.first()).toBeAttached({ timeout: 5_000 });

  const sqSize = boardBox.width / 8;
  const from = squareCenter(boardBox, fromSq, orientation);
  const to = squareCenter(boardBox, toSq, orientation);
  const relFrom = { x: from.x - boardBox.x, y: from.y - boardBox.y };
  const relTo = { x: to.x - boardBox.x, y: to.y - boardBox.y };
  const tolerance = sqSize * 0.5;

  const count = await arrows.count();
  let found = false;
  for (let i = 0; i < count; i++) {
    const el = arrows.nth(i);
    const x1 = Number(await el.getAttribute('x1'));
    const y1 = Number(await el.getAttribute('y1'));
    const x2 = Number(await el.getAttribute('x2'));
    const y2 = Number(await el.getAttribute('y2'));
    if (
      Math.abs(x1 - relFrom.x) < tolerance &&
      Math.abs(y1 - relFrom.y) < tolerance &&
      Math.abs(x2 - relTo.x) < tolerance &&
      Math.abs(y2 - relTo.y) < tolerance
    ) {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
}

/**
 * Assert that a square-highlight circle with the given stroke color
 * is positioned on `square`.
 */
async function expectSquareHighlight(
  page: Page,
  boardBox: { x: number; y: number; width: number },
  square: string,
  strokeColor: string,
  orientation: 'white' | 'black' = 'white',
) {
  const circles = page.locator(
    `.arrow-layer circle.square-highlight[stroke="${strokeColor}"]`,
  );
  await expect(circles.first()).toBeAttached({ timeout: 5_000 });

  const center = squareCenter(boardBox, square, orientation);
  const relCenter = { x: center.x - boardBox.x, y: center.y - boardBox.y };
  const tolerance = boardBox.width / 8 * 0.5;

  const count = await circles.count();
  let found = false;
  for (let i = 0; i < count; i++) {
    const el = circles.nth(i);
    const cx = Number(await el.getAttribute('cx'));
    const cy = Number(await el.getAttribute('cy'));
    if (
      Math.abs(cx - relCenter.x) < tolerance &&
      Math.abs(cy - relCenter.y) < tolerance
    ) {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
}

/** Rate a fresh card Again once and return serialized FSRS data. */
function rateAgainOnce(): FSRSCardData {
  const scheduler = fsrs({ enable_short_term: true });
  let card = createEmptyCard();
  card = scheduler.next(card, card.due, Rating.Again).card;
  return FSRSService.serialize(card);
}

// PGN with a green arrow e5→d6 and a red square on e5 shown before opponent's e5
// Comment on e4 so annotations appear during the autoplay pause (step.fen = post-e4).
const annotatedFixture = (() => {
  const f = buildRepertoireData([
    { pgn: '1. e4 {[%cal Ge5d6] [%csl Re5]} e5 2. Nf3', orientation: 'white' },
  ]);
  const e4Key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
  const nf3Key =
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1::Nf3';
  f.fsrsCards = {
    [e4Key]: rateAgainOnce(),
    [nf3Key]: rateAgainOnce(),
  };
  return f;
})();

test.describe('Training page — PGN annotations before autoplay (1. e4 {arrows/highlights} e5 2. Nf3)', () => {

  test('renders annotation arrow and square highlight during review', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, annotatedFixture);

    // Advance time so Again-rated cards (~1 min due) become due
    await advanceTime(page, 2);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // Should NOT be in teaching mode (cards are rated Again, not New)
    const teachingBar = page.locator('.status-bar-teaching');
    await expect(teachingBar).not.toBeVisible({ timeout: 3_000 });
    const recallBar = page.locator('.status-bar-recall');
    await expect(recallBar).not.toBeVisible();

    // Board should show starting position
    await expectStartingPosition(page);

    const { boardBox } = await getBoardInfo(page);

    // 1. e4 (regular review — no hints)
    await dragPiece(page, boardBox, 'e2', 'e4');

    // ── Verify PGN annotations are visible BEFORE opponent plays e5 ──
    // The board still shows position after e4 (no e5 pawn yet).
    // Green arrow from e5 to d6 ([%cal Ge5d6])
    await expectAnnotationArrow(page, boardBox, 'e5', 'd6', '#15781B');

    // Red square highlight on e5 ([%csl Re5])
    await expectSquareHighlight(page, boardBox, 'e5', '#882020');

    // Engine autoplays 1…e5 — wait for the pawn to land
    await expectPiece(page, 'e5', 'bp');

    // 2. Nf3 (complete the review)
    await dragPiece(page, boardBox, 'g1', 'f3');

    // Board should show final position
    await expectPositionAfterNf3(page);

    // Save should arrive after traversal
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);
  });

});

// ── Incorrect moves → Again rating ──────────────────────────────────

const incorrectMoveFixture = (() => {
  const f = buildRepertoireData([
    { pgn: '1. e4 e5 2. Nf3', orientation: 'white' },
  ]);
  const e4Key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
  const nf3Key =
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1::Nf3';
  f.fsrsCards = {
    [e4Key]: rateGoodNTimes(3),
    [nf3Key]: rateGoodNTimes(3),
  };
  return f;
})();

test.describe('Training page — incorrect moves then correct (1. e4 e5 2. Nf3)', () => {

  test('wrong moves are rejected and Nf3 is rated Again while e4 is rated Good', async ({ page }) => {
    const { saves } = await setupMockEnvironment(page, incorrectMoveFixture);

    // Cards are Review (3× Good) — due in ~13 days; advance past that
    await advanceTime(page, 20_000);
    await page.goto('/#/training');

    const board = page.locator('[data-testid="chessboard"]');
    await expect(board).toBeVisible({ timeout: 10_000 });

    // Should NOT be in teaching mode
    const teachingBar = page.locator('.status-bar-teaching');
    await expect(teachingBar).not.toBeVisible({ timeout: 3_000 });

    await expectStartingPosition(page);
    const { boardBox } = await getBoardInfo(page);

    // 1. e4 — correct
    await dragPiece(page, boardBox, 'e2', 'e4');

    // Engine autoplays 1…e5
    await expectPiece(page, 'e5', 'bp');

    // Save count should still be 0 (no traversal complete yet)
    expect(saves.length).toBe(0);

    // 2. Wrong move #1: Nc3 instead of Nf3
    await dragPiece(page, boardBox, 'b1', 'c3');
    // Piece should snap back — knight still on b1, c3 empty
    await expectPiece(page, 'b1', 'wn');
    await expectEmpty(page, 'c3');
    // No save should have occurred
    expect(saves.length).toBe(0);

    // 3. Wrong move #2: d4 instead of Nf3
    await dragPiece(page, boardBox, 'd2', 'd4');
    // Piece should snap back — pawn still on d2, d4 empty
    await expectPiece(page, 'd2', 'wp');
    await expectEmpty(page, 'd4');
    expect(saves.length).toBe(0);

    // 4. Correct move: Nf3
    await dragPiece(page, boardBox, 'g1', 'f3');
    await expectPositionAfterNf3(page);

    // Save should arrive
    await expect.poll(() => saves.length, { timeout: 5_000 }).toBe(1);

    const saved = saves[0].body as {
      fsrsCards: Record<string, { ls: number; st: number; l: number }>;
    };
    const e4Key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1::e4';
    const nf3Key =
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1::Nf3';

    // e4 was played correctly → rated Good (stays Review, no lapses)
    expect(saved.fsrsCards[e4Key].st).toBe(2);  // Review
    expect(saved.fsrsCards[e4Key].l).toBe(0);   // no lapses
    // Nf3 had errors → rated Again (Relearning, 1 lapse)
    expect(saved.fsrsCards[nf3Key].st).toBe(3);  // Relearning
    expect(saved.fsrsCards[nf3Key].l).toBe(1);   // 1 lapse
  });

});