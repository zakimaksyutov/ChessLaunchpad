import { Activity } from '../models/RepertoireData';
import { getAllRecordsNewestFirst } from './GameRecordStore';

/**
 * Identifiers for the dashboard Actions tile. The list is intentionally
 * small and grows by adding entries here + a branch in
 * `buildDashboardActions`. See `docs/product-specs/DASHBOARD-ACTIONS.md`.
 */
export type DashboardActionId = 'start-training' | 'review-games' | 'link-account';

export interface DashboardAction {
    id: DashboardActionId;
    /** Visible label; counts are baked in (e.g. "Review 7 games"). */
    label: string;
    /** Leading emoji, matching the activity-feed visual language. */
    icon: string;
    /** SPA route the action navigates to. */
    route: string;
}

export interface DashboardActionInput {
    /** Cards due for review right now (new + due learning/review). */
    dueNow: number;
    /** Ingested games not yet analyzed (records without a frozen annotation). */
    unanalyzedGames: number;
    /** Number of linked Lichess / Chess.com accounts. */
    linkedAccountsCount: number;
}

/**
 * Build the ordered list of dashboard actions for the current user state.
 *
 * The first entry is the primary (most prominent) action — Start Training
 * leads whenever cards are due, otherwise the most useful onboarding step
 * takes its place. An empty result means "all caught up" and the tile shows
 * a positive empty state instead.
 *
 * Start Training keys off `dueNow` rather than merely owning a repertoire:
 * training ahead of schedule works against FSRS spacing, so when nothing is
 * due the action steps aside and the empty state can surface.
 *
 * Ordering/capping beyond this simple precedence is intentionally deferred
 * (see the spec); for now every applicable action is returned.
 */
export function buildDashboardActions(input: DashboardActionInput): DashboardAction[] {
    const actions: DashboardAction[] = [];

    if (input.dueNow > 0) {
        actions.push({
            id: 'start-training',
            label: `Start Training (${input.dueNow} due)`,
            icon: '🎯',
            route: '/training',
        });
    }

    if (input.unanalyzedGames > 0) {
        actions.push({
            id: 'review-games',
            label: `Review ${input.unanalyzedGames} game${input.unanalyzedGames !== 1 ? 's' : ''}`,
            icon: '⚔️',
            route: '/games',
        });
    }

    if (input.linkedAccountsCount === 0) {
        actions.push({
            id: 'link-account',
            label: 'Link a chess account',
            icon: '🔗',
            route: '/settings',
        });
    }

    return actions;
}

/** Count ingested game records still lacking a frozen annotation (`fan`). */
export function countUnanalyzedGames(activity: Activity): number {
    return getAllRecordsNewestFirst(activity).filter(r => r.fan === undefined).length;
}
