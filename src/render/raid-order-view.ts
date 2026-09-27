// raid-order-view.ts — #352 (V60): how the player sees and picks a raid order.
//
// A rally on an enemy entrance carries a raid type (Loot / Deny / Spoil / Blockade /
// Assault; the sim stores it on the colony). This module is the render side of it,
// pure and Phaser-free so it unit-tests without a canvas:
//   - the raid menu's rows (label + stripe colour), in RaidType order, and its
//     hit test (the geometry is the chamber menu's, context-menu-layout.ts);
//   - the caption that names the order when the player gives it;
//   - the rally-marker badge: a 5×5 pixel letter above the rally tile.
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
  const type = cmd.raidType ?? RaidType.Loot;
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

/** Badge side (px): a 1-px dark border round the 5 × 2 px letter. */
export const RAID_BADGE_SIZE_PX = 12;
/** Side of one lit cell of the badge letter (px). */
const RAID_BADGE_CELL_PX = 2;

/**
 * Draw the raid-order badge for the rally tile whose top-left world pixel is
 * (wx, wy): a dark square just above the tile holding the order's letter.
 */
export function drawRaidOrderBadge(
  gfx: GfxLike,
  wx: number,
  wy: number,
  type: RaidType,
  /** 1 for the committed order; the ghost alpha for a queued one (paused). */
  alpha = 1,
): void {
  const o = raidOrderOption(type);
  const bx = wx + ((TILE_SIZE_PX - RAID_BADGE_SIZE_PX) >> 1);
  const by = wy - RAID_BADGE_SIZE_PX - 1;
  gfx.fillStyle(0x101010, 0.9 * alpha);
  gfx.fillRect(bx, by, RAID_BADGE_SIZE_PX, RAID_BADGE_SIZE_PX);
  gfx.fillStyle(o.badgeColor, alpha);
  for (let row = 0; row < o.glyph.length; row++) {
    const line = o.glyph[row]!;
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== '#') continue;
      gfx.fillRect(
        bx + 1 + col * RAID_BADGE_CELL_PX,
        by + 1 + row * RAID_BADGE_CELL_PX,
        RAID_BADGE_CELL_PX,
        RAID_BADGE_CELL_PX,
      );
    }
  }
}
