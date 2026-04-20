/**
 * JSON-serializable mirror of the ts-fsrs Card interface using minified keys
 * to match the backend schema. See specs/backend-api-contract.md (FSRS Card Entry).
 */
export interface FSRSCardData {
    d: string;              // due — ISO 8601
    s: number;              // stability
    di: number;             // difficulty
    e: number;              // elapsed_days
    sd: number;             // scheduled_days
    ls: number;             // learning_steps
    r: number;              // reps
    l: number;              // lapses
    st: number;             // state — 0=New, 1=Learning, 2=Review, 3=Relearning
    lr?: string;            // last_review — ISO 8601 (optional)
}
