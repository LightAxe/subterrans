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
// jev-orders.ts (Jev opponent beta — zero imports; the preset count sizes the
// new-game screen's opponent section).
import { DEFAULT_LAYOUT } from '../../src/render/layout.js';
import { pauseMenuItems, type PauseMenuRenderContext } from '../../src/render/pause-menu-layout.js';
import {
  saveLoadDialogItems,
  type SaveLoadDialogContext,
} from '../../src/render/save-load-dialog-layout.js';
import { buildHudLayout } from '../../src/render/hud-layout.js';
import {
  newGameScreenLayout,
  newGameScreenWithOpponent,
  type Difficulty,
  type OpponentKind,
} from '../../src/render/boot-overlay-layout.js';
import { JEV_ORDERS_PRESETS } from '../../src/render/jev-orders.js';

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

// Jev opponent beta (#304 items 3–4) — the same screen on a build whose Jev
// endpoint is configured (the chromium-jev project), where an opponent section
// sits between the difficulty rows and Start. Its height follows the picker —
// caption + two rows with the Standard AI selected, plus the Jev options (preset
// buttons, free-text rect) once Jev is — and the stack re-centres around it, so
// the difficulty rows and Start are NOT where the plain-build rects above put
// them. Two rect sets, one per picker state, evaluated from the same pure layout
// function ui-scene.ts draws from; a spec clicks the set for the state the
// screen is in.
export interface JevBuildNewGameRects {
  difficultyRows: Readonly<Record<Difficulty, Rect>>;
  startButton: Rect;
  /** "Standard AI" / "Jev (beta)" radio rows, keyed by kind. */
  opponentRows: Readonly<Record<OpponentKind, Rect>>;
  /** The Jev options — present only in the Jev-selected set. */
  jev: { presetButtons: readonly Rect[]; textarea: Rect } | null;
}

function jevBuildRects(jevSelected: boolean): JevBuildNewGameRects {
  const { screen, opponent } = newGameScreenWithOpponent(DEFAULT_LAYOUT, {
    jevAvailable: true,
    jevSelected,
    presetCount: JEV_ORDERS_PRESETS.length,
  });
  if (opponent === null) throw new Error('jevAvailable: true must yield an opponent section');
  return {
    difficultyRows: screen.difficultyRows,
    startButton: screen.startButton,
    opponentRows: opponent.rows,
    jev:
      opponent.jev === null
        ? null
        : { presetButtons: opponent.jev.presetButtons, textarea: opponent.jev.textarea },
  };
}

/** The Jev-capable screen with the Standard AI row selected (how it opens on
 *  a fresh player). */
export const JEV_BUILD_RULES_SELECTED: JevBuildNewGameRects = jevBuildRects(false);
/** The Jev-capable screen with the Jev row selected — the Jev options are up
 *  and everything else has moved. */
export const JEV_BUILD_JEV_SELECTED: JevBuildNewGameRects = jevBuildRects(true);
/** Preset ids/labels/text, so the spec asserts against the shipped text, not a copy. */
export { JEV_ORDERS_PRESETS };
export type { OpponentKind };
