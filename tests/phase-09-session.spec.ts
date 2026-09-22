// code/tests/phase-09-session.spec.ts
// Phase 9 — SCEN-01 (fresh boot) + SCEN-04 (save-prompt flow) Playwright coverage.
// Mirror conventions from tests/smoke.spec.ts (Phase 8 baseline).

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

// #240 — canvas-click geometry imported from the single source of truth
// (tests/helpers/geometry.ts evaluates the pure, Phaser-free layout modules), so
// these coordinates are no longer hand-kept "in sync" with ui-scene.ts.
import {
  SAVE_PROMPT_CONTINUE_RECT,
  SAVE_PROMPT_NEW_GAME_RECT,
  SAVE_LOAD_ROW_RECT,
  DIALOG_SAVE_NOW_RECT,
} from './helpers/geometry.js';
// #304 — the new-game screen is two steps (pick a difficulty row, press Start);
// the shared helper drives it so every spec boots the same way.
import { clickCanvasRect, settleToPlaying } from './helpers/boot.js';

const errorFilter = (msg: ConsoleMessage) => msg.type() === 'error';
const SAVE_KEY = 'subterrans:save:v3';

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

// Assert the boot reached the new-game screen (S5 / #304) and NOT a real
// Continue/New Game SavePrompt. Both overlays report activeOverlay ===
// 'save-prompt' (ui-scene.ts reuses that HUD state for DifficultySelect), so the
// reported activeOverlay alone cannot tell them apart. The __phase9_ui.bootScreen
// discriminator (published alongside activeOverlay) distinguishes them:
// 'difficulty-select' for the fresh-boot overlay vs 'save-prompt' for a real
// Continue/New Game prompt. Pinning bootScreen === 'difficulty-select' keeps the
// "no SavePrompt on fresh boot" contract honest — a regression that showed a real
// SavePrompt would otherwise pass silently (settleToPlaying's Normal-row rect
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
// new-game screen — both report activeOverlay 'save-prompt', so the
// bootScreen discriminator is what makes this honest. Without it, a SCEN-04 test
// whose seeded save failed to load would silently fall through to the new-game
// screen and still "see" save-prompt (the #192 masking bug).
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

    // No leftover save → fresh boot opens the new-game screen (S5 / #304), not
    // a Continue/New Game SavePrompt. Verify the overlay is DifficultySelect
    // (the "no SavePrompt on fresh boot" contract) before starting a round.
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
    // (the new-game screen, not a SavePrompt). Verify the overlay is
    // DifficultySelect before starting a round to reach Playing.
    await expectFreshBootDifficultyOverlay(page);
    await settleToPlaying(page);
  });
});

// SCEN-04 exercises the boot SavePrompt against a REAL, current-format save
// captured via seedRealSave() (Save Now on a live game) — the prior
// hand-crafted MINIMAL_SAVE_FIXTURE was a stale v1 envelope the v3 deserializer
// rejected, so it produced no loadable save (the boot showed the new-game screen,
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
    // Assert bootScreen too: both this and the new-game screen report activeOverlay
    // 'save-prompt', so bootScreen === 'save-prompt' is what proves it's the REAL
    // prompt (the boot accepted hasSave() && !hasIncompatibleSave()), not a
    // fresh-boot fall-through.
    await expect.poll(() => getActiveOverlay(page), { timeout: 5_000 }).toBe('save-prompt');
    await expectBootSavePrompt(page);

    // #304 — Enter is the new-game screen's start key ONLY. On a real
    // Continue/New Game SavePrompt it must do nothing: no Continue, no New
    // Game, the prompt still up.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await expectBootSavePrompt(page);
    expect(await getActiveOverlay(page)).toBe('save-prompt');

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
    await expectBootSavePrompt(page); // real Continue/New Game prompt, not the new-game screen

    await clickCanvasRect(page, SAVE_PROMPT_NEW_GAME_RECT);

    // New Game deletes the save (deleteSave) then opens the new-game screen
    // (S5 / #304); Start boots fresh into Playing.
    await settleToPlaying(page);
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
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
    // Fresh boot opens the new-game screen (S5 / #304); Start a round to reach
    // Playing before exercising the Tab/X keybinds.
    await settleToPlaying(page);
    await page.waitForTimeout(300);

    // Focus the canvas so key events land on the window listener Phaser
    // registered (a click outside the canvas subtree would leave focus where
    // the preceding SavePrompt tests put it).
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
    // Phase 08-04 decision (keydown-TAB with event.repeat ignored — #306: the
    // old JustDown poll dropped a press whose down+up shared a frame, which is
    // exactly what page.keyboard.press sends). Poll the hook for the label
    // going truthy as a proxy for "UIScene has run at least one update frame
    // since boot", then press Tab and assert the VIEW flipped — the label
    // reads "Your Colony" on the surface too, so it cannot prove that.
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
    const readView = async (): Promise<string | undefined> => {
      return page.evaluate(() => {
        const w = window as unknown as { __phase9_ui?: { activeView?: string } };
        return w.__phase9_ui?.activeView;
      });
    };
    await expect.poll(readView, { timeout: 5_000 }).toBe('surface');
    await page.keyboard.press('Tab');
    await expect.poll(readView, { timeout: 5_000 }).toBe('underground');

    // Read the HUD label via the __phase9_ui hook. Plan 09.1-02 Task 2
    // extends the hook with `activeUndergroundLabel: 'Your Colony' | 'Enemy Colony'`
    // so Playwright doesn't need OCR against the canvas.
    const readLabel = async (): Promise<string | undefined> => {
      return page.evaluate(() => {
        const w = window as unknown as { __phase9_ui?: { activeUndergroundLabel?: string } };
        return w.__phase9_ui?.activeUndergroundLabel;
      });
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

  test('#306 — a Tab whose keydown and keyup land in the same frame still toggles the view', async ({
    page,
  }) => {
    // The old implementation polled Phaser.Input.Keyboard.JustDown(tab) in
    // update(). Phaser processes key events synchronously at DOM dispatch and
    // Key.onUp clears `_justDown`, so a press whose keydown and keyup both
    // arrived before the next frame — a fast tap across a frame hitch, or
    // exactly what page.keyboard.press sends — was already "up" when update()
    // polled, and was dropped. Dispatching both events synchronously makes
    // the same-frame case deterministic instead of a ~1-in-N flake: this test
    // fails against the JustDown poll every time and passes with the
    // keydown-TAB listener.
    await clearSave(page);
    await page.reload();
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 10_000 });
    await settleToPlaying(page);

    const readView = async (): Promise<string | undefined> => {
      return page.evaluate(() => {
        const w = window as unknown as { __phase9_ui?: { activeView?: string } };
        return w.__phase9_ui?.activeView;
      });
    };
    const readLabel = async (): Promise<string | undefined> => {
      return page.evaluate(() => {
        const w = window as unknown as { __phase9_ui?: { activeUndergroundLabel?: string } };
        return w.__phase9_ui?.activeUndergroundLabel;
      });
    };
    // The hook publishing 'surface' proves UIScene has run at least one frame
    // in Playing — no fixed sleep needed. Then focus the canvas (centre: clear
    // of every HUD zone).
    await expect.poll(readView, { timeout: 5_000 }).toBe('surface');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await page.evaluate(() => {
      const init = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', init));
      window.dispatchEvent(new KeyboardEvent('keyup', init));
    });
    await expect.poll(readView, { timeout: 5_000 }).toBe('underground');

    // A held key toggles exactly once. Two separate checks, each with an EVEN
    // toggle count on failure so parity cannot mask a double-toggle:
    //  (a) OS auto-repeat: the repeat keydown arrives in a LATER frame (two
    //      rAFs, so Phaser's POST_STEP has cleared its event queue) carrying
    //      `repeat: true` and must be ignored — one keydown, one repeat.
    //  (b) A burst within ONE frame — keydown, repeat keydown, keyup, each a
    //      separate dispatch so Phaser re-walks its still-uncleared queue on
    //      every one. Without a Key object the plugin re-emits the ORIGINAL
    //      keydown (repeat: false) on the keyup walk and the view toggles
    //      TWICE — back where it started, which is what this asserts against.
    //      The Key object makes Phaser stamp every re-walked keydown as a
    //      repeat while the key is down, and the identity dedupe drops any
    //      re-walk that slips past it, so it toggles exactly once.
    //  (c) The window the Key cannot cover — keydown, keyup, then ANOTHER key's
    //      keydown in the same frame: Tab's keyup has reset the Key, so the
    //      re-walked original keydown arrives with repeat: false. Identity
    //      dedupe (a WeakSet of handled events) must drop it: exactly one
    //      toggle, and the X that followed lands in the new view.
    // Synthetic events get DISTINCT, deterministic timeStamps (Chromium
    // coarsens the constructor's clock, and Phaser's duplicate bailout compares
    // code + timeStamp + type — identical stamps would hide the re-walk).
    const twoFrames = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await page.evaluate(() => {
      const init = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', init));
    });
    await expect.poll(readView, { timeout: 5_000 }).toBe('surface');
    await twoFrames();
    await page.evaluate(() => {
      const init = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', { ...init, repeat: true }));
    });
    await twoFrames();
    expect(await readView()).toBe('surface');
    await page.evaluate(() => {
      const init = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keyup', init));
    });
    await twoFrames();

    await page.evaluate(() => {
      const init = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
      const stamped = (type: string, extra: KeyboardEventInit, ts: number): KeyboardEvent => {
        const ev = new KeyboardEvent(type, { ...init, ...extra });
        Object.defineProperty(ev, 'timeStamp', { value: ts });
        return ev;
      };
      const base = performance.now() + 1000;
      window.dispatchEvent(stamped('keydown', {}, base));
      window.dispatchEvent(stamped('keydown', { repeat: true }, base + 1));
      window.dispatchEvent(stamped('keyup', {}, base + 2));
    });
    await twoFrames();
    expect(await readView()).toBe('underground');

    // (c) keydown, keyup, then X's keydown in the same task, from underground:
    // Tab must toggle exactly once (→ surface) — the re-walked Tab keydown after
    // the keyup is the same event object and must be ignored. X is underground-
    // only and the view is now surface, so the label must NOT flip.
    await twoFrames();
    await page.evaluate(() => {
      const stamped = (type: string, init: KeyboardEventInit, ts: number): KeyboardEvent => {
        const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
        Object.defineProperty(ev, 'timeStamp', { value: ts });
        return ev;
      };
      const base = performance.now() + 2000;
      window.dispatchEvent(stamped('keydown', { key: 'Tab', code: 'Tab', keyCode: 9 }, base));
      window.dispatchEvent(stamped('keyup', { key: 'Tab', code: 'Tab', keyCode: 9 }, base + 1));
      window.dispatchEvent(stamped('keydown', { key: 'x', code: 'KeyX', keyCode: 88 }, base + 2));
      window.dispatchEvent(stamped('keyup', { key: 'x', code: 'KeyX', keyCode: 88 }, base + 3));
    });
    await twoFrames();
    expect(await readView()).toBe('surface');
    expect(await readLabel()).toBe('Your Colony');
  });
});
