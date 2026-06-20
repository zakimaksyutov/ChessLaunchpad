import { FSRSCardData } from "./FSRSCardData";
import { LinkedAccount } from "../services/LinkedAccountsService";
import { RepertoireEntry } from "./Repertoires";
import { AuditEntry } from "./AuditData";

interface PracticeLogGameCounters {
    ingested: number;   // Games processed on this date
    reviewed: number;   // Good ratings from in-repertoire user moves
    mistakes: number;   // Games containing at least one deviation (one per game)
    /**
     * Per-day game records — display/analysis data for the /games page.
     * See `docs/product-specs/GAMES.md` and `docs/product-specs/GAME-INGEST.md`.
     *
     * Invariant: `records.length` is either equal to `ingested`, or `0`.
     * Empty `records` with non-zero `ingested` means this day's records
     * were evicted by the 100-game total cap.
     *
     * Absent (no key) is treated the same as `[]`.
     */
    records?: GameRecord[];
}

/** Compact per-platform label persisted on game records (`"l" | "c"`). */
type GameRecordPlatform = 'l' | 'c';

/** Result from the user's POV. */
type GameRecordResult = 'win' | 'draw' | 'loss';

/**
 * Compact, sync-friendly per-game record stored inside
 * `activity.practiceLog[].games.records`. Field names are intentionally
 * short — these are persisted on every blob PUT and 100 of them adds up.
 *
 * See `docs/product-specs/GAMES.md` for field semantics.
 */
export interface GameRecord {
    /** Provider id (lichess game id | chess.com uuid) — no prefix. */
    id: string;
    /** Platform: `"l"` (lichess) | `"c"` (chess.com). */
    p: GameRecordPlatform;
    /** Game created-at in ms; intra-day sort key. */
    t: number;
    /** Space-separated SAN move list. */
    m: string;
    /** White account in provider casing. */
    wa: string;
    /** White rating, when known. */
    wr?: number;
    /** Black account in provider casing. */
    ba: string;
    /** Black rating, when known. */
    br?: number;
    /** Result from user's POV. */
    res: GameRecordResult;
    /** Time control display (e.g. "5+3"). */
    tc?: string;
    /** Speed / time class (lichess `speed` or chess.com `time_class`). */
    sp?: string;
    /** Rated flag: 0 | 1. */
    rt: 0 | 1;
    /** Opening name. */
    o?: string;
    /**
     * Optional canonical "View on platform" URL. Lichess URLs are stable
     * and derivable from `id` (`https://lichess.org/<id>`), so for `p: 'l'`
     * this field is omitted to save bytes. For `p: 'c'` it stores the
     * provider-supplied URL (`gameData.url`) verbatim — Chess.com public
     * URLs use a numeric `live` game id that's NOT the same as the API
     * UUID we store in `id`, so the URL cannot be reconstructed from `id`
     * alone and must be persisted.
     */
    u?: string;
    /**
     * Optional per-ply centipawn evals. Originally populated from Lichess
     * game analysis (chess.com archives carry none), but the analysis pass also
     * back-fills cloud evals here — sparsely — for a game it defers awaiting a
     * masters verdict, so a chess.com record may carry a partial `ev` too.
     * Indices align with `m` plies (1:1 up to `MAX_RECORD_PLIES`). `null` at
     * index `i` means "no eval data at this ply" — distinct from a real `0 cp`
     * — and round-trips through the render-side `extractEmbeddedEvals` which
     * treats `null` as missing.
     */
    ev?: (number | null)[];
    /**
     * Frozen annotation — everything the /games view needs to render this
     * game, computed once at analysis time. Present once analyzed; its
     * absence is the sole "needs analysis" signal. Replaces the legacy
     * masters-theory verdict (`an`). See `FrozenAnnotation` and the
     * "Frozen Annotation (`fan`)" section of `docs/product-specs/GAMES.md`.
     */
    fan?: FrozenAnnotation;
    /** Saved opponent-analysis result; on-demand, independent of `fan`. */
    op?: OpponentAnalysisRecord;
    /**
     * Reviewed flag — the user has marked this game's mistake as reviewed
     * (analyzed / addressed) from the /games page. A user decision,
     * independent of `fan`: it drives the page's "to review" filter, not the
     * annotation. Present (`1`) means reviewed; absent means not yet
     * reviewed. Re-annotate does NOT clear it. See `docs/product-specs/GAMES.md`.
     */
    rv?: 1;
}

/**
 * Frozen, render-ready annotation for a game. Computed once on the analysis
 * path (initial pass or Re-annotate) and stored on the record so render is a
 * pure read — no repertoire lookups, no eval lookups, no masters queries at
 * view time. See the "Frozen Annotation (`fan`)" section of
 * `docs/product-specs/GAMES.md`.
 */
export interface FrozenAnnotation {
    /**
     * One highlight code per **user** move, in move order, across the frozen
     * display window (`hl.length` is the window — render shows moves through
     * the last user move in `hl`). Opponent moves carry no code. Codes:
     *   0 in-repertoire | 1 deviation | 2 post-theory ok | 3 inaccuracy
     *   4 mistake | 5 blunder | 7 out-of-theory.
     */
    hl: number[];
    /**
     * Repertoire move alternatives at the deviation, as SAN — the green
     * arrows / deviation summary. Present only when `hl` contains a code `1`
     * (deviation) and at least one alternative exists. Render parses each at
     * the deviation position (depth `mb`) to recover `{from, to}`.
     */
    alt?: string[];
    /**
     * Mini-board anchor: the half-move depth of the position shown on the
     * row's mini board. Render replays the first `mb` plies of `m`. For a
     * deviation this is the position *before* the code-`1` ply.
     */
    mb: number;
}

/**
 * Saved opponent-analysis result, persisted as part of the game record.
 * Independent of `fan`; computed on-demand from the /games "Analyze
 * opponent" action.
 *
 * Keyed by the deviation `ply` so the analysis can be re-attached even
 * if the user's repertoire changes; if no current deviation sits at
 * `ply` after a repertoire change, the saved `op` is treated as stale.
 */
export interface OpponentAnalysisRecord {
    /** Ply of the analyzed user deviation (the user's bad move). */
    ply: number;
    /** Opponent games analyzed. */
    m: number;
    /** Count reaching fenBefore (after opponent's out-of-rep move). */
    nb: number;
    /** Count reaching fenAfter (after user's bad response). */
    na: number;
    /** Opponent move SAN (the critical preceding move). */
    os: string;
    /** User move SAN (the bad response). */
    us: string;
    /** Up to 5 recent before-games. */
    rb: OpponentAnalysisGameRef[];
    /** Up to 5 recent after-games. */
    ra: OpponentAnalysisGameRef[];
    /** Analyzed at — ms epoch. */
    at: number;
}

interface OpponentAnalysisGameRef {
    /** Game date (ms). */
    d: number;
    /** Game URL. */
    u: string;
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

export interface AppSettings {
    contextDepth?: number;
    retention?: number;
    maxInterval?: number;
    linkedAccounts?: LinkedAccount[];
    [key: string]: unknown; // preserve unknown fields
}

export interface RepertoireData {
    /**
     * Position-centric repertoire storage. Always populated after
     * `RepertoireDataUtils.normalize()` runs — seeded with two empty named
     * entries (White, Black) for brand-new accounts. See
     * `docs/REPERTOIRE-STORAGE.md`.
     */
    repertoires?: RepertoireEntry[];
    /**
     * In-memory flat card map (key = `${fen}::${san}`). Built by `normalize`
     * from `repertoires` and mutated by FSRSService during training.
     * Re-projected back into `repertoires` on save by `prepareDataForSave`.
     * Never persisted on the wire — the v3 blob stores cards inline on each
     * user-turn move.
     */
    fsrsCards?: Record<string, FSRSCardData>;
    settings?: AppSettings | null;
    activity?: Activity;
    /** Per-account game-ingest state, keyed by `${platform}:${usernameLower}`. */
    games?: GamesIngestMap;
    /**
     * FSRS scheduling audit trail for cards the user has chosen to Track on
     * the `/fsrs` page. See `docs/product-specs/FSRS-LIST.md`. Entries are
     * created/removed by Track/Untrack; `AuditService` appends rating events
     * in place during training and game ingest. Absent on existing blobs;
     * seeded as an empty array by `RepertoireDataUtils.normalize`.
     */
    audit?: AuditEntry[];
}
