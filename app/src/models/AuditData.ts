import { PackedCard } from '../utils/BlobCodec';

/**
 * Diagnostic audit data (see `docs/product-specs/FSRS-LIST.md`).
 *
 * Capture the FSRS trajectory of explicitly-tracked cards so we can inspect
 * scheduling behavior on real user data. Tracking is started/stopped from the
 * FSRS card list page (`/fsrs`); the field is additive (absent on blobs with
 * nothing tracked), with no migration or backfill.
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
 *                  on a fresh `New`-state card)
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
 * One tracked card. The snapshot is taken when the user turns on tracking via
 * the FSRS card list page; both Again and Good events are appended after that.
 *
 *   `k`      — `<normalizedFen>::<san>`
 *   `before` — packed FSRS card captured at the moment tracking started
 *              (same shape as `PackedCard` in `BlobCodec`)
 *   `events` — append-only, ordered by insertion (≈ chronological)
 */
export interface AuditEntry {
    k: string;
    before: PackedCard;
    events: AuditEvent[];
}

/** Hard cap on tracked entries. Track is unavailable once full (until an Untrack frees a slot). */
export const AUDIT_MAX_ENTRIES = 10;
