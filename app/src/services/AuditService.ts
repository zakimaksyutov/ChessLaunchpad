import { Rating, State } from 'ts-fsrs';
import { FSRSCardData } from '../models/FSRSCardData';
import {
    AuditEntry,
    AuditEventSource,
    AUDIT_MAX_ENTRIES,
} from '../models/AuditData';
import { packCardForAudit } from '../utils/BlobCodec';

/**
 * Capture FSRS rating trajectories for cards that fail a real recall.
 * See `docs/product-specs/FSRS-AUDIT.md`.
 *
 * Mutates the caller-supplied `audit` array in place — `RepertoireData.audit`
 * is the same array reference, so changes are visible to anyone holding it
 * (mirrors how `fsrsCards` is shared between FSRSService and the blob).
 */
export class AuditService {
    private byKey: Map<string, AuditEntry>;

    constructor(private readonly audit: AuditEntry[]) {
        this.byKey = new Map();
        for (const e of audit) {
            // Defensive entry hygiene: a corrupt blob may carry entries with a
            // missing or non-array `events`. Repair in-place so subsequent
            // `events.push(...)` calls don't throw. Last-writer-wins on
            // duplicate keys to match prior behavior.
            if (e && !Array.isArray(e.events)) {
                e.events = [];
            }
            if (e && typeof e.k === 'string') {
                this.byKey.set(e.k, e);
            }
        }
    }

    /**
     * Notify the auditor of a rating event.
     *
     * Behavior:
     * - If `key` is already watched, append the event unconditionally.
     * - Otherwise, if the rating is `Again` AND `beforeCard` is non-null and
     *   not in `State.New` AND the audit array has room (< 10 entries),
     *   create a new watched entry and record the trigger event.
     * - Otherwise, no-op.
     *
     * `beforeCard` is the snapshot of the FSRS card immediately before the
     * scheduler ran. The caller is responsible for taking that snapshot
     * because the scheduler replaces (not mutates) the card record.
     *
     * This method is defensive against malformed entries (e.g. `events`
     * clobbered to a non-array after construction) so an audit corruption
     * never breaks scheduling — FSRSService also wraps the call in a
     * try/catch as a second layer of defense.
     */
    onRate(
        key: string,
        beforeCard: FSRSCardData | undefined,
        rating: Rating,
        ts: number,
        source: AuditEventSource,
    ): void {
        const existing = this.byKey.get(key);
        if (existing) {
            if (!Array.isArray(existing.events)) {
                existing.events = [];
            }
            existing.events.push({ ts, r: rating, s: source });
            return;
        }

        // Trigger rule (spec): Again on a card whose pre-call state is not New.
        if (rating !== Rating.Again) return;
        if (!beforeCard) return;
        if (beforeCard.state === State.New) return;

        // Capacity: silently drop new triggers once the array is full. Existing
        // watched entries are unaffected (handled above).
        if (this.audit.length >= AUDIT_MAX_ENTRIES) return;

        const entry: AuditEntry = {
            k: key,
            before: packCardForAudit(beforeCard),
            events: [{ ts, r: rating, s: source }],
        };
        this.audit.push(entry);
        this.byKey.set(key, entry);
    }
}
