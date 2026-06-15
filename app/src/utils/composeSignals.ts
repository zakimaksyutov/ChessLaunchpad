/**
 * Compose multiple `AbortSignal`s into a single derived signal that
 * aborts as soon as any input signal aborts. Equivalent to ES2024's
 * `AbortSignal.any([...])`, but implemented as a small helper so we
 * don't depend on browser-version availability for that API.
 *
 * Behavior:
 *   - If any input signal is already aborted, the returned signal
 *     starts aborted (with the input's `reason`).
 *   - Otherwise, the first input to abort forwards its `reason` onto
 *     the derived controller. Subsequent aborts on other inputs are
 *     ignored, AND the listeners we attached on the still-pending
 *     inputs are removed — this is the load-bearing difference vs.
 *     `addEventListener('abort', ..., { once: true })`, which would
 *     leave dead listeners on long-lived page signals every time a
 *     per-op signal fires first (a per-page analysis pass that runs
 *     many ops without navigating would slowly accumulate dead
 *     closures on the page-scoped controller's signal list).
 *   - `undefined` entries are skipped so callers can pass optional
 *     sources without filtering.
 */
export function composeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];

    const abortAndCleanup = (reason: unknown) => {
        for (const cleanup of cleanups) cleanup();
        cleanups.length = 0;
        controller.abort(reason);
    };

    for (const s of signals) {
        if (!s) continue;
        if (s.aborted) {
            abortAndCleanup(s.reason);
            return controller.signal;
        }
        const onAbort = () => abortAndCleanup(s.reason);
        s.addEventListener('abort', onAbort);
        cleanups.push(() => s.removeEventListener('abort', onAbort));
    }
    return controller.signal;
}
