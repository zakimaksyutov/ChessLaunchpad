import { test, expect, type Page } from '@playwright/test';

/**
 * Regression: a brand-new account's GET /variants returns the literal
 * `{}` body (per docs/BACKEND_API_CONTRACT.md §"Repertoire JSON Schema":
 * "A newly created user starts with `{}`"). The v3 decode path must treat
 * that empty object as a fresh-account sentinel rather than rejecting it
 * as a legacy v1 blob — otherwise the first /training load after sign-up
 * throws and the user is stuck on an error screen.
 */

const API_BASE = 'https://chess-prod-function.azurewebsites.net/api/user';

async function setupFreshAccount(page: Page, username = 'freshuser') {
    // Bypass ProtectedRoute (it only checks localStorage for credentials —
    // matches what LoginPage.createAccount() writes before navigating).
    await page.addInitScript(
        ({ u }: { u: string }) => {
            localStorage.setItem('username', u);
            localStorage.setItem('hashedPassword', 'fake-hash');
        },
        { u: username },
    );

    let getCount = 0;
    let putCount = 0;
    const blockedExternal: string[] = [];

    // Catch-all FIRST. Later `page.route()` calls take precedence for matching
    // URLs, so we register this broad route up front and then layer the
    // specific `/variants` mock on top of it.
    //
    // Policy:
    //   - localhost (Vite dev server) and data:/blob: → continue (page assets)
    //   - everything else → ABORT and record. This makes the test hermetic on
    //     CI runners that have outbound network (e.g., Application Insights'
    //     `js.monitor.azure.com/scripts/b/ai.config.1.cfg.json` config fetch)
    //     and ensures any newly-introduced unmocked endpoint surfaces as a
    //     test failure rather than silently hitting a real service.
    await page.route('**/*', async (route, request) => {
        const url = request.url();
        if (url.startsWith('http://localhost:5274')
            || url.startsWith('data:')
            || url.startsWith('blob:')) {
            return route.continue();
        }
        blockedExternal.push(`${request.method()} ${url}`);
        return route.abort();
    });

    // Layered AFTER the catch-all → takes priority for this exact URL.
    await page.route(`${API_BASE}/${username}/variants`, async (route, request) => {
        if (request.method() === 'GET') {
            getCount += 1;
            // Exactly what the backend returns for a freshly created user.
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: {
                    ETag: '"fresh-etag-1"',
                    // Expose ETag across origins so SessionStore can read it.
                    'Access-Control-Expose-Headers': 'ETag',
                },
                body: '{}',
            });
        }
        if (request.method() === 'PUT') {
            putCount += 1;
            return route.fulfill({
                status: 200,
                headers: {
                    ETag: `"fresh-etag-${putCount + 1}"`,
                    // Expose ETag across origins so SessionStore can read it.
                    'Access-Control-Expose-Headers': 'ETag',
                },
            });
        }
        return route.continue();
    });

    return {
        getCount: () => getCount,
        putCount: () => putCount,
        // URLs that escaped the mock and were aborted. The test asserts this
        // is limited to known-benign telemetry; anything new fails the test.
        blockedExternal: () => blockedExternal.slice(),
    };
}

test.describe('Fresh account (backend returns `{}`)', () => {
    test('Training page redirects to the dashboard with a build-repertoire nudge', async ({ page }) => {
        const mock = await setupFreshAccount(page);

        // Capture any decode/loader errors that the page surfaces as text or
        // logs, so the assertion message is informative if the regression
        // ever resurfaces.
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto('/#/training');

        // /training decodes the fresh-account `{}` blob (the regression under
        // test), finds no positions to train, and hands off to the dashboard
        // with a one-time nudge. Seeing the nudge proves both the decode and
        // the redirect worked.
        await expect(page.getByText(/Build a repertoire first/i)).toBeVisible();
        await expect(page).toHaveURL(/#\/$/);

        // The page must NOT render the previous failure mode
        // ("Error: Failed to load variants: BlobCodec.decode: unsupported
        // repertoire blob — missing `v` field. ...").
        await expect(page.locator('body')).not.toContainText(/Failed to load variants/i);
        await expect(page.locator('body')).not.toContainText(/missing `v` field/i);

        // Sanity: the page did try to load from the backend.
        expect(mock.getCount()).toBeGreaterThan(0);

        // The fresh-account empty state must not auto-PUT the seeded
        // repertoires back to the server (would silently overwrite if the
        // user already has data elsewhere).
        expect(mock.putCount()).toBe(0);

        // No JS errors should have escaped to the page error handler.
        expect(pageErrors).toEqual([]);
        // And the decode error must not show up in console.error either.
        expect(consoleErrors.join('\n')).not.toMatch(/missing `v` field/i);

        // Hard guarantee of hermeticity: the catch-all `page.route('**/*')`
        // ABORTS everything that isn't localhost or the mocked `/variants`
        // endpoint, so no real network I/O ever happens. The aborted set
        // typically contains only Application Insights' passive telemetry
        // (script config + data plane).
        //
        // To still catch drift — e.g., a future change that starts calling a
        // brand-new backend — we enforce an allowlist of *known* harmless
        // hosts. Anything outside this list fails the test and must be
        // either mocked or added here with justification.
        const ALLOWED_ABORTED_HOSTS = [
            // Application Insights JS SDK config script.
            'js.monitor.azure.com',
        ];
        const unexpectedAborted = mock.blockedExternal().filter((line) => {
            return !ALLOWED_ABORTED_HOSTS.some(host => line.includes(host));
        });
        expect(
            unexpectedAborted,
            `Unmocked external traffic outside the allowlist:\n${unexpectedAborted.join('\n')}`,
        ).toEqual([]);
    });
});
