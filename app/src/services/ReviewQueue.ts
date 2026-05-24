import { State } from 'ts-fsrs';
import { FSRSService } from './FSRSService';

export interface QueueEntry {
    cardKey: string;
    state: State;
    priority: number; // lower = higher priority (0=Relearning, 1=Due Review, 2=Learning, 3=New)
    overdueness: number;
}

/**
 * Priority queue of FSRS cards for training.
 * Priority order: Relearning > Due Review (by overdueness) > Learning > New.
 */
export class ReviewQueue {
    private entries: QueueEntry[] = [];

    /**
     * Build the queue from all card keys using the FSRS service.
     * Only includes cards that are due or new.
     */
    build(fsrsService: FSRSService, cardKeys: string[], now: Date): void {
        this.entries = [];

        for (const key of cardKeys) {
            const state = fsrsService.getState(key);
            if (state === undefined) continue;

            if (state === State.New) {
                this.entries.push({
                    cardKey: key,
                    state,
                    priority: 3,
                    overdueness: 0,
                });
                continue;
            }

            if (!fsrsService.isDue(key, now)) continue;

            let priority: number;
            switch (state) {
                case State.Relearning:
                    priority = 0;
                    break;
                case State.Review:
                    priority = 1;
                    break;
                case State.Learning:
                    priority = 2;
                    break;
                default:
                    priority = 4;
            }

            this.entries.push({
                cardKey: key,
                state,
                priority,
                overdueness: fsrsService.getOverdueness(key, now),
            });
        }

        this.entries.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            // Within same priority, more overdue first
            return b.overdueness - a.overdueness;
        });
    }

    peek(): QueueEntry | undefined {
        return this.entries[0];
    }

    pop(): QueueEntry | undefined {
        return this.entries.shift();
    }

    isEmpty(): boolean {
        return this.entries.length === 0;
    }

    size(): number {
        return this.entries.length;
    }

    /**
     * Remove a specific card from the queue (e.g., after incidental review at a branch point).
     */
    remove(cardKey: string): void {
        this.entries = this.entries.filter(e => e.cardKey !== cardKey);
    }

    /**
     * Get all remaining entries (read-only snapshot).
     */
    getEntries(): readonly QueueEntry[] {
        return this.entries;
    }

    /**
     * Count of due cards (non-new) in the queue.
     */
    dueCount(): number {
        return this.entries.filter(e => e.state !== State.New).length;
    }

    /**
     * Count of new cards in the queue.
     */
    newCount(): number {
        return this.entries.filter(e => e.state === State.New).length;
    }
}
