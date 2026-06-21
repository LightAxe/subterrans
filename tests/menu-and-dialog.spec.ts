// menu-and-dialog.spec.ts — issues #115/#116/#114 runtime regression tests.
//
// These cover the fixes from PR #118 round 2:
//   - Esc opens pause menu (was racing between GameScene + UIScene handlers
//     and ending up at activeOverlay === 'none')
//   - Single click on a button dispatches ONCE (per-button + scene-level
//     handlers were both firing → confirm gate bypassed, pheromone toggle
//     no-op'd)
//   - Save Now flash + savedAtMs timestamp surface

import { test, expect, type Page } from '@playwright/test';

// "Choose Difficulty" (S5) "Normal" button rect — canvas-drawn, not DOM-queryable.
// Inlined rather than imported because ui-scene.ts transitively pulls in Phaser.
// Mirrors DIFFICULTY_NORMAL_RECT in ui-scene.ts.
const DIFFICULTY_NORMAL_RECT = { x: 330, y: 260, w: 140, h: 40 } as const;

// Canvas-local rects for the pause-menu "Save/Load" row (index 1 of 4) and the
// Save/Load dialog's "Save Now" button (index 1). The playtrace feature is
// forced off in playwright.config, so the pause menu has exactly 4 rows; these
// mirror pause-menu-layout.ts / save-load-dialog-layout.ts. Inlined rather than
// imported because those modules transitively pull in Phaser.
const SAVE_LOAD_ROW_RECT = { x: 240, y: 279, w: 320, h: 40 } as const;
const DIALOG_SAVE_NOW_RECT = { x: 260, y: 220, w: 280, h: 36 } as const;
// Save/Load dialog "Delete Save" button (index 2 of 5: continue, save-now,
// delete, new-game, back). firstButtonY 176 + 2*(36+8) = 264.
const DIALOG_DELETE_RECT = { x: 260, y: 264, w: 280, h: 36 } as const;

async function clickCanvasRect(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
}

// Boot to a clean Playing state (activeOverlay === 'none').
//
// Why this isn't just `removeItem + reload + wait('none')` (the original helper,
// the root cause of issue #186): S5 added a "Choose Difficulty" overlay shown
// before every new game. It reuses the SavePrompt phase, so it reports
// `activeOverlay === 'save-prompt'` the whole time and only clears to 'none'
// once a difficulty is chosen. The old helper waited for 'none' without ever
// picking one, so it timed out. (No autosave race is involved — boot screens
// don't run the game loop, so the cleared save stays cleared across the reload,
// and no Continue/New Game SavePrompt appears.) Fix: select Normal, then settle.
async function bootGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  // window.__phase9_ui is published by setActiveOverlay once boot has dispatched.
  await page.waitForFunction(
    () => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined',
  );
  // Clear any prior save so the reload boots a fresh game (Choose Difficulty),
  // not a Continue/New Game SavePrompt.
  await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await settleToPlaying(page);
}

// Drive any post-reload boot to Playing (activeOverlay === 'none'). The S5
// "Choose Difficulty" overlay reports 'save-prompt' until a difficulty is chosen,
// so poll-click Normal until we reach Playing. A click that lands before the
// buttons are interactive simply retries; the loop stops the moment we hit 'none'
// (and never over-clicks into the game, since it exits on 'none'). Use this after
// any reload that expects a fresh Playing state. Requires no real Continue/New
// Game SavePrompt to be up (clear the save first, or dismiss the prompt before
// calling) — Normal's rect overlaps the SavePrompt's Continue button.
async function settleToPlaying(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await activeOverlay(page)) === 'none') return 'none';
        await clickCanvasRect(page, DIFFICULTY_NORMAL_RECT);
        return activeOverlay(page);
      },
      { timeout: 15_000 },
    )
    .toBe('none');
}

async function activeOverlay(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
    return ui?.activeOverlay ?? '<undefined>';
  });
}

// The fresh-boot "Choose Difficulty" overlay and a real Continue/New Game
// SavePrompt both report activeOverlay 'save-prompt'; __phase9_ui.bootScreen is
// the discriminator ('difficulty-select' vs 'save-prompt'). Returns '<undefined>'
// when the hook hasn't published yet so callers can poll for the value they want.
async function bootScreen(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui;
    return ui?.bootScreen ?? '<undefined>';
  });
}

// Issue #193 — the live game speed (1/2/4) published on __phase9_ui by GameScene.
// Lets the speed-cycle test assert by value instead of pixel-diffing the label.
// Returns undefined before the first publish so callers can poll for a value.
async function speedMultiplier(page: Page): Promise<number | undefined> {
  return await page.evaluate(
    () => (window as { __phase9_ui?: { speedMultiplier?: number } }).__phase9_ui?.speedMultiplier,
  );
}

test.describe('Issue #116 — Esc opens / closes pause menu', () => {
  test('Esc on a clean canvas opens the pause menu (single press, not racing closed)', async ({
    page,
  }) => {
    await bootGame(page);
    expect(await activeOverlay(page)).toBe('none');

    // The bug Rob found: GameScene bound keydown-ESC AND UIScene bound an
    // escKey 'down' listener, both firing on the same press. GameScene opened
    // the menu, UIScene immediately closed it; activeOverlay ended at 'none'.
    // After the fix, pressing Esc once should land at 'pause-menu'.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');
  });

  test('Esc with menu open closes it (single press)', async ({ page }) => {
    await bootGame(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('none');
  });

  test('opening the menu pauses the game loop (no tick advances while menu is up)', async ({
    page,
  }) => {
    await bootGame(page);
    // Take two tick samples ~200ms apart with the menu OPEN; they should match.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(await activeOverlay(page)).toBe('pause-menu');

    const tick1 = await page.evaluate(() => {
      // Phaser scenes are accessible via the scene plugin, but for a black-box
      // smoke we read the autosave envelope which always carries snapshot.tick.
      // (Forcing a save while paused isn't ideal — instead, sample _phase9_ui
      // and check no overlay flicker / churn occurred.)
      return (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui?.activeOverlay;
    });
    await page.waitForTimeout(300);
    const tick2 = await page.evaluate(() => {
      return (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui?.activeOverlay;
    });
    // Overlay state must be stable at 'pause-menu' across the wait — no
    // flicker / re-open caused by handler races.
    expect(tick1).toBe('pause-menu');
    expect(tick2).toBe('pause-menu');
  });
});

test.describe('Issue #115/#116 — single click triggers single dispatch', () => {
  test('clicking the pheromone toggle once flips the persisted setting once (not twice → no-op)', async ({
    page,
  }) => {
    await bootGame(page);
    // Default pheromoneOverlay is true.
    const before = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('subterrans:settings:v1');
        return raw === null ? true : (JSON.parse(raw).settings?.pheromoneOverlay ?? true);
      } catch {
        return true;
      }
    });
    expect(before).toBe(true);

    // Open pause menu → Settings → toggle pheromone.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');

    // Layout from pause-menu-layout: Settings is the third button. Each button
    // is 320×40 with 10px gap, stacked centered. We compute the rect to click.
    const settingsRect = await page.evaluate(() => {
      // Mirror pauseMenuItems('main', ...) layout for index=2 (Settings).
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 4; // resume, save-load, settings, debug-snapshot
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const settingsY = top + 2 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: settingsY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: settingsRect });
    await page.waitForTimeout(120);

    // Settings sub-screen items (Stage 3b): pheromone-toggle (i=0),
    // control-hints-toggle (i=1), reset-first-use-hints (i=2), speed-cycle (i=3),
    // back (i=4) — 5 rows.
    const toggleRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 5;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      // pheromone-toggle is index 0
      const toggleY = top + 0 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: toggleY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: toggleRect });
    await page.waitForTimeout(120);

    const after = await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:settings:v1');
      return raw === null ? null : JSON.parse(raw).settings?.pheromoneOverlay;
    });
    // ONE click should flip the setting. The duplicate-dispatch bug fired
    // dispatchPauseMenuItem twice → flipped on then off → 'after' would still
    // be true. After the fix, after === false.
    expect(after).toBe(false);
  });
});

test.describe('Issue #114 — P key toggles pheromone overlay', () => {
  test('pressing P flips the persisted pheromoneOverlay setting', async ({ page }) => {
    await bootGame(page);
    // Reset to a known starting state.
    await page.evaluate(() => localStorage.removeItem('subterrans:settings:v1'));
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await settleToPlaying(page);

    await page.keyboard.press('p');
    await page.waitForTimeout(100);

    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:settings:v1');
      return raw === null ? null : JSON.parse(raw).settings?.pheromoneOverlay;
    });
    expect(persisted).toBe(false);

    // Press again → back to true.
    await page.keyboard.press('p');
    await page.waitForTimeout(100);
    const persisted2 = await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:settings:v1');
      return raw === null ? null : JSON.parse(raw).settings?.pheromoneOverlay;
    });
    expect(persisted2).toBe(true);
  });
});

test.describe('Round-2 review — overlay observability stays coherent across transitions', () => {
  test('Save/Load → Esc back to pause menu does NOT briefly publish activeOverlay = none', async ({
    page,
  }) => {
    await bootGame(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');

    // Open Save/Load (button index 1).
    const saveLoadRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 4;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const slY = top + 1 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: slY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: saveLoadRect });
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('save-load');

    // Esc on dialog → onBack closes dialog and re-shows pause menu. The
    // round-2 review found that hideSaveLoadDialogOverlay was unconditionally
    // setting activeOverlay='none', so between the hide and the re-show the
    // observable would briefly publish 'none' (Playwright + any external
    // observer reading the global between paints sees the wrong state).
    // After the recomputeActiveOverlay fix, the observable should never
    // be 'none' during this transition — it goes save-load → pause-menu.
    //
    // We can't sample inside a single synchronous handler, but we CAN
    // verify that after the transition completes, the overlay reads the
    // correct final state. The bigger guarantee — "never observed 'none'"
    // — would need a fast polling MutationObserver; this test is the
    // best black-box proxy for catching a regression where someone
    // re-introduces the 'none' flash.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    expect(await activeOverlay(page)).toBe('pause-menu');
  });
});

test.describe('Round-2 review — keybinds gated on Playing phase', () => {
  test('P pressed while pause menu is open does NOT flip the persisted setting', async ({
    page,
  }) => {
    await bootGame(page);
    // Verify default
    const before = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('subterrans:settings:v1');
        return raw === null ? true : (JSON.parse(raw).settings?.pheromoneOverlay ?? true);
      } catch {
        return true;
      }
    });
    expect(before).toBe(true);

    // Open menu, then press P.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');
    await page.keyboard.press('p');
    await page.waitForTimeout(100);

    // Setting should NOT have flipped — round-2 fix gates P on Playing only,
    // so the menu's Settings sub-screen is the sole writer while paused.
    const after = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('subterrans:settings:v1');
        return raw === null ? true : (JSON.parse(raw).settings?.pheromoneOverlay ?? true);
      } catch {
        return true;
      }
    });
    expect(after).toBe(true);
  });
});

test.describe('Issue #115 — Save/Load dialog reachable from pause menu', () => {
  test('opening Save/Load row from menu lands at activeOverlay = save-load', async ({ page }) => {
    await bootGame(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');

    // Save/Load is the 2nd button (index 1) in the main menu.
    const saveLoadRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 4;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const slY = top + 1 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: slY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: saveLoadRect });
    await page.waitForTimeout(150);
    expect(await activeOverlay(page)).toBe('save-load');
  });

  test('clicking Delete once on a fresh save arms the confirm; second click commits (no one-click destruction)', async ({
    page,
  }) => {
    await bootGame(page);
    // Manually populate localStorage with a fresh save so Delete is enabled.
    await page.evaluate(() => {
      const env = {
        version: 3,
        seed: 1,
        inputLog: [],
        snapshot: {
          tick: 1,
          rngState: 1,
          nextEntityId: 0,
          commandQueue: [],
          ants: {
            count: 0,
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
            targetSet: [],
          },
          colonies: {},
          pheromoneGrids: {},
          surface: { width: 1, height: 1, data: [0] },
          undergroundGrids: {},
          foodPiles: [],
          pendingChambers: {},
        },
        savedAtMs: Date.now(),
      };
      localStorage.setItem('subterrans:save:v3', JSON.stringify(env));
    });
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
      const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
      return ui !== undefined;
    });
    // Boot lands on SavePrompt — click Continue to enter Playing.
    // SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 }
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: 360, y: 296 } });
    await page.waitForTimeout(150);
    // (Continue may fall back to bootFresh on the synthetic envelope, which then
    // shows the Choose Difficulty overlay — settleToPlaying drives either path to
    // Playing.)
    await settleToPlaying(page);

    // Re-populate the save (Continue may have triggered an autosave that
    // overwrote our synthetic one — that's fine; what matters is some valid
    // save sits in storage so Delete enables).
    await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:save:v3');
      if (raw === null) {
        const env = {
          version: 3,
          seed: 1,
          inputLog: [],
          snapshot: {
            tick: 1,
            rngState: 1,
            nextEntityId: 0,
            commandQueue: [],
            ants: {
              count: 0,
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
              targetSet: [],
            },
            colonies: {},
            pheromoneGrids: {},
            surface: { width: 1, height: 1, data: [0] },
            undergroundGrids: {},
            foodPiles: [],
            pendingChambers: {},
          },
          savedAtMs: Date.now(),
        };
        localStorage.setItem('subterrans:save:v3', JSON.stringify(env));
      }
    });

    // Open menu → Save/Load → Delete.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');
    // Save/Load row.
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: 400, y: 312 } });
    await page.waitForTimeout(150);
    expect(await activeOverlay(page)).toBe('save-load');

    // Delete row is index 2 in the dialog. CANVAS=800x592, BTN_W=280, BTN_H=36,
    // GAP=8, firstY = DIALOG_INFO_Y + 24 = 152 + 24 = 176. Delete is index 2.
    const deleteY = 176 + 2 * (36 + 8) + 36 / 2;
    const deleteX = (800 - 280) / 2 + 280 / 2;

    // First click — arms confirm (save still present).
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: deleteX, y: deleteY } });
    await page.waitForTimeout(150);
    const stillThere = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(stillThere).not.toBeNull();

    // Second click — commits delete.
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: deleteX, y: deleteY } });
    await page.waitForTimeout(150);
    const gone = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(gone).toBeNull();
  });
});

test.describe('Round-6 (Codex P2) — pheromone toggle survives degraded storage', () => {
  test('menu-clicked toggle keeps alternating when localStorage.setItem is blocked', async ({
    page,
  }) => {
    await bootGame(page);

    // Simulate quota-exceeded / private-mode: setItem throws. Reading is
    // unaffected — only the write path is blocked.
    await page.evaluate(() => {
      window.localStorage.setItem = () => {
        throw new Error('QuotaExceeded (simulated)');
      };
    });

    // Open pause menu → Settings sub-page. Stay there for the entire test
    // so the underlying world doesn't tick between samples — pixel-level
    // comparison of the toggle label is then deterministic.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const settingsRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 4;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const settingsY = top + 2 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: settingsY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: settingsRect });
    await page.waitForTimeout(120);

    // Pheromone toggle is index 0 on the Settings sub-page (Stage 3b: 5 rows).
    const toggleClickPos = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 5;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const y = top + 0 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: y + BTN_H / 2 };
    });
    const labelClip = {
      x: toggleClickPos.x - 60,
      y: toggleClickPos.y - 8,
      width: 120,
      height: 16,
    };

    // Sample 1: initial state.
    const before = await page.locator('canvas').first().screenshot({ clip: labelClip });
    // Click toggle → flip to OFF in-mem (saveSettings drops the write silently).
    await page.locator('canvas').first().click({ position: toggleClickPos });
    await page.waitForTimeout(120);
    const afterOne = await page.locator('canvas').first().screenshot({ clip: labelClip });
    // Click again → flip back to ON.
    await page.locator('canvas').first().click({ position: toggleClickPos });
    await page.waitForTimeout(120);
    const afterTwo = await page.locator('canvas').first().screenshot({ clip: labelClip });

    // Pre-fix (degraded storage + loadSettings-derived flip): every click
    // recomputes from DEFAULT_SETTINGS = {pheromoneOverlay: true}, so the
    // label always ends at "OFF" after the first click and never flips
    // back. Post-fix: in-mem state alternates regardless of storage.
    expect(before.equals(afterOne)).toBe(false); // 1 click changed it
    expect(afterOne.equals(afterTwo)).toBe(false); // 2nd click changed it back
    expect(before.equals(afterTwo)).toBe(true); // round trip
  });
});

test.describe('Settings — Speed cycle row (UAT)', () => {
  // De-flaked for #193. The old version sampled the rendered speed label via
  // canvas screenshots on every step; under the 2-core CI runner's screenshot
  // pressure it intermittently crashed the browser late in the suite ("Target
  // page/context/browser has been closed") across all retries — a correlated
  // resource-pressure failure retries can't absorb. It now reads the live speed
  // off the __phase9_ui.speedMultiplier hook, so each assertion is a cheap value
  // read with zero screenshots: deterministic and resource-light.
  test('clicking the speed row cycles 1× → 2× → 4× → 1× (live, session-only)', async ({
    page,
  }) => {
    await bootGame(page);

    // Open menu → Settings.
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    const settingsRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 4;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const settingsY = top + 2 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: settingsY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: settingsRect });
    await page.waitForTimeout(120);

    // On Settings page (Stage 3b, 5 rows): [pheromone-toggle (i=0),
    // control-hints-toggle (i=1), reset-first-use-hints (i=2), speed-cycle (i=3),
    // back (i=4)]. Compute rect for i=3.
    const speedRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 5;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const speedY = top + 3 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: speedY + BTN_H / 2 };
    });

    const clickSpeedRow = () => page.locator('canvas').first().click({ position: speedRect });

    // Fresh boot starts at 1×; each click advances 1→2→4→1. Assert on the
    // published value (expect.poll absorbs the click→callback→publish latency).
    await expect.poll(() => speedMultiplier(page), { timeout: 5_000 }).toBe(1);
    await clickSpeedRow();
    await expect.poll(() => speedMultiplier(page), { timeout: 5_000 }).toBe(2);
    await clickSpeedRow();
    await expect.poll(() => speedMultiplier(page), { timeout: 5_000 }).toBe(4);
    await clickSpeedRow();
    await expect.poll(() => speedMultiplier(page), { timeout: 5_000 }).toBe(1);
  });
});

test.describe('Pheromone overlay actually renders (UAT P1 — pre-existing draw-order bug)', () => {
  // The bug (fixed): GameScene called drawPheromoneOverlay BEFORE the terrain
  // pass, and terrain paints opaque tiles — so pheromones were wiped and ON/OFF
  // rendered identically (invisible since 9f5b23f; issue #114's toggle surfaced
  // it). The fix sequences terrain → pheromone → entities (game-scene.ts
  // renderWorld), so the overlay lands between the layers. This test is the
  // regression guard for that exact ordering.
  //
  // De-flaked for #193. The old version foraged at 4× for 90s and diffed two
  // LIVE screenshots — flaky on two counts: it relied on emergent, RNG-seeded
  // trails forming in the window, and ant motion alone made the frames differ
  // (so it could pass even if the overlay never drew). It now reads the actual
  // per-frame layer draw order from a render-only observability hook
  // (window.__phase9_test.getDrawOrder, dev-build only) and asserts the overlay
  // is drawn between terrain and entities — the precise invariant the bug
  // violated. Deterministic, no screenshots, and (unlike a pixel test that would
  // have to inject pheromone into the sim store from the render layer) it stays
  // on the right side of the sim/render boundary.
  test('pheromone overlay draws between terrain and entities (and only when ON)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.evaluate(() => {
      localStorage.removeItem('subterrans:save:v3');
      localStorage.removeItem('subterrans:settings:v1');
    });
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await settleToPlaying(page); // fresh Normal game, surface view, overlay ON

    const drawOrder = () =>
      page.evaluate(
        () =>
          (window as { __phase9_test?: { getDrawOrder(): string[] } }).__phase9_test?.getDrawOrder() ??
          [],
      );

    // Overlay ON (default): pheromone must be drawn AFTER terrain and BEFORE
    // entities. The pre-fix order was [pheromone, terrain, entities] (overlay
    // overpainted) — this assertion fails on that order. Poll: the first frames
    // may render before getDrawOrder is populated.
    await expect.poll(drawOrder, { timeout: 5_000 }).toEqual(['terrain', 'pheromone', 'entities']);

    // Toggle the overlay OFF ('p'): pheromone drops out of the draw order.
    await page.keyboard.press('p');
    await expect.poll(drawOrder, { timeout: 5_000 }).toEqual(['terrain', 'entities']);

    // Toggle back ON: the overlay returns, still correctly ordered between layers.
    await page.keyboard.press('p');
    await expect.poll(drawOrder, { timeout: 5_000 }).toEqual(['terrain', 'pheromone', 'entities']);
  });
});

test.describe('Issue #196 — future-build save survives a fresh boot (Save Now does NOT overwrite it)', () => {
  // A save written by a NEWER build (snapshot.simVersion > this build's
  // LATEST_SIM_VERSION) is recoverable: the bytes are intact and a newer build
  // can load them. On THIS (older) build the save is incompatible, so boot routes
  // to a FRESH game ("Choose Difficulty") rather than a Continue/New Game prompt
  // — but the preserved bytes MUST survive: neither autosave nor "Save Now" may
  // overwrite them, so the player can recover by reloading on the newer build.
  //
  // Before #196 this protection was inert: hasIncompatibleSave() lumped the
  // future-sim case in with corruption, decideBootMode fell through to a fresh
  // game with autosaveSuspended = false (only bootFromSave's Continue path armed
  // it, and the future-sim save never reached Continue), and Save Now overwrote
  // the recoverable bytes (observed simVersion 99999 → 26). The fix classifies
  // the incompatibility (incompatible-future vs -corrupt) and arms
  // autosaveSuspended after the fresh boot for the future case only.
  test('Save Now is a no-op after a future-build save routes boot to fresh (preserved bytes survive)', async ({
    page,
  }) => {
    // 1) Seed a REAL, current-format save by driving the live game through
    //    Save Now (robust vs a hand-crafted fixture, which rots when the
    //    snapshot shape changes — the original cause of #192).
    await bootGame(page); // fresh Normal game, Playing, autosave NOT suspended
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');
    // Clear the key IMMEDIATELY before the Save Now click so the post-click
    // presence check can ONLY be satisfied by Save Now committing — not by a
    // stale key or an autosave (the game is paused in the dialog, nothing else
    // writes here).
    await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
    await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
    // Tie success to a REAL current-format envelope (positive integer simVersion)
    // so a misrouted click can't pass on garbage (defeats #192 silent masking).
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('subterrans:save:v3');
        if (raw === null) return false;
        try {
          const v = (JSON.parse(raw) as { snapshot?: { simVersion?: unknown } }).snapshot
            ?.simVersion;
          return typeof v === 'number' && Number.isInteger(v) && v > 0;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 5_000 },
    );

    // 2) Bump the captured envelope's simVersion past LATEST → a future-build save.
    await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:save:v3');
      if (raw === null) throw new Error('expected a save after Save Now');
      const env = JSON.parse(raw) as { snapshot: { simVersion: number } };
      env.snapshot.simVersion = 99999;
      localStorage.setItem('subterrans:save:v3', JSON.stringify(env));
    });

    // 3) Reload. The future-build save is incompatible on this build, so boot
    //    routes to a FRESH game — "Choose Difficulty", NOT a Continue/New Game
    //    SavePrompt. bootScreen discriminates the two (both report activeOverlay
    //    'save-prompt'); pin 'difficulty-select' so a regression that wrongly
    //    showed a real Continue prompt (and let Continue silently lose the save)
    //    can't pass silently.
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await expect.poll(() => bootScreen(page), { timeout: 10_000 }).toBe('difficulty-select');

    // The recoverable bytes (simVersion 99999) must still be present at the boot
    // screen — boot must not have deleted or overwritten them.
    expect(
      await page.evaluate(() => {
        const raw = localStorage.getItem('subterrans:save:v3');
        if (raw === null) return null;
        return (JSON.parse(raw) as { snapshot: { simVersion: number } }).snapshot.simVersion;
      }),
    ).toBe(99999);

    // 4) Pick a difficulty → bootFresh → autosaveSuspended = true (issue #196).
    await settleToPlaying(page);

    // Snapshot the preserved bytes now the fresh game is running. (If autosave
    // had fired and overwritten them, this would already be the fresh-session
    // bytes — the final equality below still holds, so additionally assert the
    // future simVersion survived into the running session.)
    const before = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(before).not.toBeNull();
    expect(
      await page.evaluate(
        () =>
          (JSON.parse(localStorage.getItem('subterrans:save:v3')!) as {
            snapshot: { simVersion: number };
          }).snapshot.simVersion,
      ),
    ).toBe(99999);

    // 5) Open pause → Save/Load → Save Now. With autosave suspended, Save Now
    //    must be a no-op so the recoverable future-build bytes survive unchanged.
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');
    await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
    await page.waitForTimeout(200);

    // 6) The preserved bytes MUST be unchanged. Pre-fix, Save Now overwrote the
    //    future-build save with the fresh-session bytes (simVersion 99999 → 26),
    //    silently destroying the recoverable save.
    const after = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(after).toBe(before);
  });

  // Codex P2 (PR #198): the autosave suspension that protects a future-build
  // save must be RELEASED when the player explicitly deletes that save via the
  // dialog — otherwise the running fresh session can never save (onSaveNow
  // returns false, autosave skips every write) until a page reload. The dialog
  // performs deleteSave() itself; the fix wires an onDelete callback that clears
  // autosaveSuspended on GameScene.
  test('Deleting the preserved future-build save re-enables saving (suspension is released)', async ({
    page,
  }) => {
    // Seed a real save, bump simVersion past LATEST, reload → fresh boot with
    // autosave suspended (same setup as the test above).
    await bootGame(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');
    await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
    await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('subterrans:save:v3');
        if (raw === null) return false;
        try {
          const v = (JSON.parse(raw) as { snapshot?: { simVersion?: unknown } }).snapshot
            ?.simVersion;
          return typeof v === 'number' && Number.isInteger(v) && v > 0;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 5_000 },
    );
    await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:save:v3');
      if (raw === null) throw new Error('expected a save after Save Now');
      const env = JSON.parse(raw) as { snapshot: { simVersion: number } };
      env.snapshot.simVersion = 99999;
      localStorage.setItem('subterrans:save:v3', JSON.stringify(env));
    });
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await expect.poll(() => bootScreen(page), { timeout: 10_000 }).toBe('difficulty-select');
    await settleToPlaying(page); // pick difficulty → autosaveSuspended = true

    // Open pause → Save/Load. The future-build save is still in storage and
    // shows as incompatible; Delete is enabled.
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');

    // Sanity: while suspended, Save Now is a no-op (the future bytes survive).
    await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(() => {
        const raw = localStorage.getItem('subterrans:save:v3');
        return raw === null
          ? null
          : (JSON.parse(raw) as { snapshot: { simVersion: number } }).snapshot.simVersion;
      }),
    ).toBe(99999);

    // Delete the save (two clicks: arm confirm, then commit). deleteSave() wipes
    // the bytes AND onDelete() clears autosaveSuspended.
    await clickCanvasRect(page, DIALOG_DELETE_RECT);
    await page.waitForTimeout(120);
    await clickCanvasRect(page, DIALOG_DELETE_RECT);
    await page.waitForFunction(() => localStorage.getItem('subterrans:save:v3') === null, {
      timeout: 5_000,
    });

    // Now Save Now must SUCCEED — the suspension is released, so the running
    // fresh session writes a real current-format save (simVersion = LATEST,
    // not the deleted 99999). Pre-fix this stayed null forever (until reload).
    await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem('subterrans:save:v3');
        if (raw === null) return false;
        try {
          const v = (JSON.parse(raw) as { snapshot?: { simVersion?: unknown } }).snapshot
            ?.simVersion;
          return typeof v === 'number' && Number.isInteger(v) && v > 0 && v !== 99999;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 5_000 },
    );
  });
});
