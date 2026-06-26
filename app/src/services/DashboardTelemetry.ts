import { RepertoireData, Activity } from '../models/RepertoireData';
import { RepertoireEntry, findRepertoire } from '../models/Repertoires';
import { LinkedAccount } from './LinkedAccountsService';
import { getAllRecordsNewestFirst } from './GameRecordStore';
import { annotateRecordFromFrozen } from './RecordAnnotation';
import { gameAnnotationHasIssue } from './GameAnnotationService';
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
 * Count games still awaiting analysis and unreviewed mistakes, mirroring the
 * /games filter bar. Only games owned by a linked account are considered;
 * `!fan` is the "needs analysis" signal, and a mistake is an analyzed game
 * with a reviewable issue that the user hasn't marked reviewed (`rv !== 1`).
 */
function countGameReview(
    data: RepertoireData,
    linkedAccounts: LinkedAccount[],
): { gamesToAnalyze: number; mistakesToReview: number } {
    const activity = data.activity;
    if (!activity) return { gamesToAnalyze: 0, mistakesToReview: 0 };

    const namesByPlatform = new Map<LinkedAccount['platform'], Set<string>>();
    for (const account of data.settings?.linkedAccounts ?? linkedAccounts) {
        const names = namesByPlatform.get(account.platform) ?? new Set<string>();
        names.add(account.username.toLowerCase());
        namesByPlatform.set(account.platform, names);
    }

    let gamesToAnalyze = 0;
    let mistakesToReview = 0;
    for (const record of getAllRecordsNewestFirst(activity)) {
        const platform = record.p === 'c' ? 'chess.com' : 'lichess';
        const names = namesByPlatform.get(platform);
        if (!names) continue;
        const white = record.wa.toLowerCase();
        const black = record.ba.toLowerCase();
        const userLower = names.has(white) ? white : names.has(black) ? black : null;
        if (!userLower) continue;

        if (!record.fan) { gamesToAnalyze++; continue; }
        const annotation = annotateRecordFromFrozen(record, userLower);
        if (!annotation) continue;
        if (record.rv !== 1 && gameAnnotationHasIssue(annotation)) mistakesToReview++;
    }
    return { gamesToAnalyze, mistakesToReview };
}

/**
 * Snapshot of dashboard figures emitted as `DashboardView` custom properties
 * so engagement (training cadence, streaks, backlog) can be analyzed over time.
 */
export function buildDashboardViewProps(
    data: RepertoireData,
    linkedAccounts: LinkedAccount[],
): Record<string, number> {
    const activity = data.activity ?? EMPTY_ACTIVITY;
    const today = findEntryByDate(activity, getTodayDateString());
    const { gamesToAnalyze, mistakesToReview } = countGameReview(data, linkedAccounts);

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
        GamesToAnalyze: gamesToAnalyze,
        MistakesToReview: mistakesToReview,
    };
}
