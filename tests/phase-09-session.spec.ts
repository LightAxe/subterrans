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

// Matches PRD §8a envelope: { version, seed, inputLog, snapshot }.
// snapshot is schema-correct (all 11 WorldState fields present per types.ts:23-39) but empty.
// Purpose: trip hasSave() + loadSave() → SavePrompt overlay renders. We do NOT
// assert the loaded world's tick value; no in-browser save helper exists to
// build a real snapshot (see Step 1 of this task's action).
const MINIMAL_SAVE_FIXTURE = {
  version: 1,
  seed: 42,
  inputLog: [],
  snapshot: {
    tick: 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: [],
    ants: {
      posX: [],
      posY: [],
      colonyId: [],
      task: [],
      subTask: [],
      speed: [],
      foodCarrying: [],
      starvationTimer: [],
      age: [],
      alive: [],
      lifespan: [],
      zone: [],
      digTileX: [],
      digTileY: [],
      digTicksRemaining: [],
      targetPosX: [],
      targetPosY: [],
      // Phase 09.1 Chunk 0 — grid-of-occupancy byte (new SoA field). Empty
      // array matches the empty ants fixture; deserializeWorldState must
      // accept the field on round-trip.
      currentGridColonyId: [],
    },
    colonies: {},
    pheromoneGrids: {},
    surface: { width: 0, height: 0, data: [] },
    undergroundGrids: {},
    foodPiles: [],
    pendingChambers: {},
  },
};

async function clearSave(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((key) => window.localStorage.removeItem(key), SAVE_KEY);
}

async function seedSave(page: Page, fixture: unknown): Promise<void> {
  await page.goto('/');
  await page.evaluate(([key, json]) => window.localStorage.setItem(key as string, json as string), [
    SAVE_KEY,
    JSON.stringify(fixture),
  ] as const);
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

// QUARANTINED (issue #192): MINIMAL_SAVE_FIXTURE is a stale v1-era envelope the
// current v3 deserializer rejects, so seedSave produces no loadable save — boot
// shows the Choose Difficulty overlay (which also reports activeOverlay
// 'save-prompt') instead of a real Continue/New Game SavePrompt. These tests need
// the capture-a-real-save fixture rework (see #192). Not a game bug.
test.describe.fixme('Phase 9 — SCEN-04 save-prompt flow', () => {
  test('seeded save → SavePrompt overlay appears → Continue dismisses overlay', async ({
    page,
  }) => {
    await seedSave(page, MINIMAL_SAVE_FIXTURE);
    await page.reload();

    // Overlay renders — proves hasSave() + loadSave() accepted the envelope shape.
    // Canvas-drawn; observe via the __phase9_ui hook exported by Plan 09-06.
    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('save-prompt');

    // SavePrompt buttons are Phaser.GameObjects.Text rendered to canvas — NOT DOM.
    // Playwright cannot reliably query canvas text. Click via canvas-relative
    // coordinates using the button-rect constants exported by Plan 06 Task 3.
    // Pattern mirrors code/tests/smoke.spec.ts:88-99 (VIEW_TOGGLE click).
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    const R = SAVE_PROMPT_CONTINUE_RECT;
    await page.mouse.click(box.x + R.x + R.w / 2, box.y + R.y + R.h / 2);

    // Overlay dismissed — hook flips back to 'none'.
    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('none');

    // Canvas still up (no crash-on-load — the minimal snapshot was accepted by deserializeWorldState).
    await expect(page.locator('canvas').first()).toBeVisible();

    // NOTE: we do not assert world tick/rngState here. The minimal snapshot is empty-but-valid;
    // asserting loaded-state richness would require an in-browser save helper which no plan exposes.
  });

  test('seeded save → SavePrompt "New Game" clears save and boots fresh', async ({ page }) => {
    await seedSave(page, MINIMAL_SAVE_FIXTURE);
    await page.reload();

    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('save-prompt');

    const canvas2 = page.locator('canvas').first();
    const box2 = await canvas2.boundingBox();
    if (!box2) throw new Error('canvas has no bounding box');
    const R2 = SAVE_PROMPT_NEW_GAME_RECT;
    await page.mouse.click(box2.x + R2.x + R2.w / 2, box2.y + R2.y + R2.h / 2);

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
    await page.mouse.click(box.x + 10, box.y + 10);
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
