/**
 * Build a Lichess analysis-board URL preloaded with `pgn` and oriented to
 * `orientation`. The analysis board hosts Lichess's opening explorer panel.
 *
 * Format: `https://lichess.org/analysis/pgn/<encoded pgn>?color=<white|black>`.
 * The PGN may contain `(…)` variations; it is URL-encoded so parentheses,
 * spaces, and move-number dots survive transit. `'white' | 'black'` are exactly
 * Lichess's accepted `color` values, so no mapping is needed.
 */
export function buildLichessAnalysisUrl(pgn: string, orientation: 'white' | 'black'): string {
    return `https://lichess.org/analysis/pgn/${encodeURIComponent(pgn)}?color=${orientation}`;
}
