/**
 * Route-matching helpers shared between SPA navigation guards.
 *
 * `startsWith('/explorer')` is too loose: it also accepts `/explorer-stats`,
 * `/explorerz`, etc. The unsaved-edits guards in ExplorerPage and the
 * module-level popstate listener in PendingEditNotifier rely on detecting
 * "still inside the Explorer route", and silently bypassing the guard for
 * a future sibling route would lose the user's pending edits without a
 * confirm prompt. These helpers anchor the match at a route boundary
 * (end-of-string, `/`, or `?`) so adding a new top-level route can't
 * accidentally re-introduce that footgun.
 */

/**
 * True when `path` is `/explorer`, a nested `/explorer/...`, or
 * `/explorer?query`. False for siblings like `/explorer-stats`.
 *
 * @param path Route path WITHOUT the leading `#` (e.g. `/explorer`,
 * `/explorer/foo`, `/explorer?x=1`).
 */
export function isExplorerRoute(path: string): boolean {
    return path === '/explorer'
        || path.startsWith('/explorer/')
        || path.startsWith('/explorer?');
}

/**
 * Hash-form variant for `window.location.hash`-style strings such as
 * `#/explorer`. Returns false for anything not starting with `#/`.
 */
export function isExplorerHash(hash: string): boolean {
    if (!hash.startsWith('#')) return false;
    return isExplorerRoute(hash.slice(1));
}
