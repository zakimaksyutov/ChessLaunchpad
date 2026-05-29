import { FSRSCardData } from "./FSRSCardData";
import { LinkedAccount } from "../services/LinkedAccountsService";

export interface PracticeLogGameCounters {
    ingested: number;   // Games processed on this date
    reviewed: number;   // Good ratings from in-repertoire user moves
    mistakes: number;   // Games containing at least one deviation (one per game)
}

export interface PracticeLogEntry {
    date: string;           // ISO 8601 date (YYYY-MM-DD)
    reviewed: number;       // Positions rated Good during regular review
    mistakes: number;       // Positions rated Again during regular review
    learned: number;        // New positions that completed teach → recall
    traversals: number;     // Completed traversals
    timeSeconds: number;    // Wall-clock training seconds
    /** Game ingest counters for this date — absent on days with no ingest. */
    games?: PracticeLogGameCounters;
}

/** Per-account ingest state on the synced blob, keyed by `${platform}:${usernameLower}`. */
export interface GameIngestState {
    /** Most recent processed game timestamp (ms). Only games with createdAt > watermarkMs are eligible. */
    watermarkMs: number;
    /** Up to 50 most-recent processed game IDs, sorted createdAt desc / id asc. */
    recentIds: string[];
    /** Optional provider-defined cursor — chess.com uses { month, etag } for If-None-Match. */
    providerCursor?: ChesscomProviderCursor;
}

export interface ChesscomProviderCursor {
    month: string;  // "YYYY-MM" — the most recently fetched archive
    etag: string;   // Conditional fetch ETag for that month
}

export type GamesIngestMap = Record<string, GameIngestState>;

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
    /** Per-account game-ingest state, keyed by `${platform}:${usernameLower}`. */
    games?: GamesIngestMap;
}
