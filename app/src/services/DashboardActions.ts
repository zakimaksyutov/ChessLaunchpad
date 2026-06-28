import { Activity } from '../models/RepertoireData';
import { RepertoireEntry, findRepertoire } from '../models/Repertoires';
import { getAllRecordsNewestFirst } from './GameRecordStore';
import { frozenAnnotationHasIssue } from './GameAnnotationService';

/**
 * Identifiers for the dashboard Actions tile. The list is intentionally
 * small and grows by adding entries here + a branch in
 * `buildDashboardActions`. See `docs/product-specs/DASHBOARD.md` §1.5.
 */
export type DashboardActionId =
    | 'bootstrap-repertoire'
    | 'start-training'
    | 'review-games'
    | 'link-account';

/** One line of an always-shown "Why this?" trust list (lead-in label + detail). */
export interface WhyPoint {
    /** Short lead-in label/icon shown in bold at the start of the line. */
    label: string;
    text: string;
}

export interface DashboardAction {
    id: DashboardActionId;
    /** Visible label; counts are baked in (e.g. "Analyze 3 new games"). */
    label: string;
    /** Leading emoji, matching the activity-feed visual language. */
    icon: string;
    /** SPA route the action navigates to. */
    route: string;
    /**
     * Optional onboarding rationale surfaced behind a "(why?)" toggle.
     * Present only when the action benefits from a "what does this buy me?"
     * nudge — currently `link-account` (always) and `review-games` when it
     * leads for a user with no known mistakes yet (a freshly-synced new
     * account). Established users, who already know the value, never see it.
     */
    why?: string;
    /**
     * Optional always-shown "Why this?" trust list, rendered as a short
     * scannable list (one point per line). Used by top-priority onboarding rows
     * whose job is to earn trust before a multi-second, one-time operation —
     * currently `bootstrap-repertoire`.
     */
    whyPoints?: WhyPoint[];
}

/** The always-shown trust list for the repertoire-bootstrap action (DASHBOARD.md §1.5). */
const BOOTSTRAP_WHY_POINTS: WhyPoint[] = [
    { label: 'From your own games', text: 'Built from your real recent openings, not a generic book.' },
    { label: 'Only what you actually play', text: 'The same move in every one of your last several games at that position.' },
    { label: 'Engine-checked', text: 'Every move is verified against a strong engine; unsound moves are dropped.' },
    { label: 'Conservative by design', text: 'When in doubt, a line is left out, so you start from a clean base you can rely on.' },
    { label: 'You approve it', text: 'Nothing is saved until you review the result.' },
];

export interface DashboardActionInput {
    /** Cards due for review right now (new + due learning/review). */
    dueNow: number;
    /** Ingested games not yet analyzed (records without a frozen annotation). */
    newGames: number;
    /** Analyzed games with an unreviewed opening mistake. */
    mistakeGames: number;
    /** Number of linked Lichess / Chess.com accounts. */
    linkedAccountsCount: number;
    /**
     * Colors whose repertoire is still empty. Drives the top-priority
     * "Build your starter repertoire from your games" row. Defaults to none.
     */
    emptyRepertoireColors?: ('white' | 'black')[];
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

    // Top priority: a user with an empty repertoire has nothing else to do, and
    // building a trusted starter from their own games outranks everything. Gated
    // on having a linked account (the source of the games) — without one the
    // "Link a chess account" row below leads instead. Targets the empty color(s);
    // the bootstrap page re-derives which. See DASHBOARD.md §1.5.
    const emptyColors = input.emptyRepertoireColors ?? [];
    if (emptyColors.length > 0 && input.linkedAccountsCount > 0) {
        const onlyColor = emptyColors.length === 1 ? emptyColors[0] : null;
        const colorLabel = onlyColor === 'white' ? 'White ' : onlyColor === 'black' ? 'Black ' : '';
        actions.push({
            id: 'bootstrap-repertoire',
            label: `Build your ${colorLabel}starter repertoire from your games`,
            icon: '🌱',
            route: '/bootstrap',
            whyPoints: BOOTSTRAP_WHY_POINTS,
        });
    }

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
        const reviewGames: DashboardAction = {
            id: 'review-games',
            label: parts.join(' · '),
            icon: '⚔️',
            route: '/games',
        };
        // Explain the value of analysis when it *leads* (nothing due) for a
        // user who has no surfaced mistakes yet — typically a new account that
        // just synced games and may not know what "Analyze" actually does.
        // Once a mistake exists, "Review opening mistakes" is self-explanatory.
        if (input.dueNow === 0 && input.mistakeGames === 0) {
            reviewGames.why =
                'We check your recent games for opening mistakes and suggest lines to add — the quickest way to grow a repertoire from games you\'ve actually played.';
        }
        actions.push(reviewGames);
    }

    if (input.linkedAccountsCount === 0) {
        actions.push({
            id: 'link-account',
            label: 'Link a chess account',
            icon: '🔗',
            route: '/settings',
            why: 'Linking Lichess or Chess.com lets us download your games automatically and check them for opening mistakes — no manual entry.',
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
 * Colors whose repertoire has no moves yet. Drives the dashboard's
 * lower-priority "Import repertoire as PGN" onboarding row: a color is offered
 * for import only while its repertoire is empty, so a user who has already
 * built (say) White is invited to import Black only. A missing repertoire is
 * treated as empty (brand-new account before `normalize` seeds the entries).
 *
 * Emptiness is "no edges", not "no position objects": deleting every move in
 * Edit mode leaves a residual moves-less root behind (`deleteEdge` never prunes
 * the start position, and the codec round-trips it), so a positions-count check
 * would wrongly treat a cleared repertoire as non-empty and suppress the
 * bootstrap/import onboarding rows forever.
 */
export function getEmptyRepertoireColors(
    repertoires: RepertoireEntry[] | undefined,
): ('white' | 'black')[] {
    return (['white', 'black'] as const).filter(color => {
        const rep = findRepertoire(repertoires, color);
        return !rep || Object.values(rep.positions).every(p => Object.keys(p.moves).length === 0);
    });
}
