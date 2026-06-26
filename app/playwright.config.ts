import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5274',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command: 'yarn dev',
    url: 'http://localhost:5274',
    reuseExistingServer: !process.env.CI,
    // Route Application Insights at an unreachable sentinel ingestion endpoint
    // so e2e runs (local and CI) can never emit telemetry to the production
    // resource. The dummy instrumentation key + RFC 6761 `.invalid` host mean
    // nothing reaches Azure even if a send is attempted. The SDK stays fully
    // wired (rather than no-op'ing trackEvent) so future tests can intercept
    // `**/v2/track` to assert on emitted events. This overrides any
    // VITE_APPINSIGHTS_CONNECTION_STRING inherited from the CI job environment.
    env: {
      VITE_APPINSIGHTS_CONNECTION_STRING:
        'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://appinsights.e2e.invalid/',
    },
  },
});
