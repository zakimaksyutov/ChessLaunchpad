import { FSRSCardData } from "./FSRSCardData";
import { LinkedAccount } from "../services/LinkedAccountsService";

export interface PracticeLogEntry {
    date: string;           // ISO 8601 date (YYYY-MM-DD)
    reviewed: number;       // Positions rated Good during regular review
    mistakes: number;       // Positions rated Again during regular review
    learned: number;        // New positions that completed teach → recall
    traversals: number;     // Completed traversals
    timeSeconds: number;    // Wall-clock training seconds
}

export interface LifetimeStats {
    reviewed: number;
    mistakes: number;
    learned: number;
    traversals: number;
    timeSeconds: number;
    bestStreak?: number;    // Persisted so it survives the 30-entry log eviction
    currentStreak?: number; // Persisted so it survives the 30-entry log eviction
}

export interface Activity {
    practiceLog: PracticeLogEntry[];
    lifetime: LifetimeStats;
}

export interface OpeningVariantData {
    pgn: string;
    orientation: 'black' | 'white';
    classifications: string[];
    numberOfTimesPlayed: number;
    // V1 stub fields — always 0, kept because the backend schema requires them.
    errorEMA: number;
    lastSucceededEpoch: number;
    successEMA: number;
}

export interface AppSettings {
    contextDepth?: number;
    retention?: number;
    maxInterval?: number;
    linkedAccounts?: LinkedAccount[];
    [key: string]: unknown; // preserve unknown fields
}

export interface RepertoireData {
    data: OpeningVariantData[];
    // V1 stub — always 0, kept because the backend schema requires it.
    currentEpoch: number;
    lastPlayedDate: Date;
    dailyPlayCount: number; // Backend compat — derived from activity on save, not read internally
    fsrsCards?: Record<string, FSRSCardData>;
    settings?: AppSettings | null;
    trainingSettings?: AppSettings | null; // legacy, migrated to settings
    activity?: Activity;
}
