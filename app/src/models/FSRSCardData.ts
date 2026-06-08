/**
 * JSON-serializable mirror of the ts-fsrs Card interface, used as the
 * in-memory shape of an FSRS card. The wire format (v3) packs cards as a
 * positional `PackedCard` array in `BlobCodec`, so these field names never
 * appear on disk — they only exist in memory.
 */
export interface FSRSCardData {
    /** ISO 8601 due date. */
    due: string;
    stability: number;
    difficulty: number;
    elapsedDays: number;
    scheduledDays: number;
    learningSteps: number;
    reps: number;
    lapses: number;
    /** 0=New, 1=Learning, 2=Review, 3=Relearning. */
    state: number;
    /** ISO 8601 last-review timestamp (absent on never-rated cards). */
    lastReview?: string;
}
