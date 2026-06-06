import { FSRSCardData } from "./FSRSCardData";
import { LinkedAccount } from "../services/LinkedAccountsService";
import { RepertoireEntry } from "./Repertoires";

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

/** One entry in the per-account `recentIds` ring (most-recent processed game IDs). */
export interface RecentGameId {
    id: string;
    /** Game creation timestamp (ms). Used for deterministic eviction. */
    ts: number;
}

/** Per-account ingest state on the synced blob, keyed by `${platform}:${usernameLower}`. */
export interface GameIngestState {
    /** Most recent processed game timestamp (ms). Only games with createdAt > watermarkMs are eligible. */
    watermarkMs: number;
    /** Up to 50 most-recent processed game IDs with their createdAt, sorted (ts desc, id asc). */
    recentIds: RecentGameId[];
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
}

export interface AppSettings {
    contextDepth?: number;
    retention?: number;
    maxInterval?: number;
    linkedAccounts?: LinkedAccount[];
    [key: string]: unknown; // preserve unknown fields
}

export interface RepertoireData {
    /**
     * Position-centric repertoire storage. After the first save through the
     * new client this is the persisted shape; `data` and `fsrsCards` are
     * absent in newly-written blobs. See `docs/product-specs/REPERTOIRES.md`.
     */
    repertoires?: RepertoireEntry[];
    /**
     * Legacy variant-centric storage. Present on blobs that pre-date the
     * position-centric migration. Read-only after `normalize()` runs — it
     * bootstraps `repertoires` from these PGNs and FSRS card map, then those
     * fields are no longer used in-memory and are never written back.
     */
    data?: OpeningVariantData[];
    /**
     * In-memory flat card map (key = `${fen}::${san}`). Built by `normalize`
     * from `repertoires` and mutated by FSRSService. Re-projected back into
     * `repertoires` on save; never persisted as a separate field after the
     * first new-client save.
     */
    fsrsCards?: Record<string, FSRSCardData>;
    settings?: AppSettings | null;
    trainingSettings?: AppSettings | null; // legacy, migrated to settings
    activity?: Activity;
    /** Per-account game-ingest state, keyed by `${platform}:${usernameLower}`. */
    games?: GamesIngestMap;
}
