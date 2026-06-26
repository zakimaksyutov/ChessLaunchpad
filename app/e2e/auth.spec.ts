import { test, expect, type Page, type Route, type Request } from '@playwright/test';

/**
 * Login form (LoginPage) coverage:
 *   - "Sign in with Lichess" kicks off the OAuth authorize redirect.
 *   - Username/password "Log In" validates against GET /variants and lands
 *     on the dashboard.
 *   - "Sign Up" creates the account via PUT /user/{username} and lands on
 *     the dashboard.
 *   - Sign-up password mismatch is rejected client-side (no network).
 *
 * All outbound traffic is intercepted so the suite is hermetic: a broad
 * catch-all aborts anything external except the endpoints each test mocks.
 */

const API_BASE = 'https://chess-prod-function.azurewebsites.net/api/user';

// Hosts we knowingly let the catch-all abort without failing a test
// (passive Application Insights telemetry the bundle fires on load).
const ALLOWED_ABORTED_HOSTS = ['js.monitor.azure.com'];

/**
 * Register a catch-all that lets the Vite dev server (and data:/blob:) load
 * while ABORTING all other external traffic, so no real network I/O escapes.
 * Returns the list of aborted external requests for optional inspection.
 */
async function blockExternalTraffic(page: Page): Promise<() => string[]> {
    const blocked: string[] = [];
    await page.route('**/*', async (route: Route, request: Request) => {
        const url = request.url();
        if (url.startsWith('http://localhost:5274')
            || url.startsWith('data:')
            || url.startsWith('blob:')) {
            return route.continue();
        }
        blocked.push(`${request.method()} ${url}`);
        return route.abort();
    });
    return () => blocked.slice();
}

interface PasswordBackendMock {
    /** Authorization headers seen on GET /variants, in order. */
    getAuth: () => string[];
    /** Authorization headers seen on createAccount PUT /user/{username}. */
    createAuth: () => string[];
}

/**
 * Mock the username/password backend for a given user:
 *   - GET  /user/{username}/variants → 200 with the supplied body
 *   - PUT  /user/{username}/variants → 200 (any post-login save)
 *   - PUT  /user/{username}          → 200 (createAccount)
 *
 * `variantsBody` defaults to the literal `{}` a freshly created account
 * returns. `variantsStatus` lets a test drive the auth-failure path.
 *
 * Layered AFTER {@link blockExternalTraffic} so these take precedence.
 */
async function mockPasswordBackend(
    page: Page,
    username: string,
    opts: { variantsStatus?: number; variantsBody?: string } = {},
): Promise<PasswordBackendMock> {
    const getAuth: string[] = [];
    const createAuth: string[] = [];
    const variantsStatus = opts.variantsStatus ?? 200;
    const variantsBody = opts.variantsBody ?? '{}';

    await page.route(`${API_BASE}/${username}/variants`, async (route, request) => {
        const method = request.method();
        if (method === 'GET') {
            getAuth.push(request.headers()['authorization'] ?? '');
            return route.fulfill({
                status: variantsStatus,
                contentType: variantsStatus === 200 ? 'application/json' : 'text/plain',
                headers: {
                    ETag: '"auth-etag-1"',
                    'Access-Control-Expose-Headers': 'ETag',
                },
                body: variantsStatus === 200 ? variantsBody : 'Invalid credentials',
            });
        }
        if (method === 'PUT') {
            return route.fulfill({
                status: 200,
                headers: {
                    ETag: '"auth-etag-2"',
                    'Access-Control-Expose-Headers': 'ETag',
                },
            });
        }
        return route.continue();
    });

    // createAccount targets the user base URL (no /variants suffix).
    await page.route(`${API_BASE}/${username}`, async (route, request) => {
        if (request.method() === 'PUT') {
            createAuth.push(request.headers()['authorization'] ?? '');
            return route.fulfill({
                status: 200,
                headers: {
                    ETag: '"auth-etag-1"',
                    'Access-Control-Expose-Headers': 'ETag',
                },
            });
        }
        return route.continue();
    });

    return { getAuth: () => getAuth.slice(), createAuth: () => createAuth.slice() };
}

test.describe('Login form', () => {
    test('"Sign in with Lichess" redirects to the Lichess OAuth authorize endpoint', async ({ page }) => {
        await blockExternalTraffic(page);

        // Capture the top-level navigation the PKCE library kicks off, and
        // stub it so the browser doesn't actually leave for lichess.org.
        let authorizeUrl: string | null = null;
        await page.route(/^https:\/\/lichess\.org\/oauth(\?|$)/, async (route) => {
            authorizeUrl = route.request().url();
            return route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: '<html><body>lichess oauth stub</body></html>',
            });
        });

        await page.goto('/#/login');
        await page.getByRole('button', { name: /Sign in with Lichess/i }).click();

        await expect.poll(() => authorizeUrl, { timeout: 10_000 }).not.toBeNull();

        const url = new URL(authorizeUrl!);
        expect(`${url.origin}${url.pathname}`).toBe('https://lichess.org/oauth');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('client_id')).toBe('ChessLaunchpad');
        expect(url.searchParams.get('redirect_uri')).toContain('localhost:5274');
        // PKCE: a derived challenge must accompany the request.
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('code_challenge')).toBeTruthy();
    });

    test('username/password "Log In" validates credentials and lands on the dashboard', async ({ page }) => {
        await blockExternalTraffic(page);
        const username = 'pwuser';
        const rawPassword = 'sup3r-secret';
        const mock = await mockPasswordBackend(page, username);

        await page.goto('/#/login');
        await page.locator('#username').fill(username);
        await page.locator('#password').fill(rawPassword);
        await page.getByRole('button', { name: 'Log In' }).click();

        // navigate('/') after a successful validation → dashboard route.
        await expect(page).toHaveURL(/\/#\/$/);
        await expect(page.getByRole('heading', { name: 'Sign in using a provider' })).toHaveCount(0);

        // The credential validation GET fired, and the Authorization header
        // carried the PBKDF2-derived value — never the raw password.
        const auths = mock.getAuth();
        expect(auths.length).toBeGreaterThan(0);
        expect(auths[0]).toBeTruthy();
        expect(auths[0]).not.toBe(rawPassword);

        // Session was persisted for the protected route.
        await expect.poll(() => page.evaluate(() => localStorage.getItem('username')))
            .toBe(username);
    });

    test('"Sign Up" creates the account and lands on the dashboard', async ({ page }) => {
        await blockExternalTraffic(page);
        const username = 'newuser';
        const rawPassword = 'brand-new-pw';
        const mock = await mockPasswordBackend(page, username);

        await page.goto('/#/login');
        await page.getByRole('button', { name: 'No account? Sign up' }).click();

        // Sign-up mode reveals the confirm-password field and its heading.
        await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
        await page.locator('#username').fill(username);
        await page.locator('#password').fill(rawPassword);
        await page.locator('#confirmPassword').fill(rawPassword);
        await page.getByRole('button', { name: 'Sign Up' }).click();

        await expect(page).toHaveURL(/\/#\/$/);

        // createAccount PUT fired with the derived Authorization, not the raw pw.
        const creates = mock.createAuth();
        expect(creates.length).toBeGreaterThan(0);
        expect(creates[0]).toBeTruthy();
        expect(creates[0]).not.toBe(rawPassword);

        await expect.poll(() => page.evaluate(() => localStorage.getItem('username')))
            .toBe(username);
    });

    test('"Sign Up" with mismatched passwords is rejected client-side', async ({ page }) => {
        await blockExternalTraffic(page);
        const username = 'mismatch';
        const mock = await mockPasswordBackend(page, username);

        await page.goto('/#/login');
        await page.getByRole('button', { name: 'No account? Sign up' }).click();
        await page.locator('#username').fill(username);
        await page.locator('#password').fill('password-one');
        await page.locator('#confirmPassword').fill('password-two');
        await page.getByRole('button', { name: 'Sign Up' }).click();

        await expect(page.locator('.login-error')).toHaveText('Passwords do not match');
        // Stays on the login page; no account is created.
        await expect(page).toHaveURL(/\/#\/login$/);
        expect(mock.createAuth()).toEqual([]);
    });
});
