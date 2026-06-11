/**
 * Fetch a single Lichess game's JSON payload — used by the Games page
 * Re-annotate flow to pick up server-side evals that Lichess may have
 * computed asynchronously *after* the game was first ingested.
 *
 * Bulk ingest (`fetchLichessGames` in `GameIngestService.ts`) only sees
 * the analysis state available at the moment the player's recent-games
 * list was fetched. Lichess's automated requested-analysis can finish
 * minutes or hours later, so a per-game refetch is the only way to
 * surface the freshly-computed `analysis[]` (and therefore the per-ply
 * eval-drop badges) on already-stored records.
 *
 * The returned shape matches a single line of `/api/games/user/{u}` —
 * i.e. the same payload `buildGameRecord(...)` already consumes for
 * Lichess records. We deliberately request the same field set
 * (`moves` + `clocks` + `evals` + `opening`) so the rebuilt
 * `GameRecord` is field-for-field equivalent to one produced by ingest.
 */

const LICHESS_HOST = 'https://lichess.org';

/**
 * Fetch a single Lichess game's JSON payload by id.
 *
 * Returns `null` on any HTTP / network failure so callers can fall back
 * to a pure re-annotate against the cached record without surfacing
 * intermediate-error states to the user. A 404 (game deleted) and a
 * 429 (rate-limited) collapse to the same `null` — both are
 * "no refresh today, keep the cached record" from the caller's POV.
 *
 * **No `Authorization` header is sent**, deliberately. The endpoint is
 * public for non-private games (and rated blitz/rapid — the only games
 * we ever ingest — are always public), and Lichess does **not** answer
 * CORS preflight on `/game/export/{id}` (`OPTIONS` returns 404). Sending
 * any non-safelisted header (including `Authorization`) would force the
 * browser to preflight the request and the entire fetch would fail in
 * the browser even though the underlying `GET` works. Keeping the
 * request "simple" (`Accept: application/json` is CORS-safelisted) skips
 * preflight and the `GET` succeeds with `Access-Control-Allow-Origin: *`.
 */
export async function fetchLichessGameExport(
    id: string,
    fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
    const params = new URLSearchParams({
        moves: 'true',
        clocks: 'true',
        evals: 'true',
        opening: 'true',
        // Drop pieces we don't read so the response stays compact.
        literate: 'false',
        accuracy: 'false',
        tags: 'false',
    });
    const url = `${LICHESS_HOST}/game/export/${encodeURIComponent(id)}?${params}`;
    try {
        const response = await fetchFn(url, {
            headers: { 'Accept': 'application/json' },
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        return data as Record<string, unknown>;
    } catch {
        return null;
    }
}
