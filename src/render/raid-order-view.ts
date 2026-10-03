// raid-order-view.ts — #352 (V60): how the player sees and picks a raid order.
//
// A rally on an enemy entrance carries a raid type (Loot / Deny / Spoil / Blockade /
// Assault; the sim stores it on the colony). This module is the render side of it,
// pure and Phaser-free so it unit-tests without a canvas:
//   - the raid menu's rows (label + stripe colour), in RaidType order, and its
//     hit test (the geometry is the chamber menu's, context-menu-layout.ts);
//   - (#378) the menu's hovered row and the description shown with it (#399: wrapped,
//     and placed clear of the HUD);
//   - the caption that names the order when the player gives it (#378: a newer
//     one replaces an older one still up or waiting, RAID_ORDER_CAPTION_SUPERSEDE_KEY);
//   - the rally-marker badge: a 5×5 pixel letter above the rally tile, sized in
//     screen pixels (#378).
// It reads WorldState; it never writes it (the choice goes out as a SetRallyPoint
// command through the input layer).

import { RaidType, isRaidType } from '../sim/enums.js';
import type { SetRallyPointCommand } from '../sim/commands.js';
import { enemyEntranceAt, rallyEnemyEntrance } from '../sim/raid-order.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { CONTEXT_MENU, type ContextMenuRow } from './context-menu-layout.js';
import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX } from './sprites.js';
import { minimapFrameRect, type HudLayout, type HudRect } from './hud-layout.js';
import type { LayoutContext } from './layout.js';

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

/**
 * The raid order `colonyId`'s rally is giving right now, or null when its rally is
 * not on another colony's entrance (open or closed).
 */
export function activeRaidOrder(world: WorldState, colonyId: ColonyId): RaidType | null {
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
 * The raid order a rally command gives, or null when it gives none: the rally tile
 * must be another colony's entrance (open or closed). The type is
 * the command's `raidType`, Loot when absent; a malformed one (which the sim drops
 * with the command) gives none. Read before the tick applies the command (the
 * drained batch), so it takes the command's word, not the colony's.
 */
export function raidOrderOfRally(
  world: WorldState,
  colonyId: ColonyId,
  cmd: SetRallyPointCommand,
): RaidType | null {
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
 * #378 — the explanation shown with the open raid menu (#399: wrapped to two
 * short lines by UIScene, RAID_MENU_DESCRIPTION_WRAP_W): the hovered
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

/** Gap (px) kept between the raid menu's description box and the menu, and
 *  between the box and every HUD control it stays clear of. */
export const RAID_MENU_DESCRIPTION_GAP_PX = 2;

/** #399 — the description box's padding round its text (px), as UIScene styles it. */
export const RAID_MENU_DESCRIPTION_PAD_X = 6;
export const RAID_MENU_DESCRIPTION_PAD_Y = 3;

/**
 * #399 — the widest a description line may run (px of text) before it wraps: 40
 * characters of 12 px monospace, so each order's description is two short lines
 * in a box of at most 300 px, which fits beside the menu and clear of the HUD
 * wherever the menu opens. On one line the longest ran ~500 px: below a menu
 * near the right-hand HUD column it reached the canvas's edge and the minimap.
 */
export const RAID_MENU_DESCRIPTION_WRAP_W = 288;

/** #399 — the description's word-wrap width (px) in `layout`: RAID_MENU_DESCRIPTION_WRAP_W,
 *  or less on a canvas too narrow for that box. */
export function raidMenuDescriptionWrapWidth(layout: LayoutContext): number {
  return Math.max(
    0,
    Math.min(RAID_MENU_DESCRIPTION_WRAP_W, layout.w - 2 * RAID_MENU_DESCRIPTION_PAD_X),
  );
}

/**
 * #399 — the HUD controls the raid menu's description stays clear of (the bottom
 * HUD strip is its `maxBottom` instead): the minimap with its frame, the
 * right-hand column's toggles, the tool palette, the stats panel and the save
 * icon. The raid menu is surface-only, so the underground colony toggle (hidden
 * there) is not one of them. Pure; build once per layout.
 */
export function raidMenuDescriptionObstacles(hud: HudLayout): readonly HudRect[] {
  return [
    minimapFrameRect(hud),
    hud.VIEW_TOGGLE,
    hud.ALARM_TOGGLE,
    hud.TOOLS,
    hud.STATS,
    hud.SAVE_ICON,
  ];
}

/** True if the w×h box at (x, y) comes within RAID_MENU_DESCRIPTION_GAP_PX of `r`. */
function boxNear(x: number, y: number, w: number, h: number, r: HudRect): boolean {
  const g = RAID_MENU_DESCRIPTION_GAP_PX;
  return x < r.x + r.w + g && r.x < x + w + g && y < r.y + r.h + g && r.y < y + h + g;
}

/** The first rect of `avoid` that the w×h box at (x, y) comes too near (boxNear),
 *  or null when it is clear of them all. */
function firstHit(
  x: number,
  y: number,
  w: number,
  h: number,
  avoid: readonly HudRect[],
): HudRect | null {
  for (const r of avoid) if (boxNear(x, y, w, h, r)) return r;
  return null;
}

/**
 * Slide the w×h box along one axis — x for a box in a row above/below the menu
 * (`y` fixed), y for one in a column beside it (`x` fixed) — from its start
 * position until it is clear of `avoid`: first toward 0, each step putting it just
 * before the rect it hit, then from the start the other way, each step just past
 * it. Returns the clear position, or null if it runs out of room ([0, `max`]) both
 * ways. A step always passes the rect it hit, so one step per rect is enough. (The
 * row or column already lies RAID_MENU_DESCRIPTION_GAP_PX off the menu, so no
 * slide along it can reach the menu.)
 */
function slideClear(
  axis: 'x' | 'y',
  x: number,
  y: number,
  w: number,
  h: number,
  max: number,
  avoid: readonly HudRect[],
): number | null {
  const g = RAID_MENU_DESCRIPTION_GAP_PX;
  const size = axis === 'x' ? w : h;
  const start = axis === 'x' ? x : y;
  for (let dir = -1; dir <= 1; dir += 2) {
    let v = start;
    for (let i = 0; i <= avoid.length && v >= 0 && v + size <= max; i++) {
      const hit = axis === 'x' ? firstHit(v, y, w, h, avoid) : firstHit(x, v, w, h, avoid);
      if (hit === null) return v;
      const hitStart = axis === 'x' ? hit.x : hit.y;
      const hitSize = axis === 'x' ? hit.w : hit.h;
      v = dir < 0 ? hitStart - g - size : hitStart + hitSize + g;
    }
  }
  return null;
}

/**
 * #378 / #399 — the top-left of the raid menu's description box, `w` × `h` px.
 * The menu is CONTEXT_MENU.WIDTH × `menuH` with its top-left at (anchorX,
 * anchorY). The box lies wholly inside [0, maxRight] × [0, maxBottom] — the
 * canvas above the bottom HUD strip — and at least RAID_MENU_DESCRIPTION_GAP_PX
 * clear of the menu (every place tried is a row above/below it or a column
 * beside it) and of every rect in `avoid` (raidMenuDescriptionObstacles: the
 * minimap, the right-hand toggles, …). In order of preference:
 *   1. just below the menu, left-aligned with it (moved left to end inside the
 *      canvas), then slid left — else right — past any control in the way;
 *   2. just above the menu, the same way;
 *   3. just left of the menu, then just right of it, top-aligned with it (moved
 *      up to end above the strip), slid up — else down — past any control.
 * If none is clear (never, in the 800×592 layout, for a wrapped description:
 * raid-order-view.test.ts sweeps every menu position), the #378 rule: below the
 * menu, else above it, moved left to end inside the canvas, pinned at 0 — it may
 * then overlap a control, or the menu.
 */
export function raidMenuDescriptionPos(
  anchorX: number,
  anchorY: number,
  menuH: number,
  w: number,
  h: number,
  maxRight: number,
  maxBottom: number,
  avoid: readonly HudRect[] = [],
): { x: number; y: number } {
  const g = RAID_MENU_DESCRIPTION_GAP_PX;
  const x0 = Math.max(0, Math.min(anchorX, maxRight - w));
  const below = anchorY + menuH + g;
  const above = anchorY - g - h;
  for (let i = 0; i < 2; i++) {
    const y = i === 0 ? below : above;
    if (y < 0 || y + h > maxBottom) continue;
    const x = slideClear('x', x0, y, w, h, maxRight, avoid);
    if (x !== null) return { x, y };
  }
  const y0 = Math.max(0, Math.min(anchorY, maxBottom - h));
  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? anchorX - g - w : anchorX + CONTEXT_MENU.WIDTH + g;
    if (x < 0 || x + w > maxRight) continue;
    const y = slideClear('y', x, y0, w, h, maxBottom, avoid);
    if (y !== null) return { x, y };
  }
  return { x: x0, y: below + h <= maxBottom ? below : Math.max(0, above) };
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
 * #378 — the world-px box the badge for the rally tile at (wx, wy) covers at
 * camera zoom `zoom`: RAID_BADGE_SCREEN_PX on screen, centred over the tile to a
 * whole screen pixel (the odd 19-px badge over the even 16-px tile at 1x would
 * otherwise sit half a pixel off the grid, its letter cells blurring across pixel
 * edges at exactly the zoom it is for), 1 screen px above it. Zoomed out it reaches
 * well past the tile (40 world px above it at 0.5x), so it is culled by this box,
 * not by the tile's.
 */
export function raidBadgeWorldRect(
  wx: number,
  wy: number,
  zoom: number,
): { x: number; y: number; w: number; h: number } {
  const k = worldPxPerScreenPx(zoom);
  const side = RAID_BADGE_SCREEN_PX * k;
  return {
    x: wx + Math.floor((TILE_SIZE_PX / k - RAID_BADGE_SCREEN_PX) / 2) * k,
    y: wy - side - RAID_BADGE_GAP_SCREEN_PX * k,
    w: side,
    h: side,
  };
}

/**
 * Draw the raid-order badge for the rally tile whose top-left world pixel is
 * (wx, wy): a dark square centred just above the tile holding the order's
 * letter, RAID_BADGE_SCREEN_PX on screen at camera zoom `zoom` (raidBadgeWorldRect).
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
  const cell = RAID_BADGE_CELL_SCREEN_PX * k;
  const inset = RAID_BADGE_BORDER_SCREEN_PX * k;
  const { x: bx, y: by, w: side } = raidBadgeWorldRect(wx, wy, zoom);
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
