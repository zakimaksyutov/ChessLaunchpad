import { BootstrapGame, BootstrapSelection } from './RepertoireBootstrapService';

/**
 * In-memory, app-lifetime cache of a completed bootstrap analysis, keyed on the
 * empty-color set it was computed for. Lets a Back navigation to /bootstrap
 * (e.g. from Explorer's review) restore the summary instantly instead of
 * re-running the multi-second download. Keyed on colors so a later run for a
 * now-different empty color (e.g. Black after White was already saved) never
 * reuses the wrong proposal.
 *
 * Module-level like BootstrapHandoff — a hard reload clears it. Logout must
 * clear it explicitly (via SessionTeardown); otherwise one user's proposed
 * lines and downloaded games would leak into the next user's /bootstrap on the
 * same browser.
 */
export interface BootstrapResult {
    colors: ('white' | 'black')[];
    games: BootstrapGame[];
    selection: BootstrapSelection;
}

let cachedResult: BootstrapResult | null = null;

export function getBootstrapResult(): BootstrapResult | null {
    return cachedResult;
}

export function setBootstrapResult(result: BootstrapResult): void {
    cachedResult = result;
}

/** Drop the cached analysis (logout teardown). */
export function clearBootstrapResult(): void {
    cachedResult = null;
}
