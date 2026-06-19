import { Rating, State } from 'ts-fsrs';
import { FSRSCardData } from '../models/FSRSCardData';
import {
    AuditEntry,
    AuditEventSource,
    AUDIT_MAX_ENTRIES,
} from '../models/AuditData';
import { packCardForAudit } from '../utils/BlobCodec';

/**
 * Capture FSRS rating trajectories for explicitly-tracked cards.
 * See `docs/product-specs/FSRS-LIST.md`.
 *
 * Entry creation is now driven exclusively by the FSRS card list page via
 * {@link track}; the old automatic capture (a watch started on an `Again`
 * rating of a non-`New` card) has been removed. {@link onRate} only appends
 * events to cards that are already tracked.
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
     * Behavior: if `key` is already tracked, append the event; otherwise
     * no-op. Entry creation happens only via {@link track} (the FSRS card
     * list page) — this method never starts a new watch.
     *
     * This method is defensive against malformed entries (e.g. `events`
     * clobbered to a non-array after construction) so an audit corruption
     * never breaks scheduling — FSRSService also wraps the call in a
     * try/catch as a second layer of defense.
     */
    onRate(
        key: string,
        rating: Rating,
        ts: number,
        source: AuditEventSource,
    ): void {
        const existing = this.byKey.get(key);
        if (!existing) return;
        if (!Array.isArray(existing.events)) {
            existing.events = [];
        }
        existing.events.push({ ts, r: rating, s: source });
    }

    /** True when the audit array is at capacity — Track is unavailable. */
    isFull(): boolean {
        return this.audit.length >= AUDIT_MAX_ENTRIES;
    }

    /**
     * Begin tracking a card: snapshot its current FSRS state and start an
     * empty event log. Subsequent ratings flow in via {@link onRate}.
     *
     * Returns `false` (and makes no change) when tracking can't start:
     * - the card is already tracked,
     * - there is no card to snapshot (`beforeCard` is undefined),
     * - the card is in `State.New` (no meaningful FSRS state yet), or
     * - the audit array is already at {@link AUDIT_MAX_ENTRIES} capacity.
     */
    track(key: string, beforeCard: FSRSCardData | undefined): boolean {
        if (this.byKey.has(key)) return false;
        if (!beforeCard) return false;
        if (beforeCard.state === State.New) return false;
        if (this.isFull()) return false;

        const entry: AuditEntry = {
            k: key,
            before: packCardForAudit(beforeCard),
            events: [],
        };
        this.audit.push(entry);
        this.byKey.set(key, entry);
        return true;
    }

    /**
     * Stop tracking a card: remove its audit entry (snapshot + events),
     * freeing a capacity slot. Removes every entry matching `key` so a
     * corrupt blob carrying duplicates can't leave a stale shadow entry.
     * Returns `false` when no entry matched.
     */
    untrack(key: string): boolean {
        if (!this.byKey.has(key)) return false;
        for (let i = this.audit.length - 1; i >= 0; i--) {
            if (this.audit[i] && this.audit[i].k === key) {
                this.audit.splice(i, 1);
            }
        }
        this.byKey.delete(key);
        return true;
    }
}
