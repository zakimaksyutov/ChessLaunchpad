/**
 * ExplorerEvals — lazy-loaded lookup service for precomputed opening evaluations.
 *
 * Evals originate from the Lichess cloud eval database (Stockfish, depth 30–75).
 * The JSON asset maps compact FEN (pieces side castling) → centipawns from White's perspective.
 *
 * The file is ~29 MB raw / ~5.8 MB gzipped — loaded only once per session on demand.
 */

export interface EvalEntry {
    /** Centipawns from White's perspective. */
    cp: number;
    /** Stockfish search depth that produced this eval. */
    depth: number;
}

export class ExplorerEvals {
    private evals: Map<string, EvalEntry>;

    private constructor(evals: Map<string, EvalEntry>) {
        this.evals = evals;
    }

    /** Fetch the JSON asset and build the lookup map. */
    static async load(url: string): Promise<ExplorerEvals> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load explorer evals: ${response.status}`);
        }
        const data: Record<string, number | [number, number]> = await response.json();
        return new ExplorerEvals(ExplorerEvals.parseEntries(data));
    }

    /** Build from an in-memory record (useful for tests). */
    static fromRecord(data: Record<string, number | [number, number]>): ExplorerEvals {
        return new ExplorerEvals(ExplorerEvals.parseEntries(data));
    }

    /**
     * Parse entries that are either plain numbers (legacy: cp only, depth defaults to 0)
     * or [cp, depth] tuples.
     */
    private static parseEntries(data: Record<string, number | [number, number]>): Map<string, EvalEntry> {
        const map = new Map<string, EvalEntry>();
        for (const [fen, val] of Object.entries(data)) {
            if (Array.isArray(val)) {
                map.set(fen, { cp: val[0], depth: val[1] });
            } else {
                map.set(fen, { cp: val, depth: 0 });
            }
        }
        return map;
    }

    get size(): number {
        return this.evals.size;
    }

    /**
     * Look up eval for a position. Accepts any FEN length (3-part compact,
     * 4-part normalized, or full 6-part). Extra fields are stripped.
     * Returns centipawns from White's perspective, or null if not found.
     */
    lookup(fen: string): number | null {
        const entry = this.lookupEntry(fen);
        return entry !== null ? entry.cp : null;
    }

    /**
     * Look up the full eval entry (cp + depth) for a position.
     * Returns null if not found.
     */
    lookupEntry(fen: string): EvalEntry | null {
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
