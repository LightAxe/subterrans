// context-menu-layout.ts — Pure geometry + labels for the underground chamber
// context menu. Centralizes constants previously inlined in UIScene so the
// layout, hit-testing, and item labels all stay in sync and can be unit-tested.
//
// The menu presents up to three choices in a fixed order, one per ChamberType:
//   0: Queen
//   1: Nursery
//   2: Food Storage
//
// Items may be filtered out when a colony-level invariant rules them out
// (e.g. the colony already has or has pending a Queen chamber). Geometry is
// derived from the passed-in visible-items array so the menu shrinks to fit.
//
// UIScene:
//   - calls visibleContextMenuItems(colony, world) each frame to get the
//     currently-valid list
//   - calls drawContextMenuGeometry(gfx, anchorX, anchorY, items) per frame
//   - creates up to CONTEXT_MENU_ITEMS.length Phaser.Text labels once, shows
//     and positions them only for entries in `items`
//   - calls contextMenuItemAt(..., items) for pointer hit-testing
//   - calls isInsideContextMenu(..., items) to decide whether a click lands
//     on the menu

import { ChamberType } from '../sim/enums.js';
import { hasCompletedChamber } from '../sim/colony/colony-system.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import type { WorldState } from '../sim/types.js';
import type { GfxLike } from './draw-surface.js';
import { lerpColor } from './sprites.js';

export const CONTEXT_MENU = {
  WIDTH: 120,
  ITEM_HEIGHT: 24,
  /** Maximum number of rows the menu can display (= CONTEXT_MENU_ITEMS.length). */
  ITEM_COUNT: 3,
} as const;

/** Maximum possible menu height when every item is visible. */
export const CONTEXT_MENU_HEIGHT = CONTEXT_MENU.ITEM_HEIGHT * CONTEXT_MENU.ITEM_COUNT;

/** Actual rendered height for a specific visible-items list. */
export function contextMenuHeight(items: readonly ContextMenuRow[]): number {
  return CONTEXT_MENU.ITEM_HEIGHT * items.length;
}

/**
 * #352 — the anchor (top-left) of a menu `menuH` tall opened at (x, y), moved so
 * the whole menu lies within [0, maxRight) × [0, maxBottom): the raid menu opens
 * on an enemy entrance anywhere on screen, and its bottom rows past the canvas
 * (or under the bottom HUD strip) would be out of reach.
 *
 * Precondition: the menu fits (menuH <= maxBottom, CONTEXT_MENU.WIDTH <= maxRight).
 * The top-left bound is applied last, so a menu larger than the bounds is pinned
 * at 0 and still overflows at the bottom/right; the raid menu (120 px) is far
 * inside the fixed 800×592 layout's ~508 px strip above the bottom HUD.
 */
export function clampContextMenuAnchor(
  x: number,
  y: number,
  menuH: number,
  maxRight: number,
  maxBottom: number,
): { x: number; y: number } {
  const hiX = maxRight - CONTEXT_MENU.WIDTH;
  const hiY = maxBottom - menuH;
  return {
    x: Math.max(0, Math.min(x, hiX)),
    y: Math.max(0, Math.min(y, hiY)),
  };
}

/** #352 — what the menu geometry needs of a row: the chamber menu's items and
 *  the surface raid menu's orders (raid-order-view.ts) share it. */
export interface ContextMenuRow {
  readonly label: string;
  readonly stripeColor: number;
}

export interface ContextMenuItem extends ContextMenuRow {
  chamberType: ChamberType;
}

/**
 * Ordered menu items. Index corresponds to row offset from the top of the menu
 * when ALL items are visible. Order is part of the contract with
 * contextMenuItemAt — do not reorder without updating callers and tests.
 */
export const CONTEXT_MENU_ITEMS: readonly ContextMenuItem[] = [
  { chamberType: ChamberType.Queen, label: 'Queen', stripeColor: 0x4a1a4a },
  { chamberType: ChamberType.Nursery, label: 'Nursery', stripeColor: 0x1a4a1a },
  { chamberType: ChamberType.FoodStorage, label: 'Food Storage', stripeColor: 0x4a3a1a },
];

/**
 * Filter CONTEXT_MENU_ITEMS down to the choices that are currently legal for
 * the given colony + world. Queen is removed once the colony owns a completed
 * Queen chamber OR has queued a pending one — the player cannot place a
 * second. Nursery and FoodStorage stay unconditional: nursery uniqueness is
 * undecided elsewhere; multiple food-storage chambers are allowed.
 *
 * Pure function; safe to call every frame.
 */
export function visibleContextMenuItems(
  colony: ColonyRecord,
  world: WorldState,
): readonly ContextMenuItem[] {
  const queenBlocked =
    hasCompletedChamber(colony, ChamberType.Queen) ||
    hasPendingChamber(colony, world, ChamberType.Queen);
  if (!queenBlocked) return CONTEXT_MENU_ITEMS;
  return CONTEXT_MENU_ITEMS.filter((it) => it.chamberType !== ChamberType.Queen);
}

function hasPendingChamber(
  colony: ColonyRecord,
  world: WorldState,
  chamberType: ChamberType,
): boolean {
  for (const key in world.pendingChambers) {
    const p = world.pendingChambers[key]!;
    if (p.colonyId === colony.colonyId && p.chamberType === chamberType) return true;
  }
  return false;
}

/**
 * Return the ChamberType under a screen point, or null if outside any visible
 * item. anchorX / anchorY are the top-left of the menu (contextMenuState.screenX/Y).
 * `items` is the filtered list returned by visibleContextMenuItems.
 */
export function contextMenuItemAt(
  px: number,
  py: number,
  anchorX: number,
  anchorY: number,
  items: readonly ContextMenuItem[] = CONTEXT_MENU_ITEMS,
): ChamberType | null {
  const relX = px - anchorX;
  const relY = py - anchorY;
  if (relX < 0 || relX >= CONTEXT_MENU.WIDTH) return null;
  if (relY < 0 || relY >= contextMenuHeight(items)) return null;
  const idx = Math.floor(relY / CONTEXT_MENU.ITEM_HEIGHT);
  const item = items[idx];
  return item ? item.chamberType : null;
}

/**
 * True if the screen point is inside the (filtered) menu's outer rectangle.
 */
export function isInsideContextMenu(
  px: number,
  py: number,
  anchorX: number,
  anchorY: number,
  items: readonly ContextMenuRow[] = CONTEXT_MENU_ITEMS,
): boolean {
  return (
    px >= anchorX &&
    px < anchorX + CONTEXT_MENU.WIDTH &&
    py >= anchorY &&
    py < anchorY + contextMenuHeight(items)
  );
}

/**
 * Pixel position for item i's text label (top-left). Callers set Phaser Text
 * objects to these coordinates; padding is 6px right, vertically centered.
 * `i` is the row offset within the FILTERED item list.
 */
export function itemLabelPos(
  i: number,
  anchorX: number,
  anchorY: number,
): { x: number; y: number } {
  return {
    x: anchorX + 6,
    y: anchorY + i * CONTEXT_MENU.ITEM_HEIGHT + 5,
  };
}

/**
 * #378 — how far a hovered row's stripe is lit toward white (0–1): enough to read
 * as "this one" on every stripe colour, dark enough that the white label stays
 * legible on it.
 */
export const CONTEXT_MENU_HOVER_LIGHTEN = 0.3;

/** #378 — a row's stripe colour: its own, or lit toward white while hovered. */
export function contextMenuRowColor(row: ContextMenuRow, hovered: boolean): number {
  return hovered
    ? lerpColor(row.stripeColor, 0xffffff, CONTEXT_MENU_HOVER_LIGHTEN)
    : row.stripeColor;
}

/**
 * Draw the menu background + stripes for the given filtered item list. Pure
 * Graphics calls, compatible with MockGfx in tests. Does NOT draw text —
 * UIScene renders labels via Phaser.GameObjects.Text children since GfxLike
 * has no text API.
 */
export function drawContextMenuGeometry(
  gfx: GfxLike,
  anchorX: number,
  anchorY: number,
  items: readonly ContextMenuRow[] = CONTEXT_MENU_ITEMS,
  /** #352 — row index to outline (the raid menu's current order), or -1. */
  selected = -1,
  /** #378 — row index under the mouse, drawn lit (contextMenuRowColor), or -1. */
  hovered = -1,
): void {
  const h = contextMenuHeight(items);
  gfx.fillStyle(0x222222, 0.95);
  gfx.fillRect(anchorX, anchorY, CONTEXT_MENU.WIDTH, h);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    gfx.fillStyle(contextMenuRowColor(item, i === hovered), 1);
    gfx.fillRect(
      anchorX + 2,
      anchorY + i * CONTEXT_MENU.ITEM_HEIGHT + 2,
      CONTEXT_MENU.WIDTH - 4,
      CONTEXT_MENU.ITEM_HEIGHT - 4,
    );
  }
  if (selected >= 0 && selected < items.length) {
    // A 1-px light frame round the selected row, inside the row's 2-px gutter.
    const y = anchorY + selected * CONTEXT_MENU.ITEM_HEIGHT;
    gfx.fillStyle(0xdddddd, 1);
    gfx.fillRect(anchorX + 1, y + 1, CONTEXT_MENU.WIDTH - 2, 1);
    gfx.fillRect(anchorX + 1, y + CONTEXT_MENU.ITEM_HEIGHT - 2, CONTEXT_MENU.WIDTH - 2, 1);
    gfx.fillRect(anchorX + 1, y + 1, 1, CONTEXT_MENU.ITEM_HEIGHT - 2);
    gfx.fillRect(anchorX + CONTEXT_MENU.WIDTH - 2, y + 1, 1, CONTEXT_MENU.ITEM_HEIGHT - 2);
  }
}
