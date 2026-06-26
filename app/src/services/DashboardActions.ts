import { Activity } from '../models/RepertoireData';
import { RepertoireEntry, findRepertoire } from '../models/Repertoires';
import { getAllRecordsNewestFirst } from './GameRecordStore';
import { frozenAnnotationHasIssue } from './GameAnnotationService';

/**
 * Identifiers for the dashboard Actions tile. The list is intentionally
 * small and grows by adding entries here + a branch in
 * `buildDashboardActions`. See `docs/product-specs/DASHBOARD-ACTIONS.md`.
 */
export type DashboardActionId =
    | 'start-training'
    | 'review-games'
    | 'link-account';

export interface DashboardAction {
    id: DashboardActionId;
    /** Visible label; counts are baked in (e.g. "Analyze 3 new games"). */
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
    newGames: number;
    /** Analyzed games with an unreviewed opening mistake. */
    mistakeGames: number;
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
 * The two game states share a single `/games` action (which handles
 * analyze-then-review): ingested-but-unanalyzed ("Analyze N new games") and
 * analyzed-with-an-unreviewed-mistake ("Review K opening mistakes"). When both
 * apply the label surfaces both, joined by "·".
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

    if (input.newGames > 0 || input.mistakeGames > 0) {
        const parts: string[] = [];
        if (input.newGames > 0) {
            parts.push(`Analyze ${input.newGames} new game${input.newGames !== 1 ? 's' : ''}`);
        }
        if (input.mistakeGames > 0) {
            parts.push(`Review ${input.mistakeGames} opening mistake${input.mistakeGames !== 1 ? 's' : ''}`);
        }
        actions.push({
            id: 'review-games',
            label: parts.join(' · '),
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
export function countNewGames(activity: Activity): number {
    return getAllRecordsNewestFirst(activity).filter(r => r.fan === undefined).length;
}

/**
 * Count analyzed games that carry an unreviewed opening mistake — the same
 * "review queue" the Games page surfaces by default (a `fan` with a deviation
 * or EOT eval-drop, not yet marked reviewed via `rv`).
 */
export function countMistakeGames(activity: Activity): number {
    return getAllRecordsNewestFirst(activity).filter(
        r => r.fan !== undefined && r.rv !== 1 && frozenAnnotationHasIssue(r.fan),
    ).length;
}

/**
 * Colors whose repertoire has no positions yet. Drives the dashboard's
 * lower-priority "Import repertoire as PGN" onboarding row: a color is offered
 * for import only while its repertoire is empty, so a user who has already
 * built (say) White is invited to import Black only. A missing repertoire is
 * treated as empty (brand-new account before `normalize` seeds the entries).
 */
export function getEmptyRepertoireColors(
    repertoires: RepertoireEntry[] | undefined,
): ('white' | 'black')[] {
    return (['white', 'black'] as const).filter(color => {
        const rep = findRepertoire(repertoires, color);
        return !rep || Object.keys(rep.positions).length === 0;
    });
}
