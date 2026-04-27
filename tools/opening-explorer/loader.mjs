/**
 * Opening Explorer Loader
 *
 * Loads the precomputed opening tree for use in the Repertoire app.
 * Designed to work both as a static import and lazy-loaded via fetch.
 *
 * Usage in the app:
 *   import { OpeningExplorer } from './tools/opening-explorer/loader.mjs';
 *   const explorer = await OpeningExplorer.load('/opening-tree.json');
 *   const stats = explorer.lookup(chess.fen());
 *
 * Each entry in stats.moves: { count, white, draw, black, avgElo }
 */

/**
 * @typedef {Object} MoveStats
 * @property {number} count  - Total games where this move was played
 * @property {number} white  - White wins
 * @property {number} draw   - Draws
 * @property {number} black  - Black wins
 * @property {number} avgElo - Average Elo of players
 */

/**
 * @typedef {Object} PositionData
 * @property {Record<string, MoveStats>} moves - Map of SAN move → stats
 */

export class OpeningExplorer {
  /** @type {Map<string, PositionData>} */
  #tree;

  constructor(tree) {
    this.#tree = tree;
  }

  /**
   * Load the opening tree from a URL (JSON).
   * @param {string} url - Path to opening-tree.json (e.g. "/opening-tree.json")
   * @returns {Promise<OpeningExplorer>}
   */
  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load opening tree: ${res.status}`);
    const raw = await res.json();

    // Convert compact format [count, white, draw, black, eloSum] → { count, white, draw, black, avgElo }
    const tree = new Map();
    for (const [fen, movesObj] of Object.entries(raw)) {
      const moves = {};
      for (const [san, arr] of Object.entries(movesObj)) {
        const [count, white, draw, black, eloSum] = arr;
        moves[san] = {
          count,
          white,
          draw,
          black,
          avgElo: count > 0 ? Math.round(eloSum / count) : 0,
        };
      }
      tree.set(fen, { moves });
    }

    return new OpeningExplorer(tree);
  }

  /**
   * Compact a full FEN to the lookup key (pieces + side + castling).
   * @param {string} fen - Full FEN string
   * @returns {string}
   */
  static compactFen(fen) {
    const parts = fen.split(" ");
    return `${parts[0]} ${parts[1]} ${parts[2]}`;
  }

  /**
   * Look up a position by FEN.
   * @param {string} fen - Full or compact FEN
   * @returns {PositionData | null}
   */
  lookup(fen) {
    const key = fen.split(" ").length > 3
      ? OpeningExplorer.compactFen(fen)
      : fen;
    return this.#tree.get(key) || null;
  }

  /** Number of positions in the tree */
  get size() {
    return this.#tree.size;
  }
}
