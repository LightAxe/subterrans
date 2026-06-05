import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Absorb transient canvas/WebGL timing flakiness on the 2-core CI runner (a
  // slow boot can expire a settle poll or the foraging-render wait) without
  // masking real failures locally. CI retries twice; local dev fails fast.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1024, height: 768 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // --disable-gpu prevents WebGL framebuffer errors in headless Chromium
        // (Phaser falls back to Canvas renderer cleanly without this flag causing
        //  "Framebuffer status: Framebuffer Unsupported" console errors).
        launchOptions: {
          args: ['--disable-gpu'],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    // Force the playtrace feature OFF for e2e regardless of a developer's
    // .env.local (Vite gives an existing process.env var priority over .env
    // files). Without this, a local VITE_PLAYTRACE_ENDPOINT adds the "Quit &
    // feedback" pause-menu row, shifting the menu layout and breaking the
    // coordinate-based menu tests on that machine but not in CI. Pinning it
    // empty makes the suite match the open-source default everywhere. Set via
    // `env` (not a `VAR= cmd` command prefix) so it works on Windows too — a
    // POSIX-style prefix is parsed as part of the command by cmd/PowerShell.
    env: { VITE_PLAYTRACE_ENDPOINT: '' },
    port: 5173,
    // Always launch our own server (never reuse). Reuse would silently skip the
    // `env` pin above when a dev already has `npm run dev` running on :5173 with
    // their own .env.local — reintroducing the non-determinism this config exists
    // to remove. The small cold-start cost buys a deterministic playtrace-off run.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
