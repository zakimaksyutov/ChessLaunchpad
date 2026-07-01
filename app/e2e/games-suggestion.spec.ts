import { test, expect, type Page } from '@playwright/test';
import { Chess } from 'chess.js';
import {
  buildRepertoireData,
  setupMockEnvironment,
  setupMockLichess,
  setupLichessToken,
  setupMockMasters,
  setupMockCloudEval,
  type CapturedSave,
  type MastersMockMove,
} from './helpers';
import { type GameRecord, type Activity } from '../src/models/RepertoireData';

/**
 * E2E coverage for the /games "Suggest a fix" feature (Repertoire Suggestion,
 * `GameRecord.sg`). The move-scoring algorithm itself is unit-tested
 * (`GameSuggestionService.test.ts`); these tests pin the *UI integration* the
 * unit tests can't reach:
 *
 *   - The link shows on EOT rows and not on deviation rows, and the OAuth gate
 *     (no Lichess token → connect prompt) fires on click.
 *   - A click with a token computes a line from mocked masters/cloud-eval,
 *     renders the corrected PGN, and persists `sg` to the blob.
 *   - A saved `sg` hydrates on reload (hiding the link), drives the
 *     Add-to-repertoire deep link, and the "Already exists" / "Added"
 *     confirmations render from the persisted flags.
 *
 * All game rows are seeded as **frozen** records (`fan` present) so the page's
 * analysis pass skips them — no masters traffic happens except the deliberate
 * "Suggest a fix" click, keeping the mocks tight.
 */

const USERNAME = 'testuser';
const OPPONENT = 'rival';
const DAY = '2026-06-20';

/** White Ruy Lopez up to 3.Bb5 — the user's repertoire for these tests. */
const REPERTOIRE = [{ pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5', orientation: 'white' as const }];

/** 4-field FEN cache key (placement + side + castling + ep) after `moves`. */
function fenKey(moves: string[]): string {
  const c = new Chess();
  for (const m of moves) c.move(m);
  return c.fen().split(' ').slice(0, 4).join(' ');
}

// The three positions the suggestion walk queries for the EOT game below
// (1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6). Bxc6 is deliberately absent from the
// Top-5 at P1, forcing the "off-book → substitute + close out at depth 1" path.
const P1 = fenKey(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);          // before user's 4th
const P2 = fenKey(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4']);  // opponent reply
const P3 = fenKey(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6']); // best next user move

// Masters Top-N per position. Ba4 / O-O dominate on games *and* win-margin so
// the scorer's pick is deterministic with eval-missing (cloud-eval 404) across
// the board; the second move only exists to make it a real Top-N choice.
const MASTERS: Record<string, MastersMockMove[]> = {
  [P1]: [
    { san: 'Ba4', white: 800, draws: 150, black: 50 },
    { san: 'Bc4', white: 30, draws: 40, black: 30 },
  ],
  [P2]: [
    { san: 'Nf6', white: 100, draws: 100, black: 100 },
    { san: 'b5', white: 50, draws: 50, black: 50 },
  ],
  [P3]: [
    { san: 'O-O', white: 900, draws: 50, black: 50 },
    { san: 'd3', white: 40, draws: 30, black: 30 },
  ],
};

/** The suggested line the walk produces for the EOT game (move 4 corrected). */
const SUGGESTED_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O';

let recordSeq = 0;

/** A white-user Lichess record with a pre-frozen annotation. */
function record(id: string, moves: string, fan: GameRecord['fan'], sg?: GameRecord['sg']): GameRecord {
  recordSeq += 1;
  const r: GameRecord = {
    id,
    p: 'l',
    t: Date.parse(`${DAY}T12:00:00Z`) - recordSeq * 1000,
    m: moves,
    wa: USERNAME,
    wr: 1500,
    ba: OPPONENT,
    br: 1500,
    res: 'loss',
    tc: '5+3',
    sp: 'blitz',
    rt: 1,
    o: 'Ruy Lopez',
    fan,
  };
  if (sg) r.sg = sg;
  return r;
}

/**
 * EOT mistake: user follows the repertoire, opponent leaves it with 3...a6
 * (sound), and the user's 4.Bxc6 is a mistake. `hl` = [in-rep, in-rep, in-rep,
 * mistake] over the four white moves; no deviation code, so the row renders as
 * EOT (offering "Suggest a fix"), not a deviation.
 */
function eotRecord(id: string, sg?: GameRecord['sg']): GameRecord {
  return record(id, 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6', { hl: [0, 0, 0, 4], mb: 6 }, sg);
}

/**
 * EOT mistake where the fix diverges *before* the flagged move (Case 2): the
 * user's 4.Ba4 is a sound-but-weaker post-theory move (code 2) and 5.Bb3 is the
 * flagged mistake (code 4). A suggestion that corrects 4.Ba4 diverges at ply 6,
 * before the mistake at ply 8, so the pivot section is extended to span
 * [Ba4 … Bb3] and the suggestion shows an explainer.
 */
function eotEarlyRecord(id: string, sg?: GameRecord['sg']): GameRecord {
  return record(id, 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 b5 Bb3', { hl: [0, 0, 0, 2, 4], mb: 8 }, sg);
}

/**
 * EOT mistake whose frozen window stops at the flagged move (4.Bxc6, ply 6),
 * but the game continues (…dxc6 Nc3). Used with a suggestion that keeps the
 * flagged move and diverges *later* (Case 3), so the replaced move sits outside
 * the rendered sections and must be named inline by the suggestion.
 */
function eotKeptRecord(id: string, sg?: GameRecord['sg']): GameRecord {
  return record(id, 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 Nc3', { hl: [0, 0, 0, 4], mb: 6 }, sg);
}

/** Deviation mistake: user plays 3.Bc4 instead of the repertoire's 3.Bb5. */
function deviationRecord(id: string): GameRecord {
  return record(id, 'e4 e5 Nf3 Nc6 Bc4', { hl: [0, 0, 1], alt: ['Bb5'], mb: 4 });
}

function activityWith(records: GameRecord[]): Activity {
  return {
    practiceLog: [
      {
        date: DAY,
        reviewed: 0,
        mistakes: records.length,
        learned: 0,
        traversals: 0,
        timeSeconds: 0,
        games: { ingested: records.length, reviewed: 0, mistakes: records.length, records },
      },
    ],
    lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
  };
}

/** Build a v3 fixture blob: repertoire + a linked Lichess account + records. */
function fixtureWith(records: GameRecord[]) {
  const fixture = buildRepertoireData(REPERTOIRE);
  fixture.settings = {
    ...fixture.settings,
    linkedAccounts: [{ platform: 'lichess', username: USERNAME }],
  };
  fixture.activity = activityWith(records);
  return fixture;
}

/** Open /games, settle the (empty) auto-sync, and switch to the "All games" view. */
async function openGames(page: Page) {
  await page.goto('/#/games');
  await expect(page.locator('.game-row').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /All games/ }).click();
}

/** The `.game-row` that reached end-of-theory with an eval-drop mistake. */
function eotRow(page: Page) {
  return page.locator('.game-row[class*="game-row-eot-"]');
}

test.describe('Games — Suggest a fix', () => {
  test('shows the link on EOT rows (not deviation rows) and gates on a Lichess connection', async ({ page }) => {
    const fixture = fixtureWith([eotRecord('eot1'), deviationRecord('dev1')]);
    await setupMockEnvironment(page, fixture, USERNAME);
    await setupMockLichess(page, USERNAME); // empty sync; no token seeded

    await openGames(page);

    // EOT row offers "Suggest a fix"; the deviation row does not.
    const eot = eotRow(page);
    await expect(eot).toHaveCount(1);
    await expect(eot.locator('.suggest-fix-link')).toBeVisible();

    const deviation = page.locator('.game-row.game-row-deviation');
    await expect(deviation).toHaveCount(1);
    await expect(deviation.locator('.suggest-fix-link')).toHaveCount(0);

    // No Lichess token → clicking prompts to connect rather than computing.
    await eot.locator('.suggest-fix-link').click();
    const connect = eot.locator('.suggest-fix-connect');
    await expect(connect).toBeVisible();
    await expect(connect).toContainText('Connect Lichess');
    await expect(eot.locator('.suggest-fix-ready')).toHaveCount(0);
  });

  test('computes, renders and persists a suggested fix when connected', async ({ page }) => {
    const fixture = fixtureWith([eotRecord('eot1')]);
    const { saves } = await setupMockEnvironment(page, fixture, USERNAME);
    await setupMockLichess(page, USERNAME);
    await setupLichessToken(page);
    const masters = await setupMockMasters(page, MASTERS);
    await setupMockCloudEval(page);

    await openGames(page);

    const eot = eotRow(page);
    await eot.locator('.suggest-fix-link').click();

    // The compute path walks masters (rate-limited ~1 req/s) before resolving.
    const ready = eot.locator('.suggest-fix-ready');
    await expect(ready).toBeVisible({ timeout: 20_000 });

    // The suggestion shows only the corrected delta (not the replayed prefix):
    // Ba4 is the bold corrected move, followed by its short continuation. The
    // replaced move (Bxc6) is named by the red "Mistake" section above.
    const pgn = ready.locator('.suggest-fix-pgn');
    await expect(pgn).toContainText('Ba4');
    await expect(pgn).toContainText('O-O');
    await expect(pgn).not.toContainText('Bxc6');
    const newMove = ready.locator('.suggest-fix-new').first();
    await expect(newMove).toHaveText('Ba4');
    await expect(eot.locator('.game-section-pivot')).toContainText('Bxc6');
    // Case 1 (fix diverges at the flagged move): no earlier-divergence explainer.
    await expect(ready.locator('.suggest-fix-explainer')).toHaveCount(0);

    // Add-to-repertoire is offered (the line isn't already in the repertoire).
    await expect(ready.getByRole('link', { name: 'Add to repertoire' })).toBeVisible();

    // The masters explorer was actually consulted for the three walked positions.
    expect(masters.queriedKeys()).toEqual(expect.arrayContaining([P1, P2, P3]));

    // The result is persisted as `sg` on the record so it survives reloads.
    await expect
      .poll(() => (findSavedRecord(saves, 'eot1')?.sg ? true : false), { timeout: 10_000 })
      .toBe(true);
    const saved = findSavedRecord(saves, 'eot1')!.sg!;
    expect(saved.ply).toBe(6);
    expect(saved.rep).toBe('Bxc6');
    expect(saved.pgn).toBe(SUGGESTED_PGN);
    expect(saved.pl.some(p => p.s === 'Ba4' && p.n === 1)).toBe(true);
  });

  test('hydrates a saved suggestion on reload, hides the link, and deep-links Add-to-repertoire', async ({ page }) => {
    const sg = {
      ply: 6,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5' }, { s: 'Nf3', r: 1 as const }, { s: 'Nc6' },
        { s: 'Bb5', r: 1 as const }, { s: 'a6' },
        { s: 'Ba4', n: 1 as const }, { s: 'Nf6', n: 1 as const }, { s: 'O-O', n: 1 as const },
      ],
      pgn: SUGGESTED_PGN,
      epgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 (4. Bxc6) Nf6 5. O-O',
      rep: 'Bxc6',
      at: Date.now(),
    };
    const fixture = fixtureWith([eotRecord('eot1', sg)]);
    await setupMockEnvironment(page, fixture, USERNAME);
    await setupMockLichess(page, USERNAME);

    await openGames(page);

    const eot = eotRow(page);
    const ready = eot.locator('.suggest-fix-ready');
    // Saved suggestion shows immediately; the "Suggest a fix" link is hidden.
    await expect(ready).toBeVisible();
    await expect(ready.locator('.suggest-fix-pgn')).toContainText('Ba4');
    await expect(eot.locator('.game-section-pivot')).toContainText('Bxc6');
    await expect(eot.locator('.suggest-fix-link')).toHaveCount(0);

    // "Add to repertoire" deep-links into the Explorer review/save flow.
    await ready.getByRole('link', { name: 'Add to repertoire' }).click();
    await expect(page).toHaveURL(/#\/explorer\?/);
    const hash = new URL(page.url()).hash;
    expect(hash).toContain('from=games');
    expect(hash).toContain('addpgn=');
    expect(decodeURIComponent(hash)).toContain('Ba4');
  });

  test('hydrates an early-divergence (Case 2) fix: extends the pivot section and shows the explainer', async ({ page }) => {
    // The fix corrects 4.Ba4 (ply 6) though the flagged mistake is 5.Bb3 (ply 8).
    const sg = {
      ply: 8,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5' }, { s: 'Nf3', r: 1 as const }, { s: 'Nc6' },
        { s: 'Bb5', r: 1 as const }, { s: 'a6' },
        { s: 'Bxc6', n: 1 as const }, { s: 'dxc6', n: 1 as const }, { s: 'O-O', n: 1 as const },
      ],
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O',
      rep: 'Ba4',
      at: Date.now(),
    };
    await setupMockEnvironment(page, fixtureWith([eotEarlyRecord('eot1', sg)]), USERNAME);
    await setupMockLichess(page, USERNAME);

    await openGames(page);

    const eot = eotRow(page);
    const ready = eot.locator('.suggest-fix-ready');
    await expect(ready).toBeVisible();

    // The red "Mistake" section absorbs the whole problem span [Ba4 … Bb3].
    const pivot = eot.locator('.game-section-pivot');
    await expect(pivot).toContainText('Ba4');
    await expect(pivot).toContainText('Bb3');

    // The suggestion shows only the corrected delta (Bxc6 …), not the mistake,
    // plus an explainer naming the earlier move it improves on.
    await expect(ready.locator('.suggest-fix-explainer')).toContainText('Ba4');
    await expect(ready.locator('.suggest-fix-pgn')).toContainText('Bxc6');
    await expect(ready.locator('.suggest-fix-pgn')).not.toContainText('Bb3');
  });

  test('names the replaced move inline when the fix diverges after the flagged move (Case 3)', async ({ page }) => {
    // Flagged mistake = 4.Bxc6 (ply 6, end of the frozen window). The fix keeps
    // it and corrects a later move, 5.Nc3 (ply 8) — outside the window, so no
    // section shows it and the suggestion must name it inline.
    const sg = {
      ply: 6,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5' }, { s: 'Nf3', r: 1 as const }, { s: 'Nc6' },
        { s: 'Bb5', r: 1 as const }, { s: 'a6' }, { s: 'Bxc6' }, { s: 'dxc6' },
        { s: 'O-O', n: 1 as const }, { s: 'Nf6', n: 1 as const },
      ],
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O Nf6',
      rep: 'Nc3',
      at: Date.now(),
    };
    await setupMockEnvironment(page, fixtureWith([eotKeptRecord('eot1', sg)]), USERNAME);
    await setupMockLichess(page, USERNAME);

    await openGames(page);

    const eot = eotRow(page);
    const ready = eot.locator('.suggest-fix-ready');
    await expect(ready).toBeVisible();

    // The pivot section still shows only the flagged move (no backward extension);
    // the replaced move (Nc3) is outside the window, so it isn't in any section.
    const pivot = eot.locator('.game-section-pivot');
    await expect(pivot).toContainText('Bxc6');
    await expect(pivot).not.toContainText('Nc3');

    // The inline context line names the replaced move; the delta shows the fix.
    const context = ready.locator('.suggest-fix-explainer');
    await expect(context).toContainText('Instead of');
    await expect(context).toContainText('Nc3');
    await expect(ready.locator('.suggest-fix-pgn')).toContainText('O-O');
  });

  /**
   * The /games "Add to repertoire" deep-link reaches the Review pane via a URL
   * *replace* (no Explorer main-Edit history entry sits beneath it). The back
   * control must therefore NOT call history.back() (that would overshoot to
   * /games and drop the staged line); instead it relabels to "Continue
   * editing" and drops the user onto the Explorer Edit board at the parent of
   * the first added position, with the staged line intact. Discard stays the
   * explicit path back to /games (covered by the next test).
   */
  test('Review "Continue editing" stays on Explorer (does not bounce to /games) with edits intact', async ({ page }) => {
    const sg = {
      ply: 6,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5' }, { s: 'Nf3', r: 1 as const }, { s: 'Nc6' },
        { s: 'Bb5', r: 1 as const }, { s: 'a6' },
        { s: 'Ba4', n: 1 as const }, { s: 'Nf6', n: 1 as const }, { s: 'O-O', n: 1 as const },
      ],
      pgn: SUGGESTED_PGN,
      epgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 (4. Bxc6) Nf6 5. O-O',
      rep: 'Bxc6',
      at: Date.now(),
    };
    await setupMockEnvironment(page, fixtureWith([eotRecord('eot1', sg)]), USERNAME);
    await setupMockLichess(page, USERNAME);
    await openGames(page);

    await eotRow(page).locator('.suggest-fix-ready')
      .getByRole('link', { name: 'Add to repertoire' }).click();

    // The deep-link lands on the Explorer Review pane.
    const review = page.locator('.explorer-review');
    await expect(review).toBeVisible();
    // The back control is relabelled for the games flow.
    const back = review.getByRole('button', { name: /continue editing/i });
    await expect(back).toBeVisible();
    await back.click();

    // Stays on /explorer (NOT /games), drops the review flag, and jumps the
    // board to the parent of the first added position (the repertoire tip).
    await expect(page).toHaveURL(/#\/explorer\?/);
    const hash = decodeURIComponent(new URL(page.url()).hash);
    expect(hash).not.toContain('review=1');
    const parent = new Chess();
    ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'].forEach(m => parent.move(m));
    expect(hash).toContain(parent.fen().split(' ')[0]);

    // Still in Edit mode with the staged line intact.
    const saveBar = page.locator('.explorer-save-bar');
    await expect(saveBar).toBeVisible();
    await expect(saveBar.locator('.explorer-save-bar-counts')).toContainText('added');
  });

  test('Review "Discard" from the /games flow returns to /games', async ({ page }) => {
    const sg = {
      ply: 6,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5' }, { s: 'Nf3', r: 1 as const }, { s: 'Nc6' },
        { s: 'Bb5', r: 1 as const }, { s: 'a6' },
        { s: 'Ba4', n: 1 as const }, { s: 'Nf6', n: 1 as const }, { s: 'O-O', n: 1 as const },
      ],
      pgn: SUGGESTED_PGN,
      epgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 (4. Bxc6) Nf6 5. O-O',
      rep: 'Bxc6',
      at: Date.now(),
    };
    await setupMockEnvironment(page, fixtureWith([eotRecord('eot1', sg)]), USERNAME);
    await setupMockLichess(page, USERNAME);
    await openGames(page);

    await eotRow(page).locator('.suggest-fix-ready')
      .getByRole('link', { name: 'Add to repertoire' }).click();

    const review = page.locator('.explorer-review');
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: 'Discard', exact: true }).click();

    // Non-empty delta ⇒ confirmation prompt; confirming returns to /games.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page).toHaveURL(/#\/games/);
  });

  test('renders the "already exists" and "added" confirmations from persisted flags', async ({ page }) => {
    // Whole suggested line already in the repertoire (every ply flagged `r`) →
    // nothing to add.
    const fullyInRep = {
      ply: 6,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5', r: 1 as const }, { s: 'Nf3', r: 1 as const },
        { s: 'Nc6', r: 1 as const }, { s: 'Bb5', r: 1 as const }, { s: 'a6', r: 1 as const },
        { s: 'Ba4', r: 1 as const },
      ],
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4',
      at: Date.now(),
    };
    // Already committed to the repertoire (`ap`) → sticky "Added" confirmation.
    const added = {
      ply: 6,
      pl: [
        { s: 'e4', r: 1 as const }, { s: 'e5' }, { s: 'Nf3', r: 1 as const }, { s: 'Nc6' },
        { s: 'Bb5', r: 1 as const }, { s: 'a6' }, { s: 'Ba4', n: 1 as const },
      ],
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4',
      rep: 'Bxc6',
      at: Date.now(),
      ap: 1 as const,
    };
    const fixture = fixtureWith([eotRecord('exists1', fullyInRep), eotRecord('added1', added)]);
    await setupMockEnvironment(page, fixture, USERNAME);
    await setupMockLichess(page, USERNAME);

    await openGames(page);

    await expect(page.locator('.suggest-fix-added', { hasText: 'Already exists in the repertoire' })).toBeVisible();
    await expect(page.locator('.suggest-fix-added', { hasText: 'Added to repertoire' })).toBeVisible();
    // Neither row offers the live "Add to repertoire" action.
    await expect(page.getByRole('link', { name: 'Add to repertoire' })).toHaveCount(0);
  });
});

/** Find the latest persisted copy of a record by id across captured saves. */
function findSavedRecord(saves: CapturedSave[], id: string): GameRecord | undefined {
  for (let i = saves.length - 1; i >= 0; i--) {
    const activity = (saves[i].body as { activity?: Activity }).activity;
    if (!activity) continue;
    for (const day of activity.practiceLog) {
      const rec = day.games?.records?.find(r => r.id === id);
      if (rec) return rec;
    }
  }
  return undefined;
}
