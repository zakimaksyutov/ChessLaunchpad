import { RepertoireData, Activity } from '../models/RepertoireData';
import { RepertoireEntry, findRepertoire } from '../models/Repertoires';
import { countMistakeGames, countNewGames } from './DashboardActions';
import {
    findEntryByDate,
    getBestStreak,
    getCurrentStreak,
    getTodayDateString,
} from './ActivityService';

const EMPTY_ACTIVITY: Activity = {
    practiceLog: [],
    lifetime: { reviewed: 0, mistakes: 0, learned: 0, traversals: 0, timeSeconds: 0 },
};

/** Count the FSRS cards (user-turn moves) in a single repertoire. */
function countCards(entry: RepertoireEntry | undefined): number {
    if (!entry) return 0;
    let count = 0;
    for (const position of Object.values(entry.positions)) {
        for (const move of Object.values(position.moves)) {
            if (move.card) count++;
        }
    }
    return count;
}

/**
 * Snapshot of dashboard figures emitted as `DashboardView` custom properties
 * so engagement (training cadence, streaks, backlog) can be analyzed over time.
 * Game-backlog counts reuse the shared dashboard helpers so this telemetry
 * agrees with the Actions tile.
 */
export function buildDashboardViewProps(data: RepertoireData): Record<string, number> {
    const activity = data.activity ?? EMPTY_ACTIVITY;
    const today = findEntryByDate(activity, getTodayDateString());

    return {
        RepertoireTotalWhite: countCards(findRepertoire(data.repertoires, 'white')),
        RepertoireTotalBlack: countCards(findRepertoire(data.repertoires, 'black')),
        TodayReviewed: today?.reviewed ?? 0,
        TodayTraversals: today?.traversals ?? 0,
        TodayTimeInMinutes: Math.round((today?.timeSeconds ?? 0) / 60),
        LifetimeReviewed: activity.lifetime.reviewed,
        LifetimeTimeInMinutes: Math.round(activity.lifetime.timeSeconds / 60),
        CurrentStreak: getCurrentStreak(activity),
        BestStreak: getBestStreak(activity),
        GamesToAnalyze: countNewGames(activity),
        MistakesToReview: countMistakeGames(activity),
    };
}
