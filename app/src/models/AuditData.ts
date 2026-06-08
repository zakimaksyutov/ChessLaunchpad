import { PackedCard } from '../utils/BlobCodec';

/**
 * Temporary diagnostic audit data (see `docs/product-specs/FSRS-AUDIT.md`).
 *
 * Capture the FSRS trajectory of cards that fail a real recall so we can
 * inspect scheduling behavior on real user data. Once we have confidence in
 * the scheduler, the field and this entire pipeline are removed.
 *
 * No UI, no migration, no backfill.
 */

/**
 * Source phase that emitted a rating. Enumerated from the actual rate call
 * sites in TrainingEngine and GameIngestService:
 *
 * - `'target'`   — TrainingEngine, regular traversal step with role `target`
 * - `'warmup'`   — TrainingEngine, regular traversal step with role `warm-up`
 * - `'cooldown'` — TrainingEngine, regular traversal step with role `cool-down`
 * - `'branch'`   — TrainingEngine, branch-point alternative (always Good)
 * - `'learn'`    — TrainingEngine, new-card recall pass (the bootstrap Again
 *                  on a fresh `New`-state card; filtered by the trigger rule)
 * - `'ingest'`   — GameIngestService (both Good and Again)
 */
export type AuditEventSource =
    | 'target'
    | 'warmup'
    | 'cooldown'
    | 'branch'
    | 'learn'
    | 'ingest';

/**
 * One rating event on a watched card.
 *
 *   `ts` — epoch ms
 *   `r`  — ts-fsrs `Rating` value (1 = Again, 3 = Good — only these two)
 *   `s`  — source phase (see `AuditEventSource`)
 */
export interface AuditEvent {
    ts: number;
    r: number;
    s: AuditEventSource;
}

/**
 * One watched card. The snapshot is taken at the moment of the FIRST
 * triggering Again; both Again and Good events are appended after that.
 *
 *   `k`      — `<normalizedFen>::<san>`
 *   `before` — packed FSRS card immediately before the triggering Again
 *              (same shape as `PackedCard` in `BlobCodec`)
 *   `events` — append-only, ordered by insertion (≈ chronological)
 */
export interface AuditEntry {
    k: string;
    before: PackedCard;
    events: AuditEvent[];
}

/** Hard cap on entries. Once full, new triggers on unwatched cards are dropped. */
export const AUDIT_MAX_ENTRIES = 10;
