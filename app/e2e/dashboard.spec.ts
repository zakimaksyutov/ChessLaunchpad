import { test, expect } from '@playwright/test';
import { Chess } from 'chess.js';
import { State } from 'ts-fsrs';
import { FSRSService } from '../src/services/FSRSService';
import { FSRSCardData } from '../src/models/FSRSCardData';
import { normalizeFenResetHalfmoveClock } from '../src/utils/FenUtils';
import { RepertoireGraph } from '../src/services/RepertoireGraph';
import {
  buildRepertoireData,
  setupMockEnvironment,
  setupMockLichess,
  buildLichessGame,
  advanceTime,
} from './helpers';

// ── Helpers (test-local) ─────────────────────────────────────────────

/** All (normalized-fen, san) pairs corresponding to user moves in a variant. */
function userMoveKeysForVariant(
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
    const move = moves[i];
    sim.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (isUserMove) result.push({ fen: fenBefore, san: move.san });
  }
  return result;
}

/**
 * Apply `n` consecutive Good ratings to a card, stepping `now` forward to
 * the card's previous due date each iteration (so each rating is "on
 * schedule"). Mutates the shared FSRSService instance.
 */
function preRateGoodNTimes(
  svc: FSRSService,
  fen: string,
  san: string,
  n: number,
  start: Date,
): void {
  let now = start;
  for (let i = 0; i < n; i++) {
    svc.rateCard(fen, san, true, now);
    const card = svc.getCards()[FSRSService.makeCardKey(fen, san)];
    now = FSRSService.computeDueDate(card);
  }
}

// ── Test ─────────────────────────────────────────────────────────────

test.describe('Dashboard — game sync drives FSRS', () => {
  test('downloaded games rate matching positions Good and deviations Again', async ({ page }) => {
    const USERNAME = 'testuser';

    // ── 1. Build repertoire variants ────────────────────────────────
    const variants = [
      { pgn: '1. e4 e5 2. Nf3', orientation: 'white' as const },
      { pgn: '1. c4 Nf6',       orientation: 'black' as const },
    ];

    // ── 2. Compute user-move card keys ──────────────────────────────
    const whiteUserMoves = userMoveKeysForVariant(variants[0].pgn, 'white');
    const blackUserMoves = userMoveKeysForVariant(variants[1].pgn, 'black');
    const allUserMoves = [...whiteUserMoves, ...blackUserMoves];

    // Identify the three expected cards explicitly for later assertions.
    const e4Card  = whiteUserMoves.find(m => m.san === 'e4')!;
    const nf3Card = whiteUserMoves.find(m => m.san === 'Nf3')!;
    const nf6Card = blackUserMoves.find(m => m.san === 'Nf6')!;
    expect(e4Card, 'e4 user move').toBeDefined();
    expect(nf3Card, 'Nf3 user move').toBeDefined();
    expect(nf6Card, 'Nf6 user move').toBeDefined();

    // ── 3. Pre-rate each card Good 3 times ──────────────────────────
    // Start in the past (real now). Each rating steps forward to the
    // card's scheduled due date so the card transitions through
    // New → Learning → Review.
    const preRateStart = new Date();
    const fsrsSvc = new FSRSService({});
    for (const { fen, san } of allUserMoves) {
      preRateGoodNTimes(fsrsSvc, fen, san, 3, preRateStart);
    }
    const preRatedCards = fsrsSvc.getCards();

    // ── 4. Sanity-check: card keys exactly match the repertoire graph ─
    // If keys mismatch, normalize() → reconcileCards() would silently
    // drop our pre-ratings and recreate the cards as New, invalidating
    // the entire scenario.
    const graphKeys = new Set(
      new RepertoireGraph(variants.map(v => ({ pgn: v.pgn, orientation: v.orientation }))).getCardKeys(),
    );
    const preRatedKeys = new Set(Object.keys(preRatedCards));
    expect(preRatedKeys).toEqual(graphKeys);
    expect(preRatedKeys.size).toBe(3);

    // All three pre-rated cards should be in Review state by now.
    for (const card of Object.values(preRatedCards)) {
      expect(card.st).toBe(State.Review);
      expect(card.lr).toBeDefined();
    }

    // ── 5. Compute page-clock offset so earliest due is 1 hour out ──
    const dues = Object.values(preRatedCards)
      .map(c => FSRSService.computeDueDate(c).getTime());
    const minDueMs = Math.min(...dues);
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const targetPageNowMs = minDueMs - ONE_HOUR_MS;
    const offsetMinutes = (targetPageNowMs - Date.now()) / (60 * 1000);

    // Game timestamp: 30 minutes before page-now. This is well within
    // the 5-day AGE_WINDOW and after every card's lr (lr is days in
    // the past relative to its due, page-now is 1 hour before earliest due).
    const gameCreatedAtMs = targetPageNowMs - 30 * 60 * 1000;

    // Quick sanity: gameCreatedAt must be ≥ every card's lr for
    // shouldApplyRating() to pass.
    for (const card of Object.values(preRatedCards)) {
      const lrMs = new Date(card.lr!).getTime();
      expect(lrMs).toBeLessThanOrEqual(gameCreatedAtMs);
    }

    // ── 6. Build fixture with pre-rated cards and linked account ────
    const fixture = buildRepertoireData(variants, preRatedCards);
    fixture.settings = {
      ...fixture.settings,
      linkedAccounts: [{ platform: 'lichess', username: USERNAME }],
    };

    // ── 7. Wire up mocks (backend + lichess) ────────────────────────
    const { saves } = await setupMockEnvironment(page, fixture, USERNAME);
    const lichess = await setupMockLichess(page, USERNAME);

    // ── 8. Advance page clock ───────────────────────────────────────
    await advanceTime(page, offsetMinutes);

    // ── 9. Navigate to dashboard ────────────────────────────────────
    await page.goto('/#/');

    // ── 10. Wait for the auto-sync widget to settle on "Synced @" ───
    // The sync indicator only renders once syncStatus is set, which
    // happens after the first 'fetching' event fires.
    const syncIndicator = page.locator('.widget-sync-status');
    await expect(syncIndicator).toContainText(/Synced @/, { timeout: 10_000 });

    // Allow a brief window for any StrictMode-driven second auto-sync
    // to also complete (both will see lichess return empty by default).
    await page.waitForTimeout(500);

    // No save should have happened — initial fetches returned empty.
    expect(saves.length, 'no PUT on empty initial sync').toBe(0);

    // Mount-time should have made at least one lichess call.
    const callsAfterMount = lichess.callCount();
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    // ── 11. Arm games and click sync button ─────────────────────────
    const whiteGame = buildLichessGame({
      id: 'white-game-1',
      createdAtMs: gameCreatedAtMs,
      userIsWhite: true,
      moves: 'e4 e5 Nf3',
      username: USERNAME,
    });
    const blackGame = buildLichessGame({
      id: 'black-game-1',
      createdAtMs: gameCreatedAtMs + 1, // distinct timestamp for deterministic ordering
      userIsWhite: false,
      moves: 'c4 c5',
      username: USERNAME,
    });
    lichess.armNext([whiteGame, blackGame]);

    const syncButton = page.getByRole('button', { name: 'Sync games now' });
    await expect(syncButton).toBeEnabled();
    await syncButton.click();

    // ── 12. Wait for the resulting PUT to be captured ───────────────
    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1);

    // Exactly one new lichess call should have been made for the
    // click-triggered sync.
    expect(lichess.callCount()).toBe(callsAfterMount + 1);

    // ── 13. Validate FSRS state in the saved blob ───────────────────
    const savedBody = saves[0].body as {
      fsrsCards: Record<string, FSRSCardData>;
    };
    const savedCards = savedBody.fsrsCards;

    const e4Key  = FSRSService.makeCardKey(e4Card.fen,  e4Card.san);
    const nf3Key = FSRSService.makeCardKey(nf3Card.fen, nf3Card.san);
    const nf6Key = FSRSService.makeCardKey(nf6Card.fen, nf6Card.san);

    const prevE4  = preRatedCards[e4Key];
    const prevNf3 = preRatedCards[nf3Key];
    const prevNf6 = preRatedCards[nf6Key];
    const newE4   = savedCards[e4Key];
    const newNf3  = savedCards[nf3Key];
    const newNf6  = savedCards[nf6Key];

    // Pre-condition: all three cards still exist in the save.
    expect(newE4,  'e4 card present after save').toBeDefined();
    expect(newNf3, 'Nf3 card present after save').toBeDefined();
    expect(newNf6, 'Nf6 card present after save').toBeDefined();

    // ── e4: Good rating from Review state ──────────────────────────
    expect(newE4.st).toBe(State.Review);
    expect(newE4.r).toBe(prevE4.r + 1);
    // Good preserves or increases stability; never resets lapses.
    expect(newE4.l).toBe(prevE4.l);
    expect(newE4.s).toBeGreaterThanOrEqual(prevE4.s);
    // last_review is stamped to the game's createdAt.
    expect(new Date(newE4.lr!).getTime()).toBe(gameCreatedAtMs);
    // New due is anchored at gameCreatedAt + new interval, which must
    // be later than the previous (gameCreatedAt is later than prev lr,
    // and new stability ≥ prev stability).
    const newE4DueMs = FSRSService.computeDueDate(newE4).getTime();
    const prevE4DueMs = FSRSService.computeDueDate(prevE4).getTime();
    expect(newE4DueMs).toBeGreaterThan(gameCreatedAtMs);
    expect(newE4DueMs).toBeGreaterThan(prevE4DueMs);

    // ── Nf3: Good rating from Review state (same shape as e4) ──────
    expect(newNf3.st).toBe(State.Review);
    expect(newNf3.r).toBe(prevNf3.r + 1);
    expect(newNf3.l).toBe(prevNf3.l);
    expect(newNf3.s).toBeGreaterThanOrEqual(prevNf3.s);
    expect(new Date(newNf3.lr!).getTime()).toBe(gameCreatedAtMs);
    const newNf3DueMs = FSRSService.computeDueDate(newNf3).getTime();
    const prevNf3DueMs = FSRSService.computeDueDate(prevNf3).getTime();
    expect(newNf3DueMs).toBeGreaterThan(gameCreatedAtMs);
    expect(newNf3DueMs).toBeGreaterThan(prevNf3DueMs);

    // ── Nf6: Again rating from Review state → Relearning ───────────
    // The black game played c5 instead of Nf6 from the position after
    // 1. c4. GameIngestService rates all sibling cards at that FEN
    // Again — Nf6 is the only one.
    expect(newNf6.st).toBe(State.Relearning);
    expect(newNf6.l).toBe(prevNf6.l + 1);
    // Lapses always increment, regardless of relearning steps.
    // last_review is the game timestamp (black game is +1ms).
    expect(new Date(newNf6.lr!).getTime()).toBe(gameCreatedAtMs + 1);
    // Due is short — roughly gameCreatedAt + relearning step (~10 min,
    // ts-fsrs default). Use a generous tolerance to absorb fuzz/config.
    const newNf6DueMs = new Date(newNf6.d).getTime();
    expect(newNf6DueMs).toBeGreaterThan(gameCreatedAtMs);
    expect(newNf6DueMs - (gameCreatedAtMs + 1)).toBeLessThan(60 * 60 * 1000);

    // ── Activity counters reflect the ingested games ───────────────
    const activity = (savedBody as unknown as { activity?: { practiceLog: Array<{ games?: { ingested: number; reviewed: number; mistakes: number } }> } }).activity;
    expect(activity).toBeDefined();
    const gameDay = activity!.practiceLog.find(e => e.games);
    expect(gameDay, 'practice-log entry with game counters').toBeDefined();
    expect(gameDay!.games!.ingested).toBe(2);
    expect(gameDay!.games!.reviewed).toBe(2);  // white game's e4 and Nf3
    expect(gameDay!.games!.mistakes).toBe(1);  // black game (c5 deviation)
  });
});
