import { describe, it, expect } from 'vitest';
import {
    buildDashboardActions,
    countUnanalyzedGames,
    DashboardActionInput,
} from './DashboardActions';
import { appendGameRecord } from './GameRecordStore';
import { Activity, GameRecord, FrozenAnnotation } from '../models/RepertoireData';

function input(overrides: Partial<DashboardActionInput> = {}): DashboardActionInput {
    return {
        dueNow: 0,
        unanalyzedGames: 0,
        linkedAccountsCount: 1,
        ...overrides,
    };
}

describe('buildDashboardActions', () => {
    it('returns no actions when nothing applies (all caught up)', () => {
        expect(buildDashboardActions(input({ dueNow: 0, unanalyzedGames: 0, linkedAccountsCount: 1 }))).toHaveLength(0);
    });

    it('omits Start Training when nothing is due', () => {
        const actions = buildDashboardActions(input({ dueNow: 0, unanalyzedGames: 2 }));
        expect(actions.find(a => a.id === 'start-training')).toBeUndefined();
    });

    it('includes Start Training with the due count when cards are due', () => {
        const actions = buildDashboardActions(input({ dueNow: 4 }));
        const start = actions.find(a => a.id === 'start-training');
        expect(start).toMatchObject({ label: 'Start Training (4 due)', route: '/training' });
    });

    it('makes Start Training the primary (first) action when present', () => {
        const actions = buildDashboardActions(input({ dueNow: 2, unanalyzedGames: 3 }));
        expect(actions[0].id).toBe('start-training');
    });

    it('promotes Review games to primary for a new user with nothing due', () => {
        const actions = buildDashboardActions(input({ dueNow: 0, unanalyzedGames: 7 }));
        expect(actions[0]).toMatchObject({ id: 'review-games', label: 'Review 7 games', route: '/games' });
    });

    it('singularizes the game count', () => {
        const actions = buildDashboardActions(input({ unanalyzedGames: 1 }));
        expect(actions.find(a => a.id === 'review-games')?.label).toBe('Review 1 game');
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

describe('countUnanalyzedGames', () => {
    const FAN = {} as FrozenAnnotation;

    function makeRecord(id: string, t: number, fan?: FrozenAnnotation): GameRecord {
        return { id, t, m: 'e4 e5', wa: 'me', ba: 'opp', res: 'draw', rt: 1, p: 'l', ...(fan ? { fan } : {}) };
    }

    it('counts only records lacking a frozen annotation', () => {
        const activity: Activity = {
            practiceLog: [],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        };
        appendGameRecord(activity, makeRecord('a', 1000));        // un-analyzed
        appendGameRecord(activity, makeRecord('b', 2000, FAN));   // analyzed
        appendGameRecord(activity, makeRecord('c', 3000));        // un-analyzed

        expect(countUnanalyzedGames(activity)).toBe(2);
    });

    it('returns 0 with no records', () => {
        const activity: Activity = {
            practiceLog: [],
            lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
        };
        expect(countUnanalyzedGames(activity)).toBe(0);
    });
});
