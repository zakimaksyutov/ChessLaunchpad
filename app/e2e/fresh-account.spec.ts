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
    await page.route(`${API_BASE}/${username}/variants`, async (route, request) => {
        if (request.method() === 'GET') {
            getCount += 1;
            // Exactly what the backend returns for a freshly created user.
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { ETag: '"fresh-etag-1"' },
                body: '{}',
            });
        }
        if (request.method() === 'PUT') {
            putCount += 1;
            return route.fulfill({
                status: 200,
                headers: { ETag: `"fresh-etag-${putCount + 1}"` },
            });
        }
        return route.continue();
    });

    return {
        getCount: () => getCount,
        putCount: () => putCount,
    };
}

test.describe('Fresh account (backend returns `{}`)', () => {
    test('Training page loads without a decode error and shows the empty state', async ({ page }) => {
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

        const externalRequests: string[] = [];
        page.on('request', (req) => {
            const url = req.url();
            // Anything not served from the local dev server is potentially
            // real outbound traffic. The test must keep this set empty
            // (other than the mocked variants endpoint, which `page.route`
            // intercepts and fulfills before the network is touched).
            if (!url.startsWith('http://localhost:5274')
                && !url.startsWith('data:')
                && !url.startsWith('blob:')) {
                externalRequests.push(`${req.method()} ${url}`);
            }
        });

        await page.goto('/#/training');

        // Empty-state message rendered when no repertoire has positions yet —
        // exactly what normalize() seeds for a fresh account.
        await expect(page.getByText('No variants available.')).toBeVisible();

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

        // Hard guarantee: the only non-localhost requests the test made are
        // to the mocked `/variants` endpoint (which `page.route` intercepts
        // before any real network I/O). Anything else — telemetry,
        // Lichess, the real backend — would indicate the test is reaching
        // outside the sandbox.
        const mockedPrefix = `${API_BASE}/freshuser/variants`;
        const unmocked = externalRequests.filter(line => !line.includes(mockedPrefix));
        expect(unmocked, `Unexpected unmocked external traffic:\n${unmocked.join('\n')}`).toEqual([]);
    });
});
