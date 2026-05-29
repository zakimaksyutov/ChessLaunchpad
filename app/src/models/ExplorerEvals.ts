/**
 * ExplorerEvals — lazy-loaded lookup service for precomputed opening evaluations.
 *
 * Evals originate from the Lichess cloud eval database (Stockfish, depth 30–75).
 * The JSON asset maps compact FEN (pieces side castling) → array of centipawn values
 * from the 2 deepest Stockfish entries (from White's perspective).
 *
 * The file is loaded only once per session on demand.
 */

export class ExplorerEvals {
    private evals: Map<string, number[]>;

    private constructor(evals: Map<string, number[]>) {
        this.evals = evals;
    }

    /** Fetch the JSON asset and build the lookup map. */
    static async load(url: string): Promise<ExplorerEvals> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load explorer evals: ${response.status}`);
        }
        const data: Record<string, number[]> = await response.json();
        return new ExplorerEvals(ExplorerEvals.parseEntries(data));
    }

    /** Build from an in-memory record (useful for tests). */
    static fromRecord(data: Record<string, number[]>): ExplorerEvals {
        return new ExplorerEvals(ExplorerEvals.parseEntries(data));
    }

    /**
     * Parse entries: each value is an array of up to 2 centipawn values
     * from the 2 deepest Stockfish entries (single-entry positions produce `[cp]`).
     */
    private static parseEntries(data: Record<string, number[]>): Map<string, number[]> {
        return new Map(Object.entries(data));
    }

    get size(): number {
        return this.evals.size;
    }

    /**
     * Look up the primary eval for a position. Accepts any FEN length (3-part compact,
     * 4-part normalized, or full 6-part). Extra fields are stripped.
     * Returns centipawns from White's perspective (deepest entry), or null if not found.
     */
    lookup(fen: string): number | null {
        const compact = toCompactFen(fen);
        const val = this.evals.get(compact);
        return val !== undefined ? val[0] : null;
    }

    /**
     * Look up all eval entries for a position.
     * Returns array of centipawn values (up to 2, deepest first), or null if not found.
     */
    lookupAll(fen: string): number[] | null {
        const compact = toCompactFen(fen);
        const val = this.evals.get(compact);
        return val !== undefined ? val : null;
    }
}

/**
 * Strip a FEN to its first 3 fields: pieces, side-to-move, castling.
 * Explorer evals are keyed by this compact form.
 */
export function toCompactFen(fen: string): string {
    return fen.split(' ').slice(0, 3).join(' ');
}

// Module-level singleton cache
let cachedInstance: ExplorerEvals | null = null;
let loadingPromise: Promise<ExplorerEvals> | null = null;

/**
 * Get the singleton ExplorerEvals instance, loading it lazily on first call.
 * Subsequent calls return the cached instance immediately.
 */
export async function getExplorerEvals(): Promise<ExplorerEvals> {
    if (cachedInstance) {
        return cachedInstance;
    }
    if (!loadingPromise) {
        loadingPromise = ExplorerEvals.load(
            `${import.meta.env.BASE_URL}opening-explorer-evals.json`
        ).then((instance) => {
            cachedInstance = instance;
            return instance;
        }).catch((err) => {
            // Reset so the next call retries instead of returning the rejected promise
            loadingPromise = null;
            throw err;
        });
    }
    return loadingPromise;
}
