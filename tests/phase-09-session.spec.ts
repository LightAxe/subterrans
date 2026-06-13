// code/tests/phase-09-session.spec.ts
// Phase 9 — SCEN-01 (fresh boot) + SCEN-04 (save-prompt flow) Playwright coverage.
// Mirror conventions from tests/smoke.spec.ts (Phase 8 baseline).

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

// Canvas-coordinate click rects from Plan 09-06 Task 3 (ui-scene.ts lines 59-61).
// Inlined here (not imported) because ui-scene.ts transitively imports Phaser,
// which calls `window` at module load — crashing the Node.js Playwright runner
// before browser launch. Inline values must be kept in sync with ui-scene.ts.
// Phaser text overlay buttons are canvas-drawn; Playwright clicks by coordinate.
const SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 } as const;
const SAVE_PROMPT_NEW_GAME_RECT = { x: 300, y: 320, w: 120, h: 32 } as const;
// S5 "Choose Difficulty" Normal button (canvas-drawn). Mirrors DIFFICULTY_NORMAL_RECT in ui-scene.ts.
const DIFFICULTY_NORMAL_RECT = { x: 330, y: 260, w: 140, h: 40 } as const;
// Pause-menu "Save / Load" row — item index 1 of the 4-item main menu
// (Resume / Save·Load / Settings / Download debug log; playtrace off in CI so no
// 5th "Quit & feedback" row). Mirrors pause-menu-layout.ts stackRects(4)[1].
const SAVE_LOAD_ROW_RECT = { x: 240, y: 279, w: 320, h: 40 } as const;
// Save/Load dialog "Save Now" button — index 1. Mirrors save-load-dialog-layout.ts.
const DIALOG_SAVE_NOW_RECT = { x: 260, y: 220, w: 280, h: 36 } as const;

const errorFilter = (msg: ConsoleMessage) => msg.type() === 'error';
const SAVE_KEY = 'subterrans:save:v3';

// Pick "Normal" on the Choose Difficulty overlay (S5; shown before every new
// game) until the game reaches Playing (activeOverlay === 'none'). The overlay
// reports activeOverlay 'save-prompt', so poll-click Normal; the loop exits the
// moment we reach Playing. Use after a fresh-boot reload (no save). Safe only
// when no real Continue/New Game SavePrompt is up — Normal's rect overlaps the
// SavePrompt Continue button.
async function settleToPlaying(page: Page): Promise<void> {
  const canvas = page.locator('canvas').first();
  // Wait until UIScene.create() has published the hook. Until then
  // getActiveOverlay() returns '<undefined>' (NOT 'none'), so without this
  // guard the very first poll could read the absent hook, see a non-'none'
  // value, and the loop would never exit early on a still-booting page — but
  // more importantly the '<undefined>' sentinel keeps the loop from treating
  // an unpublished hook as a settled (Playing) game (vacuous pass).
  await page.waitForFunction(
    () => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined',
    undefined,
    { timeout: 15_000 },
  );
  await expect
    .poll(
      async () => {
        if ((await getActiveOverlay(page)) === 'none') return 'none';
        const box = await canvas.boundingBox();
        if (box) {
          const r = DIFFICULTY_NORMAL_RECT;
          await page.mouse.click(box.x + r.x + r.w / 2, box.y + r.y + r.h / 2);
        }
        return getActiveOverlay(page);
      },
      { timeout: 15_000 },
    )
    .toBe('none');
}

async function clickCanvasRect(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
}

// Raw activeOverlay read (returns the full string, incl. 'pause-menu'/'save-load'
// which the narrow ActiveOverlay type below doesn't enumerate).
async function rawOverlay(page: Page): Promise<string> {
  return page.evaluate(() => {
    const u = (window as { __phase9_ui?: { activeOverlay?: string } }).__phase9_ui;
    return u?.activeOverlay ?? '<undefined>';
  });
}

// Write a REAL, current-format save to localStorage by driving the running game
// through Save Now. Far more robust than a hand-crafted fixture, which rots
// whenever the snapshot shape changes (the original cause of #192). Leaves the
// game paused with the save written; callers reload() to exercise the boot
// SavePrompt against a genuinely loadable, compatible save.
async function seedRealSave(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await settleToPlaying(page); // fresh game → Playing
  await page.keyboard.press('Escape');
  await expect.poll(() => rawOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
  await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
  await expect.poll(() => rawOverlay(page), { timeout: 5_000 }).toBe('save-load');
  // Airtight assert-absent → click → assert-present: clear the key IMMEDIATELY
  // before the Save Now click so the post-click presence check can ONLY be
  // satisfied by Save Now committing — not by a stale key or an autosave that
  // could otherwise fire if settleToPlaying ran past AUTOSAVE_INTERVAL_MS on a
  // slow runner. (Game is paused in the dialog, so nothing else writes here.)
  await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
  await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
  // Tie success to Save Now writing a REAL current-format save: assert the
  // written envelope parses with a positive integer simVersion so a misrouted
  // click can't pass on garbage. (Defeats the #192 silent-masking failure mode.)
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('subterrans:save:v3');
      if (raw === null) return false;
      try {
        const v = (JSON.parse(raw) as { snapshot?: { simVersion?: unknown } }).snapshot?.simVersion;
        return typeof v === 'number' && Number.isInteger(v) && v > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 5_000 },
  );
}

// Canvas-safe overlay visibility probe. The SavePrompt / GameOver overlays are
// canvas-drawn (Phaser.GameObjects.Text), so DOM locators like getByText cannot
// see them. Plan 09-06 Task 3 exposes `window.__phase9_ui.activeOverlay` for
// out-of-canvas observability; Playwright polls it via page.evaluate.
type ActiveOverlay = 'none' | 'save-prompt' | 'game-over';

// Returns '<undefined>' (NOT 'none') when the hook has not been published yet,
// so callers can distinguish "boot has not reached create()" from the genuine
// Playing state (activeOverlay === 'none'). Collapsing the absent hook to 'none'
// lets settleToPlaying exit immediately on a still-booting page (vacuous pass).
async function getActiveOverlay(page: Page): Promise<ActiveOverlay | '<undefined>'> {
  return page.evaluate(() => {
    const w = window as unknown as { __phase9_ui?: { activeOverlay: ActiveOverlay } };
    return w.__phase9_ui?.activeOverlay ?? '<undefined>';
  }) as Promise<ActiveOverlay | '<undefined>'>;
}

// Assert the boot reached the "Choose Difficulty" overlay (S5) and NOT a real
// Continue/New Game SavePrompt. Both overlays report activeOverlay ===
// 'save-prompt' (ui-scene.ts reuses that HUD state for DifficultySelect), so the
// reported activeOverlay alone cannot tell them apart. The __phase9_ui.bootScreen
// discriminator (published alongside activeOverlay) distinguishes them:
// 'difficulty-select' for the fresh-boot overlay vs 'save-prompt' for a real
// Continue/New Game prompt. Pinning bootScreen === 'difficulty-select' keeps the
// "no SavePrompt on fresh boot" contract honest — a regression that showed a real
// SavePrompt would otherwise pass silently (settleToPlaying's Normal-click rect
// overlaps the SavePrompt Continue button and would still drive to 'none').
async function expectFreshBootDifficultyOverlay(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __phase9_ui?: { bootScreen?: string } };
          return w.__phase9_ui?.bootScreen ?? '<undefined>';
        }),
      { timeout: 5_000 },
    )
    .toBe('difficulty-select');
}

// Inverse of expectFreshBootDifficultyOverlay: assert the boot reached a REAL
// Continue/New Game SavePrompt (a compatible save exists), NOT the fresh-boot
// Choose Difficulty overlay — both report activeOverlay 'save-prompt', so the
// bootScreen discriminator is what makes this honest. Without it, a SCEN-04 test
// whose seeded save failed to load would silently fall through to Choose
// Difficulty and still "see" save-prompt (the #192 masking bug).
async function expectBootSavePrompt(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __phase9_ui?: { bootScreen?: string } };
          return w.__phase9_ui?.bootScreen ?? '<undefined>';
        }),
      { timeout: 5_000 },
    )
    .toBe('save-prompt');
}

async function clearSave(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((key) => window.localStorage.removeItem(key), SAVE_KEY);
}

test.describe('Phase 9 — SCEN-01 fresh boot', () => {
  test('fresh load with empty localStorage → scenario boots, canvas visible, no SavePrompt', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (errorFilter(m)) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await clearSave(page);
    await page.reload();

    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 10_000 });
    await expect(canvas).toBeVisible();

    // No leftover save → fresh boot opens "Choose Difficulty" (S5), not a
    // Continue/New Game SavePrompt. Verify the overlay is DifficultySelect (the
    // "no SavePrompt on fresh boot" contract) before selecting a difficulty.
    await expectFreshBootDifficultyOverlay(page);
    await settleToPlaying(page);

    // No runtime errors during fresh boot.
    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('corrupted save falls through to fresh boot (hasSave returns false)', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(([key]) => window.localStorage.setItem(key as string, 'not-valid-json'), [
      SAVE_KEY,
    ] as const);
    await page.reload();

    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 10_000 });
    await expect(canvas).toBeVisible();
    // Malformed JSON → loadSave returns null → hasSave() false → fresh boot
    // (Choose Difficulty, not a SavePrompt). Verify the overlay is DifficultySelect
    // before selecting a difficulty to reach Playing.
    await expectFreshBootDifficultyOverlay(page);
    await settleToPlaying(page);
  });
});

// SCEN-04 exercises the boot SavePrompt against a REAL, current-format save
// captured via seedRealSave() (Save Now on a live game) — the prior
// hand-crafted MINIMAL_SAVE_FIXTURE was a stale v1 envelope the v3 deserializer
// rejected, so it produced no loadable save (the boot showed Choose Difficulty,
// which also reports activeOverlay 'save-prompt', masking the failure). Fixed
// per #192.
test.describe('Phase 9 — SCEN-04 save-prompt flow', () => {
  test('seeded save → SavePrompt overlay appears → Continue dismisses overlay', async ({
    page,
  }) => {
    // Capture console errors: Continue now deserializes a REAL non-empty snapshot
    // (a much richer path than the old empty fixture), so a caught-but-broken load
    // could leave the canvas up at 'none' yet still be a failed load. Asserting
    // zero errors makes "load succeeded" honest (mirrors the X-keybind test).
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (errorFilter(m)) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await seedRealSave(page);
    await page.reload();

    // A real, compatible save exists → boot shows the Continue/New Game SavePrompt.
    // Assert bootScreen too: both this and Choose Difficulty report activeOverlay
    // 'save-prompt', so bootScreen === 'save-prompt' is what proves it's the REAL
    // prompt (the boot accepted hasSave() && !hasIncompatibleSave()), not a
    // fresh-boot fall-through.
    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('save-prompt');
    await expectBootSavePrompt(page);

    // SavePrompt buttons are canvas-drawn — click Continue by canvas-relative rect.
    await clickCanvasRect(page, SAVE_PROMPT_CONTINUE_RECT);

    // Continue → bootFromSave loads the compatible save → Playing ('none').
    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('none');
    await expect(page.locator('canvas').first()).toBeVisible();
    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('seeded save → SavePrompt "New Game" clears save and boots fresh', async ({ page }) => {
    await seedRealSave(page);
    await page.reload();

    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('save-prompt');
    await expectBootSavePrompt(page); // real Continue/New Game prompt, not Choose Difficulty

    await clickCanvasRect(page, SAVE_PROMPT_NEW_GAME_RECT);

    // New Game deletes the save (deleteSave) then opens Choose Difficulty (S5);
    // selecting a difficulty boots fresh into Playing.
    await settleToPlaying(page);
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key as string),
      SAVE_KEY,
    );
    expect(stored).toBeNull();
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Phase 09.1 Chunk 2 — enemy underground toggle (X keybind + HUD label)
//
// Added SKIPPED in Plan 09.1-02 Task 1 to avoid RED-on-main while Task 2
// lands the reducer + HUD label and Task 3 wires the X keybind. Task 3 flips
// `test.skip(...)` → `test(...)` so the spec goes green the same commit the
// keybind ships. The body is written up front so un-skipping is a one-line
// diff, not a rewrite.
// ---------------------------------------------------------------------------

test.describe('Phase 09.1 Chunk 2 — enemy underground toggle', () => {
  test('X keybind in underground view flips HUD label between Your Colony and Enemy Colony', async ({
    page,
  }) => {
    // Un-skipped by Plan 09.1-02 Task 3 (X keybind wired in game-scene.ts).
    // Exercises the full path:
    //   Tab (surface → underground) → HUD reads "Your Colony"
    //   X → flip → HUD reads "Enemy Colony"
    //   X → flip back → HUD reads "Your Colony"
    // and asserts no console errors fire during the sequence.
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (errorFilter(m)) consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await clearSave(page);
    await page.reload();
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 10_000 });
    // Fresh boot opens Choose Difficulty (S5); select a difficulty to reach
    // Playing before exercising the Tab/X keybinds.
    await settleToPlaying(page);
    await page.waitForTimeout(300);

    // Focus the canvas so key events land on the window listener Phaser
    // registered. Without this, Tab occasionally fails to fire JustDown
    // when running the full e2e suite (cross-suite state from the preceding
    // SavePrompt tests can leave focus outside the canvas subtree).
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    // Click the canvas CENTER, not the top-left: (box.x+10, box.y+10) lands
    // inside HUD.STATS ({x:8,y:8,w:200,h:24}), whose click toggles the
    // ant-activity panel OPEN. With X now gated through canAcceptWorldHotkey()
    // (which blocks while that panel is visible — intended), the later
    // page.keyboard.press('x') would be suppressed and the "Enemy Colony"
    // assertion would fail. The center is clear of every HUD zone, so it only
    // focuses the canvas.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);

    // Enter the underground view. Tab edge-triggers the view toggle per
    // Phase 08-04 decision (JustDown). Poll the hook for the label going
    // truthy as a proxy for "UIScene has run at least one update frame
    // since boot", then press Tab.
    await expect
      .poll(
        async () => {
          const v = await page.evaluate(
            () =>
              (
                window as unknown as {
                  __phase9_ui?: { activeUndergroundLabel?: string };
                }
              ).__phase9_ui?.activeUndergroundLabel,
          );
          return v ?? 'unset';
        },
        { timeout: 5_000 },
      )
      .toBe('Your Colony');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // Read the HUD label via the __phase9_ui hook. Plan 09.1-02 Task 2
    // extends the hook with `activeUndergroundLabel: 'Your Colony' | 'Enemy Colony'`
    // so Playwright doesn't need OCR against the canvas.
    const readLabel = async (): Promise<string | undefined> => {
      return page.evaluate(() => {
        const w = window as unknown as { __phase9_ui?: { activeUndergroundLabel?: string } };
        return w.__phase9_ui?.activeUndergroundLabel;
      }) as Promise<string | undefined>;
    };

    await expect.poll(readLabel, { timeout: 5_000 }).toBe('Your Colony');

    await page.keyboard.press('x');
    await page.waitForTimeout(150);
    await expect.poll(readLabel, { timeout: 5_000 }).toBe('Enemy Colony');

    await page.keyboard.press('x');
    await page.waitForTimeout(150);
    await expect.poll(readLabel, { timeout: 5_000 }).toBe('Your Colony');

    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });
});
