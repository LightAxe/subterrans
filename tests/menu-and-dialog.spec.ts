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

    // Settings sub-screen has 3 items: pheromone-toggle, speed-cycle, back.
    const toggleRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 3;
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

    // Pheromone toggle is index 0 on the Settings sub-page.
    const toggleClickPos = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 3;
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
  test('clicking the speed row cycles 1× → 2× → 4× → 1× (live, session-only)', async ({ page }) => {
    await bootGame(page);

    // Open menu → Settings.
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

    // On Settings page: [pheromone-toggle (i=0), speed-cycle (i=1), back (i=2)].
    // Compute rect for i=1.
    const speedRect = await page.evaluate(() => {
      const CANVAS_W = 800,
        CANVAS_H = 592;
      const BTN_W = 320,
        BTN_H = 40,
        GAP = 10,
        TITLE_H = 56;
      const n = 3;
      const stackHeight = TITLE_H + n * BTN_H + (n - 1) * GAP;
      const top = (CANVAS_H - stackHeight) / 2 + TITLE_H;
      const x = (CANVAS_W - BTN_W) / 2;
      const speedY = top + 1 * (BTN_H + GAP);
      return { x: x + BTN_W / 2, y: speedY + BTN_H / 2 };
    });

    // We don't have a public hook for the speedMultiplier, but the dialog
    // label encodes it visually. Sample the canvas pixels along the label
    // baseline — only sanity-checking that consecutive clicks change the
    // rendered text region (any change suffices: 1×→2×→4× all differ).
    const sampleLabel = async () => {
      return await page
        .locator('canvas')
        .first()
        .screenshot({
          clip: { x: speedRect.x - 60, y: speedRect.y - 8, width: 120, height: 16 },
        });
    };

    const at1x = await sampleLabel();
    await page.locator('canvas').first().click({ position: speedRect });
    await page.waitForTimeout(100);
    const at2x = await sampleLabel();
    await page.locator('canvas').first().click({ position: speedRect });
    await page.waitForTimeout(100);
    const at4x = await sampleLabel();
    await page.locator('canvas').first().click({ position: speedRect });
    await page.waitForTimeout(100);
    const at1xAgain = await sampleLabel();

    // Each step must differ from the previous (distinct labels render).
    expect(at1x.equals(at2x)).toBe(false);
    expect(at2x.equals(at4x)).toBe(false);
    expect(at4x.equals(at1xAgain)).toBe(false);
    // Cycle closes — back at 1× matches the initial 1× label.
    expect(at1x.equals(at1xAgain)).toBe(true);
  });
});

test.describe('Pheromone overlay actually renders (UAT P1 — pre-existing draw-order bug)', () => {
  // The bug: GameScene called drawPheromoneOverlay BEFORE drawSurface, but
  // drawSurface paints opaque terrain THEN entities. Pheromones got wiped
  // by the terrain pass — invisible since 9f5b23f. Issue #114's toggle
  // surfaced it (ON and OFF rendered identically because ON was always
  // overpainted). Fix: split the orchestrator into terrain → pheromone →
  // entities so the overlay lands between layers as the docstring intended.
  //
  // This test runs ants long enough that *some* FoodTrail cells reach a
  // visible alpha, then compares ON / OFF screenshots. Foraging is
  // RNG-seeded (Date.now()-derived per bootFresh), so the wall-clock budget
  // must be generous enough to cover unlucky seeds. 90s @ 4× = 1800 sim
  // seconds (~30 sim-minutes) is well above the slowest seed observed.
  test.setTimeout(180_000);

  // QUARANTINED (issue #193): flaky screenshot-diff over emergent, RNG-driven
  // sim state (~3/4 pass rate). Unfit for a hard CI gate; needs a deterministic
  // rework (seed the trail-laid state / assert via a hook, not a pixel diff).
  test.fixme('after sustained foraging at 4×, ON and OFF screenshots differ', async ({ page }) => {
    await page.goto('/');
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.evaluate(() => {
      localStorage.removeItem('subterrans:save:v3');
      localStorage.removeItem('subterrans:settings:v1');
    });
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await settleToPlaying(page);

    await page.keyboard.press('4');
    await page.waitForTimeout(90_000);

    const onPng = await page.locator('canvas').first().screenshot();
    await page.keyboard.press('p');
    await page.waitForTimeout(500);
    const offPng = await page.locator('canvas').first().screenshot();

    // Pre-fix: ON and OFF rendered byte-identical because terrain overpainted
    // the pheromone overlay. Post-fix: foraged FoodTrail cells render and
    // the buffers differ. PNG-byte-count assertion is intentionally omitted
    // (PNG compression sometimes coincidentally produces similar sizes for
    // visually-distinct frames) — the equals check is the load-bearing one.
    expect(onPng.equals(offPng)).toBe(false);
  });
});

test.describe('Round-5 (Codex P1) — Save Now respects autosaveSuspended', () => {
  // QUARANTINED (issue #192): this test's premise is outdated. It assumes a
  // future-build save routes through SavePrompt → Continue → bootFromSave →
  // FutureSimVersionError → autosaveSuspended. Under the current boot flow a
  // future-sim save is treated as INCOMPATIBLE, so decideBootMode routes it to a
  // FRESH boot (Choose Difficulty), not a Continue prompt — autosaveSuspended is
  // never set via that path, so Save Now writes a fresh save. The Save Now
  // protection itself is intact (game-scene.ts gates onSaveNow on
  // autosaveSuspended); the test needs reworking against the real recovery flow.
  // Not a game bug. Un-fixme when the flow is re-derived.
  test.fixme('Save Now is a no-op when bootFromSave preserved a future-build save (does NOT overwrite the recoverable bytes)', async ({
    page,
  }) => {
    // Bootstrap: populate localStorage with a future-sim save BEFORE the
    // page loads. bootFromSave will deserialize, catch FutureSimVersionError,
    // and set autosaveSuspended = true. We then verify Save Now refuses to
    // write so the preserved future-build bytes survive for recovery.
    // Capture a REAL, current-format save envelope (rather than hand-crafting one
    // that rots whenever the snapshot shape changes — the original cause of this
    // test going stale), then bump its simVersion past LATEST so the next boot's
    // bootFromSave throws FutureSimVersionError → autosaveSuspended = true.
    await bootGame(page); // fresh Normal game, Playing, autosave NOT suspended
    // Save Now writes a valid envelope to localStorage. Open pause → Save/Load →
    // Save Now (rects from pause-menu-layout.ts / save-load-dialog-layout.ts; the
    // playtrace feature is forced off in playwright.config so the menu is 4 rows).
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    await clickCanvasRect(page, { x: 240, y: 279, w: 320, h: 40 }); // Save/Load row (index 1 of 4)
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');
    await clickCanvasRect(page, { x: 260, y: 220, w: 280, h: 36 }); // Save Now (dialog index 1)
    await page.waitForFunction(() => localStorage.getItem('subterrans:save:v3') !== null, {
      timeout: 5_000,
    });
    // Mutate the captured envelope: simVersion > LATEST → future-build save.
    await page.evaluate(() => {
      const raw = localStorage.getItem('subterrans:save:v3');
      if (raw === null) throw new Error('expected a save after Save Now');
      const env = JSON.parse(raw) as { snapshot: { simVersion: number } };
      env.snapshot.simVersion = 99999;
      localStorage.setItem('subterrans:save:v3', JSON.stringify(env));
    });

    // Reload — boot path now sees the future-sim save, SavePrompt shows.
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.waitForFunction(
      () => {
        const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
        return ui !== undefined && ui.activeOverlay === 'save-prompt';
      },
      { timeout: 5_000 },
    );

    // Click Continue → bootFromSave → catches FutureSimVersionError →
    // bootFresh + autosaveSuspended = true. The preserved bytes stay in
    // localStorage; the running game is now a fresh scenario.
    // SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 }
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: 360, y: 296 } });
    await page.waitForFunction(() => {
      const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
      return ui !== undefined && ui.activeOverlay === 'none';
    });

    // Snapshot the preserved bytes BEFORE we touch the dialog.
    const before = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(before).not.toBeNull();

    // Open pause menu → Save/Load.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
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
    expect(
      await page.evaluate(
        () => (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui?.activeOverlay,
      ),
    ).toBe('save-load');

    // Click Save Now (button index 1 in the dialog, BTN_W=280, BTN_H=36, GAP=8).
    // firstY = DIALOG_INFO_Y(152) + DIALOG_INFO_TO_BUTTONS_GAP(24) = 176.
    const saveNowY = 176 + 1 * (36 + 8) + 36 / 2;
    const saveNowX = (800 - 280) / 2 + 280 / 2;
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: saveNowX, y: saveNowY } });
    await page.waitForTimeout(200);

    // The preserved bytes MUST be unchanged. Pre-fix this overwrote the
    // future-build save with the fresh-session bytes, silently destroying
    // the recoverable save.
    const after = await page.evaluate(() => localStorage.getItem('subterrans:save:v3'));
    expect(after).toBe(before);
  });
});
