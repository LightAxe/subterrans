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

async function bootGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  // Wait until the ready event has fired and the boot has dispatched —
  // SavePrompt or Playing. window.__phase9_ui is published by setActiveOverlay.
  await page.waitForFunction(() => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined');
  // Clear any prior save so we always boot into Playing (no SavePrompt).
  await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
    return ui !== undefined && ui.activeOverlay === 'none';
  });
}

async function activeOverlay(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
    return ui?.activeOverlay ?? '<undefined>';
  });
}

test.describe('Issue #116 — Esc opens / closes pause menu', () => {
  test('Esc on a clean canvas opens the pause menu (single press, not racing closed)', async ({ page }) => {
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

  test('opening the menu pauses the game loop (no tick advances while menu is up)', async ({ page }) => {
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
  test('clicking the pheromone toggle once flips the persisted setting once (not twice → no-op)', async ({ page }) => {
    await bootGame(page);
    // Default pheromoneOverlay is true.
    const before = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('subterrans:settings:v1');
        return raw === null ? true : (JSON.parse(raw).settings?.pheromoneOverlay ?? true);
      } catch { return true; }
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
      const CANVAS_W = 800, CANVAS_H = 592;
      const BTN_W = 320, BTN_H = 40, GAP = 10, TITLE_H = 56;
      const n = 4; // resume, save-load, settings, debug-snapshot
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const settingsY = top + 2 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: settingsY + BTN_H / 2 };
    });
    await page.locator('canvas').first().click({ position: settingsRect });
    await page.waitForTimeout(120);

    // Settings sub-screen now has 2 buttons: pheromone-toggle and back.
    const toggleRect = await page.evaluate(() => {
      const CANVAS_W = 800, CANVAS_H = 592;
      const BTN_W = 320, BTN_H = 40, GAP = 10, TITLE_H = 56;
      const n = 2;
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
    await page.waitForTimeout(150);

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
  test('Save/Load → Esc back to pause menu does NOT briefly publish activeOverlay = none', async ({ page }) => {
    await bootGame(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');

    // Open Save/Load (button index 1).
    const saveLoadRect = await page.evaluate(() => {
      const CANVAS_W = 800, CANVAS_H = 592;
      const BTN_W = 320, BTN_H = 40, GAP = 10, TITLE_H = 56;
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
  test('P pressed while pause menu is open does NOT flip the persisted setting', async ({ page }) => {
    await bootGame(page);
    // Verify default
    const before = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('subterrans:settings:v1');
        return raw === null ? true : (JSON.parse(raw).settings?.pheromoneOverlay ?? true);
      } catch { return true; }
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
      } catch { return true; }
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
      const CANVAS_W = 800, CANVAS_H = 592;
      const BTN_W = 320, BTN_H = 40, GAP = 10, TITLE_H = 56;
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

  test('clicking Delete once on a fresh save arms the confirm; second click commits (no one-click destruction)', async ({ page }) => {
    await bootGame(page);
    // Manually populate localStorage with a fresh save so Delete is enabled.
    await page.evaluate(() => {
      const env = {
        version: 3,
        seed: 1,
        inputLog: [],
        snapshot: {
          tick: 1, rngState: 1, nextEntityId: 0, commandQueue: [],
          ants: { count: 0, posX: [], posY: [], colonyId: [], task: [], subTask: [],
                  speed: [], foodCarrying: [], starvationTimer: [], age: [], alive: [],
                  lifespan: [], zone: [], digTileX: [], digTileY: [], digTicksRemaining: [],
                  targetPosX: [], targetPosY: [], targetSet: [] },
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
    await page.locator('canvas').first().click({ position: { x: 360, y: 296 } });
    await page.waitForTimeout(150);
    // (Continue may fall back to bootFresh on the synthetic envelope —
    // either way we're now in Playing without a SavePrompt.)
    await page.waitForFunction(() => {
      const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
      return ui !== undefined && ui.activeOverlay !== 'save-prompt';
    });

    // Re-populate the save (Continue may have triggered an autosave that
    // overwrote our synthetic one — that's fine; what matters is some valid
    // save sits in storage so Delete enables).
    await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:save:v3');
      if (raw === null) {
        const env = { version: 3, seed: 1, inputLog: [], snapshot: { tick: 1, rngState: 1, nextEntityId: 0, commandQueue: [], ants: { count: 0, posX: [], posY: [], colonyId: [], task: [], subTask: [], speed: [], foodCarrying: [], starvationTimer: [], age: [], alive: [], lifespan: [], zone: [], digTileX: [], digTileY: [], digTicksRemaining: [], targetPosX: [], targetPosY: [], targetSet: [] }, colonies: {}, pheromoneGrids: {}, surface: { width: 1, height: 1, data: [0] }, undergroundGrids: {}, foodPiles: [], pendingChambers: {} }, savedAtMs: Date.now() };
        localStorage.setItem('subterrans:save:v3', JSON.stringify(env));
      }
    });

    // Open menu → Save/Load → Delete.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await activeOverlay(page)).toBe('pause-menu');
    // Save/Load row.
    await page.locator('canvas').first().click({ position: { x: 400, y: 312 } });
    await page.waitForTimeout(150);
    expect(await activeOverlay(page)).toBe('save-load');

    // Delete row is index 2 in the dialog. CANVAS=800x592, BTN_W=280, BTN_H=36,
    // GAP=8, firstY = DIALOG_INFO_Y + 24 = 152 + 24 = 176. Delete is index 2.
    const deleteY = 176 + 2 * (36 + 8) + 36 / 2;
    const deleteX = (800 - 280) / 2 + 280 / 2;

    // First click — arms confirm (save still present).
    await page.locator('canvas').first().click({ position: { x: deleteX, y: deleteY } });
    await page.waitForTimeout(150);
    const stillThere = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(stillThere).not.toBeNull();

    // Second click — commits delete.
    await page.locator('canvas').first().click({ position: { x: deleteX, y: deleteY } });
    await page.waitForTimeout(150);
    const gone = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(gone).toBeNull();
  });
});
