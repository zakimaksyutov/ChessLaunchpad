import { describe, it, expect } from 'vitest';
import {
    buildDashboardActions,
    countNewGames,
    countMistakeGames,
    getEmptyRepertoireColors,
    DashboardActionInput,
} from './DashboardActions';
import { appendGameRecord } from './GameRecordStore';
import { Activity, GameRecord, FrozenAnnotation } from '../models/RepertoireData';
import { RepertoireEntry, createEmptyRepertoires } from '../models/Repertoires';

function input(overrides: Partial<DashboardActionInput> = {}): DashboardActionInput {
    return {
        dueNow: 0,
        newGames: 0,
        mistakeGames: 0,
        linkedAccountsCount: 1,
        ...overrides,
    };
}

describe('buildDashboardActions', () => {
    it('returns no actions when nothing applies (all caught up)', () => {
        expect(buildDashboardActions(input())).toHaveLength(0);
    });

    it('omits Start Training when nothing is due', () => {
        const actions = buildDashboardActions(input({ newGames: 2 }));
        expect(actions.find(a => a.id === 'start-training')).toBeUndefined();
    });

    it('includes Start Training with the due count when cards are due', () => {
        const actions = buildDashboardActions(input({ dueNow: 4 }));
        expect(actions.find(a => a.id === 'start-training')).toMatchObject({
            label: 'Start Training (4 due)',
            route: '/training',
        });
    });

    it('makes Start Training the primary (first) action when present', () => {
        const actions = buildDashboardActions(input({ dueNow: 2, newGames: 3, mistakeGames: 1 }));
        expect(actions[0].id).toBe('start-training');
    });

    it('merges the two game states into one /games action', () => {
        const actions = buildDashboardActions(input({ newGames: 3, mistakeGames: 2 }));
        const gameActions = actions.filter(a => a.id === 'review-games');
        expect(gameActions).toHaveLength(1);
        expect(gameActions[0].route).toBe('/games');
    });

    it('surfaces both game states in the merged label when both apply', () => {
        const actions = buildDashboardActions(input({ newGames: 3, mistakeGames: 2 }));
        expect(actions.find(a => a.id === 'review-games')?.label)
            .toBe('Analyze 3 new games · Review 2 opening mistakes');
    });

    it('shows only Analyze when there are no mistakes to review', () => {
        const actions = buildDashboardActions(input({ newGames: 3, mistakeGames: 0 }));
        expect(actions.find(a => a.id === 'review-games')?.label).toBe('Analyze 3 new games');
    });

    it('shows only Review when there are no new games', () => {
        const actions = buildDashboardActions(input({ newGames: 0, mistakeGames: 2 }));
        expect(actions.find(a => a.id === 'review-games')?.label).toBe('Review 2 opening mistakes');
    });

    it('singularizes both game-state labels', () => {
        expect(buildDashboardActions(input({ newGames: 1 })).find(a => a.id === 'review-games')?.label)
            .toBe('Analyze 1 new game');
        expect(buildDashboardActions(input({ mistakeGames: 1 })).find(a => a.id === 'review-games')?.label)
            .toBe('Review 1 opening mistake');
    });

    it('offers Link a chess account when no accounts are linked', () => {
        const actions = buildDashboardActions(input({ linkedAccountsCount: 0 }));
        expect(actions).toContainEqual(
            expect.objectContaining({ id: 'link-account', route: '/settings' }),
        );
    });

    it('does not offer Link account when an account is already linked', () => {
        const actions = buildDashboardActions(input({ linkedAccountsCount: 2 }));
        expect(actions.find(a => a.id === 'link-account')).toBeUndefined();
    });
});

function emptyActivity(): Activity {
    return {
        practiceLog: [],
        lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
    };
}

function makeRecord(
    id: string,
    t: number,
    extra: Partial<GameRecord> = {},
): GameRecord {
    return { id, t, m: 'e4 e5', wa: 'me', ba: 'opp', res: 'draw', rt: 1, p: 'l', ...extra };
}

/** `fan` whose `hl` carries the given user-move codes. */
function fanWith(...codes: number[]): FrozenAnnotation {
    return { hl: codes, mb: 0 };
}

describe('countNewGames', () => {
    it('counts only records lacking a frozen annotation', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord('a', 1000));                       // new
        appendGameRecord(activity, makeRecord('b', 2000, { fan: fanWith(0) }));  // analyzed
        appendGameRecord(activity, makeRecord('c', 3000));                       // new
        expect(countNewGames(activity)).toBe(2);
    });

    it('returns 0 with no records', () => {
        expect(countNewGames(emptyActivity())).toBe(0);
    });
});

describe('countMistakeGames', () => {
    it('counts analyzed, unreviewed games with a deviation or eval-drop issue', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord('clean', 1000, { fan: fanWith(0, 2) }));      // no issue
        appendGameRecord(activity, makeRecord('deviation', 2000, { fan: fanWith(0, 1) }));  // issue (deviation)
        appendGameRecord(activity, makeRecord('blunder', 3000, { fan: fanWith(2, 5) }));    // issue (eval drop)
        appendGameRecord(activity, makeRecord('unanalyzed', 4000));                          // no fan → not counted
        expect(countMistakeGames(activity)).toBe(2);
    });

    it('excludes games already marked reviewed', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord('reviewed', 1000, { fan: fanWith(1), rv: 1 }));
        appendGameRecord(activity, makeRecord('unreviewed', 2000, { fan: fanWith(1) }));
        expect(countMistakeGames(activity)).toBe(1);
    });

    it('returns 0 when no analyzed game has an issue', () => {
        const activity = emptyActivity();
        appendGameRecord(activity, makeRecord('clean', 1000, { fan: fanWith(0, 0, 7) }));
        expect(countMistakeGames(activity)).toBe(0);
    });
});

function withMove(rep: RepertoireEntry): RepertoireEntry {
    return {
        ...rep,
        positions: { 'fen-root': { moves: { e4: {} } } },
    };
}

describe('getEmptyRepertoireColors', () => {
    it('treats a brand-new (both-empty) repertoire as both colors importable', () => {
        expect(getEmptyRepertoireColors(createEmptyRepertoires())).toEqual(['white', 'black']);
    });

    it('treats missing repertoires (undefined) as both colors importable', () => {
        expect(getEmptyRepertoireColors(undefined)).toEqual(['white', 'black']);
    });

    it('offers only the empty color once the other has positions', () => {
        const [white, black] = createEmptyRepertoires();
        expect(getEmptyRepertoireColors([withMove(white), black])).toEqual(['black']);
        expect(getEmptyRepertoireColors([white, withMove(black)])).toEqual(['white']);
    });

    it('offers nothing once both colors have positions', () => {
        const [white, black] = createEmptyRepertoires();
        expect(getEmptyRepertoireColors([withMove(white), withMove(black)])).toEqual([]);
    });
});
