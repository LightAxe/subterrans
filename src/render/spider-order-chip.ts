// spider-order-chip.ts — #400: the persistent HUD indicator for the player's spider
// order (Spider Priority), with the button that calls it off.
//
// From #400 (simVersion V71) a spider order stays on until the player clears it or
// the spider dies: no meal, hunt end or chase clears it any more. While it is on,
// the colony's surface fighters go at the spider wherever it is (tick step 10d), and
// the colony's "sent at the spider" exemptions hold (no automatic nest defence, no
// sentries, raid and rally orders overridden). The only cue used to be the white
// border round the spider, visible only with the spider on screen, so an order the
// player forgot about could run all match. This chip shows in the HUD's right column,
// above the alarm toggle, for as long as the order is in force, and a click on it
// clears the order (MarkSpiderPriority off — the same command a Command tap on the
// spider toggles).
//
// It reads the EFFECTIVE order (effectiveSpiderPriority: the live flag folded with
// any MarkSpiderPriority still queued), like the alarm toggle reads the projected
// colony: while paused the queue never drains, so a live read would leave the chip
// up after the player clicked it, and a second click would queue a second clear.
//
// Render-only: it enqueues a command a player could already issue and reads world
// state; it changes no sim rule.
//
// Whether the chip is drawn this frame lives in spider-order-chip-state.ts (UIScene
// sets it; isPointerOverHUD and tooltipTargetAt read it).

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import type { MarkSpiderPriorityCommand } from '../sim/commands.js';
import type { HudRect } from './hud-layout.js';
import {
  SPIDER_PRIORITY_COMMITTED_COLOR,
  SPIDER_PRIORITY_QUEUED_COLOR,
  type GfxLike,
} from './draw-surface.js';
import { effectiveSpiderPriority } from '../input/surface-input.js';

/** The chip's label: what a click does. Fits hud.SPIDER_ORDER at the toggle font
 *  (tests/hud-button-geometry.spec.ts measures it in the real renderer). */
export const SPIDER_ORDER_LABEL = 'Call off spider';

/** Background of the chip (the right-column toggles' grey). */
export const SPIDER_ORDER_FILL = 0x333333;

/** Width of the chip's border, in px: the spider mark's border width. */
export const SPIDER_ORDER_BORDER_PX = 2;

/**
 * The chip is up while the spider lives and `colonyId`'s spider order is in force,
 * counting a MarkSpiderPriority still in the queue (effectiveSpiderPriority).
 */
export function spiderOrderChipVisible(world: WorldState, colonyId: ColonyId): boolean {
  return world.spider !== null && effectiveSpiderPriority(world, colonyId);
}

/**
 * The command a click on the chip enqueues: `colonyId`'s spider order off. Null when
 * the chip is not up (nothing to call off), so a click on its empty band does
 * nothing.
 */
export function spiderOrderClearCommand(
  world: WorldState,
  colonyId: ColonyId,
): MarkSpiderPriorityCommand | null {
  if (!spiderOrderChipVisible(world, colonyId)) return null;
  return {
    type: 'MarkSpiderPriority',
    colonyId,
    isPriority: false,
    issuedAtTick: world.tick,
  };
}

/**
 * Paint the chip's background into `rect`: the toggles' grey, framed by the spider
 * mark's border — the border draw-surface draws round a marked spider: white once the
 * order is applied, proto-blue while it is only queued (`queued`: paused, not yet
 * applied) — so the chip reads as that order. The label is a separate Text pinned to
 * the rect.
 */
export function drawSpiderOrderChip(gfx: GfxLike, rect: HudRect, queued = false): void {
  const b = SPIDER_ORDER_BORDER_PX;
  gfx.fillStyle(SPIDER_ORDER_FILL, 1);
  gfx.fillRect(rect.x, rect.y, rect.w, rect.h);
  gfx.fillStyle(queued ? SPIDER_PRIORITY_QUEUED_COLOR : SPIDER_PRIORITY_COMMITTED_COLOR, 1);
  gfx.fillRect(rect.x, rect.y, rect.w, b);
  gfx.fillRect(rect.x, rect.y + rect.h - b, rect.w, b);
  gfx.fillRect(rect.x, rect.y + b, b, rect.h - 2 * b);
  gfx.fillRect(rect.x + rect.w - b, rect.y + b, b, rect.h - 2 * b);
}
