// raid-order-view.ts — #352 (V60): how the player sees and picks a raid order.
//
// A rally on an enemy entrance carries a raid type (Loot / Deny / Spoil / Blockade /
// Assault; the sim stores it on the colony). This module is the render side of it,
// pure and Phaser-free so it unit-tests without a canvas:
//   - the raid menu's rows (label + stripe colour), in RaidType order, and its
//     hit test (the geometry is the chamber menu's, context-menu-layout.ts);
//   - (#378) the menu's hovered row and the one-line description shown with it;
//   - the caption that names the order when the player gives it (#378: a newer
//     one replaces an older one still up or waiting, RAID_ORDER_CAPTION_SUPERSEDE_KEY);
//   - the rally-marker badge: a 5×5 pixel letter above the rally tile, sized in
//     screen pixels (#378).
// It reads WorldState; it never writes it (the choice goes out as a SetRallyPoint
// command through the input layer).

import { RaidType, isRaidType } from '../sim/enums.js';
import type { SetRallyPointCommand } from '../sim/commands.js';
import { enemyEntranceAt, rallyEnemyEntrance, worldHasRaidOrders } from '../sim/raid-order.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { CONTEXT_MENU, type ContextMenuRow } from './context-menu-layout.js';
import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX } from './sprites.js';

/** One raid order as the player sees it. */
export interface RaidOrderOption extends ContextMenuRow {
  readonly raidType: RaidType;
  /** Menu label and the name in captions. */
  readonly label: string;
  /** What the fighters will do — the second half of the order caption. */
  readonly blurb: string;
  /** Badge letter colour on the rally marker. */
  readonly badgeColor: number;
  /** 5×5 badge letter, row by row ('#' = lit). */
  readonly glyph: readonly string[];
}

/** Each order's look, keyed by type (the type system requires one per RaidType). */
const RAID_ORDER_BY_TYPE = {
  [RaidType.Loot]: {
    raidType: RaidType.Loot,
    label: 'Loot',
    blurb: 'Fighters steal food while your stores have room.',
    stripeColor: 0x4a3a1a,
    badgeColor: 0xe8c060,
    glyph: ['#....', '#....', '#....', '#....', '#####'],
  },
  [RaidType.Deny]: {
    raidType: RaidType.Deny,
    label: 'Deny',
    blurb: 'Fighters steal food; what won’t fit is left by your entrance.',
    stripeColor: 0x4a2a1a,
    badgeColor: 0xf09040,
    glyph: ['####.', '#...#', '#...#', '#...#', '####.'],
  },
  [RaidType.Spoil]: {
    raidType: RaidType.Spoil,
    label: 'Spoil',
    blurb: 'Fighters destroy the enemy’s stored food.',
    stripeColor: 0x3a3a1a,
    badgeColor: 0xa0c040,
    glyph: ['.####', '#....', '.###.', '....#', '####.'],
  },
  [RaidType.Blockade]: {
    raidType: RaidType.Blockade,
    label: 'Blockade',
    blurb: 'Fighters guard this entrance and attack all who come near.',
    stripeColor: 0x1a2a4a,
    badgeColor: 0x70a0f0,
    glyph: ['####.', '#...#', '####.', '#...#', '####.'],
  },
  [RaidType.Assault]: {
    raidType: RaidType.Assault,
    label: 'Assault',
    blurb: 'Fighters ignore food and go for the queen.',
    stripeColor: 0x4a1a1a,
    badgeColor: 0xf05050,
    glyph: ['.###.', '#...#', '#####', '#...#', '#...#'],
  },
} as const satisfies { readonly [T in RaidType]: RaidOrderOption & { readonly raidType: T } };

/** The five orders, in RaidType order — the raid menu's rows top to bottom. */
export const RAID_ORDER_OPTIONS: readonly RaidOrderOption[] = [
  RAID_ORDER_BY_TYPE[RaidType.Loot],
  RAID_ORDER_BY_TYPE[RaidType.Deny],
  RAID_ORDER_BY_TYPE[RaidType.Spoil],
  RAID_ORDER_BY_TYPE[RaidType.Blockade],
  RAID_ORDER_BY_TYPE[RaidType.Assault],
];

/** The option for `type` (Loot for anything unknown). */
export function raidOrderOption(type: RaidType): RaidOrderOption {
  return (
    (RAID_ORDER_BY_TYPE as Partial<Record<RaidType, RaidOrderOption>>)[type] ??
    RAID_ORDER_BY_TYPE[RaidType.Loot]
  );
}

/** The caption shown when the player gives an order: "Raiding: Deny. …". */
export function raidOrderCaption(type: RaidType): string {
  const o = raidOrderOption(type);
  return `Raiding: ${o.label}. ${o.blurb}`;
}

/**
 * #378 — the caption-queue supersede key of the order caption (caption-queue.ts,
 * CaptionRequest.supersedeKey): each order caption is the newest word on the one
 * order in force, so a newer one replaces an older one that is still on screen
 * or waiting, rather than queueing behind it ("Raiding: Blockade" lingering after
 * the player picked Assault).
 */
export const RAID_ORDER_CAPTION_SUPERSEDE_KEY = 'raidOrder';

export { worldHasRaidOrders };

/**
 * The raid order `colonyId`'s rally is giving right now, or null: a V60+ world
 * whose colony is rallied on another colony's entrance (open or closed).
 */
export function activeRaidOrder(world: WorldState, colonyId: ColonyId): RaidType | null {
  if (!worldHasRaidOrders(world)) return null;
  const colony = world.colonies[colonyId];
  if (colony === undefined || rallyEnemyEntrance(world, colony) === null) return null;
  return colony.raidType;
}

/**
 * The raid order `colonyId` has in force on the enemy entrance at surface tile
 * (tileX, tileY) — its rally is there — or null. The raid menu outlines it, and a
 * pick of the same order sends nothing (read on the projected world, so a queued
 * pick counts while paused).
 */
export function raidOrderOnTile(
  world: WorldState,
  colonyId: ColonyId,
  tileX: number,
  tileY: number,
): RaidType | null {
  const rally = world.colonies[colonyId]?.rallyPoint ?? null;
  if (rally === null || rally.tileX !== tileX || rally.tileY !== tileY) return null;
  return activeRaidOrder(world, colonyId);
}

/**
 * The raid order a rally command gives, or null when it gives none: a V60+ world
 * and the rally tile is another colony's entrance (open or closed). The type is
 * the command's `raidType`, Loot when absent; a malformed one (which the sim drops
 * with the command) gives none. Read before the tick applies the command (the
 * drained batch), so it takes the command's word, not the colony's.
 */
export function raidOrderOfRally(
  world: WorldState,
  colonyId: ColonyId,
  cmd: SetRallyPointCommand,
): RaidType | null {
  if (!worldHasRaidOrders(world)) return null;
  // Only an ABSENT type is Loot: a present null is malformed, as the sim treats it.
  const type = cmd.raidType === undefined ? RaidType.Loot : cmd.raidType;
  if (!isRaidType(type)) return null;
  return enemyEntranceAt(world, colonyId, cmd.tileX, cmd.tileY) === null ? null : type;
}

/**
 * The raid order under a screen point on the open raid menu, or null. `anchorX`
 * / `anchorY` are the menu's top-left (contextMenuState.screenX/Y).
 */
export function raidMenuItemAt(
  px: number,
  py: number,
  anchorX: number,
  anchorY: number,
): RaidType | null {
  const relX = px - anchorX;
  const relY = py - anchorY;
  if (relX < 0 || relX >= CONTEXT_MENU.WIDTH) return null;
  if (relY < 0) return null;
  const idx = Math.floor(relY / CONTEXT_MENU.ITEM_HEIGHT);
  const option = RAID_ORDER_OPTIONS[idx];
  return option ? option.raidType : null;
}

/**
 * #378 — the raid menu row the pointer hovers, or null. `pointing` is true only
 * for a mouse that has moved since the menu opened. The menu opens with its
 * top-left corner at the press, so a pointer that has not moved rests on its
 * first row (or, on a menu moved up clear of the HUD strip, on whatever row lies
 * there) without having chosen it: a touch pointer rests where the long-press
 * finger lifted, a mouse where the right-click was. Taking either for a hover
 * would light that row, and describe it, every time the menu opens.
 */
export function raidMenuHoveredOrder(
  px: number,
  py: number,
  anchorX: number,
  anchorY: number,
  pointing: boolean,
): RaidType | null {
  return pointing ? raidMenuItemAt(px, py, anchorX, anchorY) : null;
}

/**
 * #378 — the one-line explanation shown with the open raid menu: the hovered
 * order's, else (no hover: touch, a mouse not yet moved, or the pointer off the
 * menu) that of the order in force on this entrance, the outlined row; else none. "Deny: <blurb>"
 * — the blurb is the order caption's, so the menu and the "Raiding: …" caption
 * always say the same thing.
 */
export function raidMenuDescription(
  hovered: RaidType | null,
  inForce: RaidType | null,
): string | null {
  const type = hovered ?? inForce;
  if (type === null) return null;
  const o = raidOrderOption(type);
  return `${o.label}: ${o.blurb}`;
}

/** Gap (px) between the raid menu and its description line. */
const RAID_MENU_DESCRIPTION_GAP_PX = 2;

/**
 * #378 — the top-left of the raid menu's description line, `w` × `h` px: just
 * below the menu (`menuH` tall, top-left at anchorX/anchorY) and left-aligned
 * with it; just above the menu instead when below would run into the bottom HUD
 * strip (`maxBottom`, where the menu itself is kept above); moved left as far as
 * needed to end inside `maxRight`, never past 0. If it fits neither below nor
 * above (impossible in the 800×592 layout: the menu is 120 px tall, the strip
 * ~508 px down), it is pinned at the top and may overlap the menu.
 */
export function raidMenuDescriptionPos(
  anchorX: number,
  anchorY: number,
  menuH: number,
  w: number,
  h: number,
  maxRight: number,
  maxBottom: number,
): { x: number; y: number } {
  const x = Math.max(0, Math.min(anchorX, maxRight - w));
  const below = anchorY + menuH + RAID_MENU_DESCRIPTION_GAP_PX;
  const y =
    below + h <= maxBottom ? below : Math.max(0, anchorY - RAID_MENU_DESCRIPTION_GAP_PX - h);
  return { x, y };
}

// #378 — the rally badge is sized in SCREEN pixels, not world pixels. It is a label
// on the map, like the strategic-zoom ant dots (ANT_DOT_SCREEN_PX): it should read
// the same at every zoom. The #352 badge was 12 world px — 12 px on screen at 1x,
// hard to read; 6 px (a speck) at 0.5x; 24 px at 2x. It is now 19 px on screen at
// every zoom: half as big again at 1x, still readable zoomed out, and smaller than
// before at 2x, where the tile under it is 32 px: zooming in never makes it outgrow the tile.
// A zoom-compensated world size (bigger world px as you zoom out, clamped) would
// need a second tuning curve to land at the same place; a fixed screen size is the
// simpler rule and matches how the dot LOD already works.

/** Side of one lit cell of the badge letter, on screen (px). */
export const RAID_BADGE_CELL_SCREEN_PX = 3;
/** The dark border round the 5-cell letter, on screen (px). */
const RAID_BADGE_BORDER_SCREEN_PX = 2;
/** Badge side on screen (px), at every zoom: the 5 × 3 px letter in its 2-px border. */
export const RAID_BADGE_SCREEN_PX = 5 * RAID_BADGE_CELL_SCREEN_PX + 2 * RAID_BADGE_BORDER_SCREEN_PX;
/** Gap between the badge and the top of the rally tile, on screen (px). */
const RAID_BADGE_GAP_SCREEN_PX = 1;

/** World px per screen px at camera zoom `zoom` (a non-positive zoom reads as 1). */
function worldPxPerScreenPx(zoom: number): number {
  return zoom > 0 ? 1 / zoom : 1;
}

/** #378 — the badge's side in world px at camera zoom `zoom` (RAID_BADGE_SCREEN_PX on screen). */
export function raidBadgeWorldPx(zoom: number): number {
  return RAID_BADGE_SCREEN_PX * worldPxPerScreenPx(zoom);
}

/** #378 — how far (world px) a second badge is lifted to sit just above the first. */
export function raidBadgeStackLiftWorldPx(zoom: number): number {
  return (RAID_BADGE_SCREEN_PX + RAID_BADGE_GAP_SCREEN_PX) * worldPxPerScreenPx(zoom);
}

/**
 * Draw the raid-order badge for the rally tile whose top-left world pixel is
 * (wx, wy): a dark square centred just above the tile holding the order's
 * letter, RAID_BADGE_SCREEN_PX on screen at camera zoom `zoom`.
 */
export function drawRaidOrderBadge(
  gfx: GfxLike,
  wx: number,
  wy: number,
  type: RaidType,
  /** The camera zoom the badge is drawn under (it is sized in screen px). */
  zoom: number,
  /** 1 for the committed order; the ghost alpha for a queued one (paused). */
  alpha = 1,
): void {
  const o = raidOrderOption(type);
  const k = worldPxPerScreenPx(zoom);
  const side = RAID_BADGE_SCREEN_PX * k;
  const cell = RAID_BADGE_CELL_SCREEN_PX * k;
  const inset = RAID_BADGE_BORDER_SCREEN_PX * k;
  // Centred over the tile to a whole screen pixel: the odd 19-px badge over the
  // even 16-px tile at 1x would otherwise sit half a pixel off the grid, and its
  // letter cells would blur across pixel edges at exactly the zoom it is for.
  const bx = wx + Math.floor((TILE_SIZE_PX / k - RAID_BADGE_SCREEN_PX) / 2) * k;
  const by = wy - side - RAID_BADGE_GAP_SCREEN_PX * k;
  gfx.fillStyle(0x101010, 0.9 * alpha);
  gfx.fillRect(bx, by, side, side);
  gfx.fillStyle(o.badgeColor, alpha);
  for (let row = 0; row < o.glyph.length; row++) {
    const line = o.glyph[row]!;
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== '#') continue;
      gfx.fillRect(bx + inset + col * cell, by + inset + row * cell, cell, cell);
    }
  }
}
