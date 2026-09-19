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
      // Exclude the touch-only specs (#237) — they need hasTouch and run in the
      // chromium-touch project below. Anchored to a basename starting with
      // `touch-` (leading slash) so a hypothetical `retouch-*.spec.ts` can't
      // sneak in, while future `touch-<feature>.spec.ts` (PR4 long-press, PR5
      // hover) match without a config change.
      // W3 adds jev-opponent.spec.ts, which needs a server WITH the Jev endpoint
      // configured and therefore runs in the chromium-jev project below.
      testIgnore: [/[\\/]touch-[^\\/]*\.spec\.ts$/, /[\\/]jev-opponent\.spec\.ts$/],
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
    {
      // #237 PR2 — touch project: same Chrome, but hasTouch so page.touchscreen /
      // CDP Input.dispatchTouchEvent deliver real touch pointers (activePointers:3
      // in main.ts then surfaces the 2nd finger to the arbiter). Same testMatch
      // anchor as the chromium testIgnore above, kept in sync deliberately.
      name: 'chromium-touch',
      testMatch: /[\\/]touch-[^\\/]*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        hasTouch: true,
        launchOptions: {
          args: ['--disable-gpu'],
        },
      },
    },
    {
      // W3 — the only project that boots with a Jev proxy endpoint configured, so
      // the opponent picker's interactive path (the standing-orders presets and
      // the DOM <textarea> mounted over the canvas) is reachable at all. It talks
      // to `webServer[1]` on :5174; every other project keeps the open-source
      // default (endpoint empty, Jev toggle disabled).
      name: 'chromium-jev',
      testMatch: /[\\/]jev-opponent\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5174',
        launchOptions: {
          args: ['--disable-gpu'],
        },
      },
    },
    {
      // #254 — WebKit/JSC axis for the cross-engine determinism proof. The
      // chromium project already covers Node↔V8; the actual Phase-6 target is
      // iOS Safari / WKWebView, which runs JSC (JavaScriptCore), not V8. Scoped
      // to ONLY the cross-engine spec — it's pure compute (no canvas/WebGL), so
      // WebKit-headless is low-flake, and the other specs (which need Chrome
      // WebGL/touch behavior) must NOT run under WebKit. Kept a distinct project
      // so a WebKit-only flake is attributable and never masks the chromium proof.
      name: 'webkit',
      testMatch: /[\\/]cross-engine-determinism\.spec\.ts$/,
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      // Force the playtrace feature OFF for e2e regardless of a developer's
      // .env.local (Vite gives an existing process.env var priority over .env
      // files). Without this, a local VITE_PLAYTRACE_ENDPOINT adds the "Quit &
      // feedback" pause-menu row, shifting the menu layout and breaking the
      // coordinate-based menu tests on that machine but not in CI. Pinning it
      // empty makes the suite match the open-source default everywhere. Set via
      // `env` (not a `VAR= cmd` command prefix) so it works on Windows too — a
      // POSIX-style prefix is parsed as part of the command by cmd/PowerShell.
      //
      // VITE_JEV_ENDPOINT is pinned empty for the same reason (W3): a developer's
      // .env.local would otherwise enable the Jev opponent, and the difficulty
      // overlay grows a standing-orders section when it is available — a layout
      // difference between that machine and CI. jev-opponent.spec.ts gets its own
      // server below instead of flipping this one.
      env: { VITE_PLAYTRACE_ENDPOINT: '', VITE_JEV_ENDPOINT: '' },
      port: 5173,
      // Always launch our own server (never reuse). Reuse would silently skip the
      // `env` pin above when a dev already has `npm run dev` running on :5173 with
      // their own .env.local — reintroducing the non-determinism this config exists
      // to remove. The small cold-start cost buys a deterministic playtrace-off run.
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // W3 — the chromium-jev project's server: same build, Jev endpoint SET, so
      // `isJevAvailable()` is true and the opponent picker's standing-orders
      // section actually renders. Without a second server the feature would have
      // no E2E coverage at all, since ui-scene.ts is excluded from the unit
      // coverage gate.
      //
      // The endpoint is the BASE path of the proxy (the client POSTs to
      // `<base>/session` and `<base>/beat`), and it points at a path that does
      // not exist AND is not under `/api` — vite.config proxies `/api` to the
      // deployed site, and an E2E run must never reach it. Flipping the feature
      // flag is the whole job; the controller's first request (the session mint)
      // then 404s locally, three failures in it fall back to the rule-based AI,
      // and that is a code path worth exercising anyway.
      command: 'npm run dev -- --port 5174 --strictPort',
      env: { VITE_PLAYTRACE_ENDPOINT: '', VITE_JEV_ENDPOINT: '/e2e-jev-stub-not-a-real-endpoint' },
      port: 5174,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
