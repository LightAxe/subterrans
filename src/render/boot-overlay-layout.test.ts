// src/render/boot-overlay-layout.test.ts
// #240 — pins (a) the extracted boot-overlay rects and (b) the layout-function
// outputs that tests/helpers/geometry.ts reads, to the exact literals the
// Playwright specs used to hard-duplicate. If a layout change shifts any of these,
// this fails in `verify` (fast) instead of only surfacing in a slow e2e run — and
// proves the decoupling was a pure refactor (the plan's "mapping table" as tests).
//
// Re-derives from the SRC layout modules (not the tests/ helper) so it stays within
// tsc's rootDir; the helper simply reads indices [1]/[2] etc. of these same outputs,
// and the helper→spec wiring is covered end-to-end by the Playwright run.
import { describe, it, expect } from 'vitest';
import {
  SAVE_PROMPT_CONTINUE_RECT,
  SAVE_PROMPT_NEW_GAME_RECT,
  GAME_OVER_RESTART_RECT,
  DIFFICULTY_EASY_RECT,
  DIFFICULTY_NORMAL_RECT,
  DIFFICULTY_HARD_RECT,
  DIFFICULTY_TITLE_Y,
  DIFFICULTY_SUBTITLE_Y,
  DIFFICULTY_HINT_Y,
  opponentPickerLayout,
  type BootOverlayRect,
} from './boot-overlay-layout.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';
import { JEV_ORDERS_PRESETS } from './jev-orders.js';
import { pauseMenuItems, type PauseMenuRenderContext } from './pause-menu-layout.js';
import { saveLoadDialogItems, type SaveLoadDialogContext } from './save-load-dialog-layout.js';
import { buildHudLayout } from './hud-layout.js';

// Same contexts tests/helpers/geometry.ts uses (playtrace off → 4-row main menu).
const MAIN: PauseMenuRenderContext = {
  saveLoadEnabled: true,
  currentPheromoneOverlay: false,
  currentHintStripVisible: true,
  currentSpeedMultiplier: 1,
  quitAndSurveyEnabled: false,
};
const DLG: SaveLoadDialogContext = {
  hasCompatibleSave: true,
  hasIncompatibleSave: false,
  confirming: { delete: false, newGame: false },
};

describe('#240 boot-overlay rects are frozen (moved out of ui-scene.ts)', () => {
  it('holds the six boot-overlay rect values', () => {
    expect(SAVE_PROMPT_CONTINUE_RECT).toEqual({ x: 300, y: 280, w: 120, h: 32 });
    expect(SAVE_PROMPT_NEW_GAME_RECT).toEqual({ x: 300, y: 320, w: 120, h: 32 });
    expect(GAME_OVER_RESTART_RECT).toEqual({ x: 300, y: 345, w: 120, h: 32 });
    // W3 moved the difficulty row UP (y 260 -> 136) to make room for the
    // opponent section below it. x/w/h and the centered spacing are unchanged.
    expect(DIFFICULTY_EASY_RECT).toEqual({ x: 180, y: 136, w: 140, h: 40 });
    expect(DIFFICULTY_NORMAL_RECT).toEqual({ x: 330, y: 136, w: 140, h: 40 });
    expect(DIFFICULTY_HARD_RECT).toEqual({ x: 480, y: 136, w: 140, h: 40 });
  });
});

describe('#240 layout functions equal the specs’ former inline literals', () => {
  it('pause-menu main rows (playtrace off → 4 rows): save-load [1], settings [2]', () => {
    const main = pauseMenuItems('main', MAIN, DEFAULT_LAYOUT);
    expect(main[1]!.rect).toEqual({ x: 240, y: 279, w: 320, h: 40 });
    expect(main[2]!.rect).toEqual({ x: 240, y: 329, w: 320, h: 40 });
  });

  it('settings-page rows (5 rows): pheromone [0], speed [3]', () => {
    const settings = pauseMenuItems('settings', MAIN, DEFAULT_LAYOUT);
    expect(settings[0]!.rect).toEqual({ x: 240, y: 204, w: 320, h: 40 });
    expect(settings[3]!.rect).toEqual({ x: 240, y: 354, w: 320, h: 40 });
  });

  it('save/load dialog rows: save-now [1], delete [2]', () => {
    const dlg = saveLoadDialogItems(DLG, DEFAULT_LAYOUT);
    expect(dlg[1]!.rect).toEqual({ x: 260, y: 220, w: 280, h: 36 });
    expect(dlg[2]!.rect).toEqual({ x: 260, y: 264, w: 280, h: 36 });
  });

  it('HUD view-toggle button', () => {
    expect(buildHudLayout(DEFAULT_LAYOUT).VIEW_TOGGLE).toEqual({ x: 632, y: 396, w: 80, h: 24 });
  });
});

// ---------------------------------------------------------------------------
// W3 — opponent picker geometry
// ---------------------------------------------------------------------------

const PRESET_COUNT = JEV_ORDERS_PRESETS.length;

/** Every rect the opponent section draws, flattened for the whole-section sweeps
 *  (the two text anchors that aren't rects are checked separately). */
function allPickerRects(layout = DEFAULT_LAYOUT): BootOverlayRect[] {
  const geo = opponentPickerLayout(layout, PRESET_COUNT);
  return [geo.rulesButton, geo.jevButton, ...geo.presetButtons, geo.textarea];
}

function overlaps(a: BootOverlayRect, b: BootOverlayRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('W3 opponentPickerLayout', () => {
  it('builds one button per standing-orders preset', () => {
    expect(opponentPickerLayout(DEFAULT_LAYOUT, PRESET_COUNT).presetButtons).toHaveLength(
      PRESET_COUNT,
    );
    expect(PRESET_COUNT).toBe(4); // Balanced / Aggressive / Turtle / Economy
  });

  it('keeps every rect inside the 800x592 canvas', () => {
    for (const r of allPickerRects()) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(DEFAULT_LAYOUT.w);
      expect(r.y + r.h).toBeLessThanOrEqual(DEFAULT_LAYOUT.h);
    }
  });

  it('keeps every text anchor inside the canvas too', () => {
    const geo = opponentPickerLayout(DEFAULT_LAYOUT, PRESET_COUNT);
    for (const pt of [geo.kindLabel, geo.unavailableNote, geo.ordersLabel, geo.counter, geo.hint]) {
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(DEFAULT_LAYOUT.w);
      expect(pt.y).toBeGreaterThanOrEqual(0);
      // Leave room for a ~12px line of text below the anchor.
      expect(pt.y + 12).toBeLessThanOrEqual(DEFAULT_LAYOUT.h);
    }
  });

  it('never overlaps the difficulty row (which is still the start action)', () => {
    const difficulty = [DIFFICULTY_EASY_RECT, DIFFICULTY_NORMAL_RECT, DIFFICULTY_HARD_RECT];
    for (const picker of allPickerRects()) {
      for (const d of difficulty) {
        expect(overlaps(picker, d)).toBe(false);
      }
      // ...and sits strictly BELOW it, so the reading order is difficulty first.
      expect(picker.y).toBeGreaterThanOrEqual(DIFFICULTY_EASY_RECT.y + DIFFICULTY_EASY_RECT.h);
    }
  });

  it('never overlaps itself (rows stack, buttons in a row do not touch)', () => {
    const rects = allPickerRects();
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it('orders the rows top-to-bottom: kind toggles, presets, textarea', () => {
    const geo = opponentPickerLayout(DEFAULT_LAYOUT, PRESET_COUNT);
    expect(geo.kindLabel.y).toBeLessThan(geo.rulesButton.y);
    expect(geo.rulesButton.y + geo.rulesButton.h).toBeLessThanOrEqual(geo.unavailableNote.y);
    expect(geo.unavailableNote.y).toBeLessThan(geo.ordersLabel.y);
    expect(geo.ordersLabel.y).toBeLessThan(geo.presetButtons[0]!.y);
    const preset = geo.presetButtons[0]!;
    expect(preset.y + preset.h).toBeLessThanOrEqual(geo.textarea.y);
    expect(geo.textarea.y + geo.textarea.h).toBeLessThanOrEqual(geo.counter.y);
    expect(geo.counter.y).toBe(geo.hint.y); // same footer line
  });

  it('keeps the title / subtitle / hint above the difficulty row', () => {
    expect(DIFFICULTY_TITLE_Y).toBeLessThan(DIFFICULTY_SUBTITLE_Y);
    expect(DIFFICULTY_SUBTITLE_Y).toBeLessThan(DIFFICULTY_HINT_Y);
    expect(DIFFICULTY_HINT_Y).toBeLessThan(DIFFICULTY_EASY_RECT.y);
  });

  it('centers each row horizontally on the layout width', () => {
    const geo = opponentPickerLayout(DEFAULT_LAYOUT, PRESET_COUNT);
    const mid = DEFAULT_LAYOUT.w / 2;
    // Kind pair: the gap between the two buttons straddles the canvas center.
    expect((geo.rulesButton.x + geo.jevButton.x + geo.jevButton.w) / 2).toBe(mid);
    // Preset row: first-left and last-right are symmetric about the center.
    const first = geo.presetButtons[0]!;
    const last = geo.presetButtons[PRESET_COUNT - 1]!;
    expect(first.x - 0).toBe(DEFAULT_LAYOUT.w - (last.x + last.w));
    // Textarea + the unavailable note are centered too.
    expect(geo.textarea.x + geo.textarea.w / 2).toBe(mid);
    expect(geo.unavailableNote.x).toBe(mid);
  });

  it('reflows with the LayoutContext instead of a baked 800px width', () => {
    const wide = createLayoutContext(1000, 700);
    const geo = opponentPickerLayout(wide, PRESET_COUNT);
    expect(geo.textarea.x + geo.textarea.w / 2).toBe(500);
    expect(geo.unavailableNote.x).toBe(500);
    expect(geo.counter.x).toBe(geo.textarea.x + geo.textarea.w);
    // Row Ys are measured from the overlay top, so a taller canvas doesn't move
    // them — and everything still fits.
    expect(geo.textarea.y).toBe(opponentPickerLayout(DEFAULT_LAYOUT, PRESET_COUNT).textarea.y);
    for (const r of allPickerRects(wide)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(wide.w);
      expect(r.y + r.h).toBeLessThanOrEqual(wide.h);
    }
  });

  it('degenerates safely when asked for zero presets', () => {
    const geo = opponentPickerLayout(DEFAULT_LAYOUT, 0);
    expect(geo.presetButtons).toEqual([]);
    expect(geo.textarea.w).toBeGreaterThan(0);
  });
});
