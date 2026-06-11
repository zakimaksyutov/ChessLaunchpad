/**
 * Parse Chess.com `time_control` strings into the human-friendly
 * `<minutes>+<increment>` display format (matching Lichess `clock.initial+increment`).
 *
 * Chess.com encodes time control in three flavors:
 *   - `"NNN"`         — total seconds, no increment (e.g. `"600"` → `"10+0"`).
 *   - `"NNN+M"`       — total seconds + increment seconds (e.g. `"300+5"` → `"5+5"`).
 *   - `"D/NNN"`       — daily / correspondence (e.g. `"1/86400"`). Passed through verbatim.
 *
 * Returns `""` for empty input and the raw string for unparseable forms,
 * matching the prior `ChesscomGamesService` helper. Kept separate from the
 * (deleted) game-sync module because both ingest and the /games page need it.
 */
export function parseChesscomTimeControl(tc: string): string {
    if (!tc) return '';
    if (tc.includes('+')) {
        const [base, inc] = tc.split('+');
        const minutes = Math.floor(parseInt(base, 10) / 60);
        return `${minutes}+${inc}`;
    }
    if (tc.includes('/')) {
        // Daily / correspondence — pass through.
        return tc;
    }
    const seconds = parseInt(tc, 10);
    if (isNaN(seconds)) return tc;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}+0`;
}
