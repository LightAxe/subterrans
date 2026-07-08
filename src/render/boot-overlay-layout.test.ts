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
} from './boot-overlay-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';
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
    expect(DIFFICULTY_EASY_RECT).toEqual({ x: 180, y: 260, w: 140, h: 40 });
    expect(DIFFICULTY_NORMAL_RECT).toEqual({ x: 330, y: 260, w: 140, h: 40 });
    expect(DIFFICULTY_HARD_RECT).toEqual({ x: 480, y: 260, w: 140, h: 40 });
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
