// tests/helpers/geometry.ts
// Single source of truth for the canvas-local click geometry the Playwright specs
// need (#240). The layout modules are pure and Phaser-free, so we evaluate them at
// the default (800×592) layout here and export the resulting rects — deleting the
// hand-duplicated literals every spec used to keep "in sync" by hand.
//
// Importing ui-scene.ts (Phaser) would crash the Node runner, but these modules
// don't touch Phaser: layout.ts→sprites.ts (zero imports), pause-menu-layout.ts /
// save-load-dialog-layout.ts (type-only cross-imports), boot-overlay-layout.ts
// (#304 — type-only imports of LayoutContext and the sim's WorldState, erased at
// runtime), sprites.ts (zero imports), hud-layout.ts (#238 — type-only import
// of LayoutContext; the VIEW_TOGGLE rect now comes from buildHudLayout), and
// hud-controls.ts (#320 — its only runtime import is input-glyphs.ts, which has
// none).
import { DEFAULT_LAYOUT } from '../../src/render/layout.js';
import { pauseMenuItems, type PauseMenuRenderContext } from '../../src/render/pause-menu-layout.js';
import {
  saveLoadDialogItems,
  type SaveLoadDialogContext,
} from '../../src/render/save-load-dialog-layout.js';
import { buildHudLayout } from '../../src/render/hud-layout.js';
import { TOOL_ORDER, toolButtonRect } from '../../src/render/hud-controls.js';
import { newGameScreenLayout, type Difficulty } from '../../src/render/boot-overlay-layout.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Center point of a canvas-local rect (what a canvas click targets). */
export const centerOf = (r: Rect): { x: number; y: number } => ({
  x: r.x + r.w / 2,
  y: r.y + r.h / 2,
});

// CI pins VITE_PLAYTRACE_ENDPOINT empty (playwright.config), so the main menu is
// the 4-row open-source variant (no "Quit & feedback"): resume, save-load,
// settings, debug-snapshot.
const MAIN: PauseMenuRenderContext = {
  saveLoadEnabled: true,
  currentPheromoneOverlay: false,
  currentHintStripVisible: true,
  currentSpeedMultiplier: 1,
  quitAndSurveyEnabled: false,
};

const mainItems = pauseMenuItems('main', MAIN, DEFAULT_LAYOUT);
const settingsItems = pauseMenuItems('settings', MAIN, DEFAULT_LAYOUT);

/** Pause-menu main page: Save/Load is row index 1, Settings is index 2. */
export const SAVE_LOAD_ROW_RECT: Rect = mainItems[1]!.rect;
export const SETTINGS_ROW_RECT: Rect = mainItems[2]!.rect;
/** Settings page (5 rows): pheromone toggle is index 0, speed cycle is index 3. */
export const PHEROMONE_TOGGLE_RECT: Rect = settingsItems[0]!.rect;
export const SPEED_ROW_RECT: Rect = settingsItems[3]!.rect;

const DLG: SaveLoadDialogContext = {
  hasCompatibleSave: true,
  hasIncompatibleSave: false,
  confirming: { delete: false, newGame: false },
};
const dialogItems = saveLoadDialogItems(DLG, DEFAULT_LAYOUT);
/** Save/Load dialog: Save Now is index 1, Delete is index 2. */
export const DIALOG_SAVE_NOW_RECT: Rect = dialogItems[1]!.rect;
export const DIALOG_DELETE_RECT: Rect = dialogItems[2]!.rect;

/** HUD view-toggle button (surface ↔ underground). */
export const VIEW_TOGGLE_RECT: Rect = buildHudLayout(DEFAULT_LAYOUT).VIEW_TOGGLE;
/** C1 — colony alarm toggle, drawn on both views. */
export const ALARM_TOGGLE_RECT: Rect = buildHudLayout(DEFAULT_LAYOUT).ALARM_TOGGLE;
/** Underground colony toggle ("Your Colony [X]"), drawn on the underground view only. */
export const COLONY_TOGGLE_RECT: Rect = buildHudLayout(DEFAULT_LAYOUT).UNDERGROUND_COLONY_TOGGLE;
/** The tool palette's three buttons (Command / Dig / Chamber), left to right. */
export const TOOL_BUTTON_RECTS: readonly Rect[] = TOOL_ORDER.map((_, i) =>
  toolButtonRect(i, buildHudLayout(DEFAULT_LAYOUT).TOOLS),
);

// Boot-overlay rects re-exported from the Phaser-free module (the same source
// ui-scene.ts uses), so specs import their click targets from one place.
export {
  SAVE_PROMPT_CONTINUE_RECT,
  SAVE_PROMPT_NEW_GAME_RECT,
  GAME_OVER_RESTART_RECT,
} from '../../src/render/boot-overlay-layout.js';

// #304 — the new-game screen: three radio-style difficulty rows and the single
// Start button, evaluated from the same pure layout function the overlay draws
// from. Clicking a row only moves the selection; Start (or Enter) begins the
// round — see tests/helpers/boot.ts for the shared drive-to-Playing helper.
const newGame = newGameScreenLayout(DEFAULT_LAYOUT);
/** Difficulty rows keyed by tier. */
export const DIFFICULTY_ROW_RECTS: Readonly<Record<Difficulty, Rect>> = newGame.difficultyRows;
/** The "Start game" button. */
export const NEW_GAME_START_RECT: Rect = newGame.startButton;
export type { Difficulty };
