import { defineConfig, devices } from '@playwright/test';

// PLAYWRIGHT_BASE_URL lets CI point the suite at the already-deployed beta site
// (post-deploy run); when unset, dev/local runs spin a local static server.
const remoteBase = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = remoteBase || 'http://localhost:3456';

export default defineConfig({
  testDir: './tests',
  testMatch: /\.spec\.(ts|js)$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Handle GitHub Pages HTTPS cert transitions on beta (cert can be briefly
    // unissued/renewed after the first deploy of a new custom domain).
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Local static server only when testing localhost; remote runs (beta) skip it.
  ...(remoteBase ? {} : {
    webServer: {
      command: 'npx serve -p 3456 .',
      url: 'http://localhost:3456',
      reuseExistingServer: !process.env.CI,
    },
  }),
});
