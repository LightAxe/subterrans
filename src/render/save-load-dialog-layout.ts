// save-load-dialog-layout.ts — issue #115 Save/Load dialog layout + hit-testing.
//
// Pure-TypeScript module: no Phaser, no DOM. Mirrors pause-menu-layout's
// pattern so UIScene composes both overlays the same way.
//
// The dialog has a single page (no sub-screens). Destructive actions
// (delete save, new game over an existing save) confirm in place: the
// first click flips a per-button confirm flag and re-renders with the
// label changed to "Click to confirm"; the second click within the
// confirm window commits. Reset on Back / dialog close.
//
// Buttons:
//   - continue   — load the existing save and close everything (paused → resumed)
//   - save-now   — manualSave; flashes a "Saved" line for ~1s
//   - delete     — wipe the save; needs confirm if a save exists
//   - new-game   — discard + restart; needs confirm if a save exists
//   - back       — close the dialog, return to the pause menu (no game changes)

import type { SaveInfo } from '../platform/save.js';

// ---------------------------------------------------------------------------
// Geometry constants (canvas-local pixels — 800 × 592)
// ---------------------------------------------------------------------------

export const CANVAS_W = 800;
export const CANVAS_H = 592;

export const DIALOG_BUTTON_W = 280;
export const DIALOG_BUTTON_H = 36;
export const DIALOG_BUTTON_GAP = 8;

/** Pixels between the title row and the info line. */
export const DIALOG_TITLE_TO_INFO_GAP = 32;
/** Pixels between the info line and the first button. */
export const DIALOG_INFO_TO_BUTTONS_GAP = 24;
/** Title row Y center. */
export const DIALOG_TITLE_Y = 120;
/** Info line Y center. */
export const DIALOG_INFO_Y = DIALOG_TITLE_Y + DIALOG_TITLE_TO_INFO_GAP;

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

export type SaveLoadDialogItemId = 'continue' | 'save-now' | 'delete' | 'new-game' | 'back';

export interface DialogItemRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SaveLoadDialogItem {
  id: SaveLoadDialogItemId;
  label: string;
  enabled: boolean;
  /** True iff this row is currently in "click again to confirm" state.
   *  Cosmetic — UIScene renders confirm rows in a warning color and uses
   *  this to drive the second-click branch. */
  confirming: boolean;
  rect: DialogItemRect;
}

export interface SaveLoadDialogContext {
  /** parseSaveFile-readable save bytes exist. Drives Continue enable + the
   *  "save exists" branch in delete/new-game confirm. */
  hasCompatibleSave: boolean;
  /** Bytes exist under SAVE_KEY but parseSaveFile rejects them (issue #66
   *  scenario). Surfaces "Incompatible save present" in the info line and
   *  enables Delete so the player can clear them out. */
  hasIncompatibleSave: boolean;
  /** Per-row confirm flag — caller toggles on first click of a destructive
   *  action, clears on second click or any other user action. */
  confirming: { delete: boolean; newGame: boolean };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function buttonRects(buttonCount: number, firstY: number): DialogItemRect[] {
  const x = (CANVAS_W - DIALOG_BUTTON_W) / 2;
  const rects: DialogItemRect[] = [];
  for (let i = 0; i < buttonCount; i++) {
    rects.push({
      x,
      y: firstY + i * (DIALOG_BUTTON_H + DIALOG_BUTTON_GAP),
      w: DIALOG_BUTTON_W,
      h: DIALOG_BUTTON_H,
    });
  }
  return rects;
}

/** First button Y center derived from info row + the documented gap. */
export function firstButtonY(): number {
  return DIALOG_INFO_Y + DIALOG_INFO_TO_BUTTONS_GAP;
}

/** Compose the dialog items. Order is fixed; enabled flags reflect ctx. */
export function saveLoadDialogItems(ctx: SaveLoadDialogContext): SaveLoadDialogItem[] {
  const saveExists = ctx.hasCompatibleSave;
  const items: Array<{
    id: SaveLoadDialogItemId;
    label: string;
    enabled: boolean;
    confirming: boolean;
  }> = [
    {
      id: 'continue',
      label: 'Continue',
      enabled: saveExists,
      confirming: false,
    },
    {
      id: 'save-now',
      label: 'Save Now',
      enabled: true,
      confirming: false,
    },
    {
      id: 'delete',
      // Disabled when there is nothing to delete: no compatible save AND no
      // incompatible bytes. With incompatible bytes only, the row enables so
      // the player can clear them out and start fresh.
      label: ctx.confirming.delete ? 'Click to confirm delete' : 'Delete Save',
      enabled: saveExists || ctx.hasIncompatibleSave,
      confirming: ctx.confirming.delete,
    },
    {
      id: 'new-game',
      // New Game without a save just restarts; confirm is only needed when
      // a save exists (clicking would silently discard player progress).
      label: saveExists && ctx.confirming.newGame ? 'Click to confirm new game' : 'New Game',
      enabled: true,
      confirming: ctx.confirming.newGame,
    },
    {
      id: 'back',
      label: '<  Back',
      enabled: true,
      confirming: false,
    },
  ];
  const rects = buttonRects(items.length, firstButtonY());
  return items.map((it, i) => ({ ...it, rect: rects[i]! }));
}

// ---------------------------------------------------------------------------
// Info line composition
// ---------------------------------------------------------------------------

/** Compose the human-readable info line shown above the buttons. Pure text
 *  function so the dialog's only concern is rendering it.
 *
 *  Round-3 (Codex P2): the warning takes precedence over the saved-line.
 *  Without that ordering a future-sim save (parseable envelope, but
 *  simVersion > LATEST) would render as "Saved 14:30 · Tick 100 · …" while
 *  Continue is disabled — visually contradicting the disabled state. The
 *  warning wins so the disabled Continue and the info line tell the same
 *  story. */
export function formatSaveInfoLine(info: SaveInfo | null, hasIncompatibleSave: boolean): string {
  if (hasIncompatibleSave) {
    // Surfaces the issue #66 case where bytes exist but this build can't read
    // them (envelope parse fails OR snapshot.simVersion > LATEST_SIM_VERSION).
    // The player can Delete to clear them or click New Game to start fresh;
    // Continue stays disabled.
    return 'Incompatible save in storage — start a new game or delete it';
  }
  if (info !== null) {
    // Fresh save line: timestamp · tick · workers · food. Keep it terse — one
    // line. The timestamp is rendered as the user's local "HH:MM" because the
    // dialog is a "saved when?" UX, not a forensic log; "moments ago" feels
    // wrong inside an explicit save/load surface and a full date sprawls.
    return `Saved ${formatSaveTime(info.savedAtMs)}  ·  Tick ${info.tick}  ·  Workers ${info.playerWorkers}  ·  Food ${info.playerFoodStored}`;
  }
  return 'No save in storage';
}

/** Format an epoch-ms timestamp as "HH:MM" in the user's local time. Returns
 *  "—" for unknown values: 0 (pre-issue-#115 envelope or a tampered field
 *  that getSaveInfo coerced to 0), or any value that constructs an Invalid
 *  Date (e.g. a tampered envelope with `savedAtMs: 1e100` — getSaveInfo's
 *  isFinite guard accepts it but JS clamps `new Date(huge)` to Invalid).
 *  Pure function. */
export function formatSaveTime(epochMs: number): string {
  if (epochMs <= 0) return '—';
  const d = new Date(epochMs);
  const hours = d.getHours();
  if (Number.isNaN(hours)) return '—';
  const hh = String(hours).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Title text for the dialog. Centralized so UIScene and layout agree. */
export function dialogTitle(): string {
  return 'Save / Load';
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

function pointInRect(px: number, py: number, r: DialogItemRect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/** Returns the topmost ENABLED item under the pointer, or null. Disabled
 *  items don't fire callbacks, matching the pause-menu layout convention. */
export function itemAt(
  items: readonly SaveLoadDialogItem[],
  px: number,
  py: number,
): SaveLoadDialogItem | null {
  for (const it of items) {
    if (!it.enabled) continue;
    if (pointInRect(px, py, it.rect)) return it;
  }
  return null;
}
