// blockade-caption.ts — #366: once per match, when an enemy Blockade ring forms on the
// player's entrance, say what it takes to break it. (Rationale: CONTEXT.md §Army
// warning; the launch warning already says it as the wave sets out, this is the same
// lesson when the ring actually stands.)
//
// TRIGGER. Some other colony gives a Blockade order on one of the viewer's OPEN
// entrances (blockadedEntrance: its rally sits on that entrance with raid type
// Blockade), AND at least BLOCKADE_CAPTION_MIN_FIGHTERS of that colony's living
// Fighting ants are on the surface within BLOCKADE_RADIUS_TILES (Manhattan, as the
// sim's blockade scan measures it) of that entrance tile: the ring is forming (the
// fighters pass through that radius a few ticks before they take their posts at
// BLOCKADE_POST_RADIUS_TILES).
//
// SUPPRESSED while the viewer's rally is already on a surface tile within
// BLOCKADE_RADIUS_TILES of that entrance that is not the entrance tile itself (the
// player is already sallying). It stays armed: if the rally later moves away, or onto
// the entrance, while the ring still holds, the caption shows.
//
// ONCE PER MATCH. After it has shown it never shows again this session (a second
// Blockade included). A new game, boot or load starts with a fresh state.
//
// PRESENTATION. A RECURRING caption (recurring-captions.ts offerRecurringCaption): it
// enters the queue only while the queue is fully idle, and is offered every frame
// while the condition holds, so a busy queue only delays it. It is advice: owed, it
// makes no long caption give way. Polled per frame (a ring persists for many ticks).
//
// Render-side session state only: reads world state, writes nothing, saves nothing.
// Pure and Phaser-free; GameScene owns the state.

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';
import { BLOCKADE_RADIUS_TILES } from '../sim/constants.js';
import { blockadedEntrance } from '../sim/raid-order.js';
import { offerRecurringCaption, type RecurringCaptionSink } from './recurring-captions.js';
import { ARMY_CAPTION_HOLD_MS } from './army-warning.js';

/** The caption: why the tunnel defenders do not meet the ring, and what to do. */
export const BLOCKADE_CAPTION_TEXT =
  "Your entrance is blockaded. Fighters waiting in the tunnel can't reach the ring: rally just outside the door to break it.";

/** Full-opacity hold (ms): the army warning's, as it is as long and must be read. */
export const BLOCKADE_CAPTION_HOLD_MS = ARMY_CAPTION_HOLD_MS;

/** The ring has formed when this many of the blockaders' fighters stand within
 *  BLOCKADE_RADIUS_TILES of the entrance (a couple of stragglers are not a ring). */
export const BLOCKADE_CAPTION_MIN_FIGHTERS = 3;

export interface BlockadeCaptionState {
  /** The caption has been shown this session: it never shows again. */
  shown: boolean;
}

export function createBlockadeCaptionState(): BlockadeCaptionState {
  return { shown: false };
}

/** Re-arm: a new game, boot or load. */
export function resetBlockadeCaptionState(state: BlockadeCaptionState): void {
  state.shown = false;
}

/** Surface tile (x, y) is within BLOCKADE_RADIUS_TILES (Manhattan) of `ent`. */
function nearEntrance(ent: NestEntrance, x: number, y: number): boolean {
  const dx = x - ent.surfaceTileX;
  const dy = y - ent.surfaceTileY;
  return (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy) <= BLOCKADE_RADIUS_TILES;
}

/** How many living Fighting ants of `colonyId` stand on the surface within the
 *  blockade radius of `ent`. */
function ringFighters(world: WorldState, colonyId: ColonyId, ent: NestEntrance): number {
  const ants = world.ants;
  let n = 0;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (
      ants.alive[id] !== 1 ||
      ants.colonyId[id] !== colonyId ||
      ants.task[id] !== AntTask.Fighting ||
      ants.zone[id] !== Zone.Surface
    ) {
      continue;
    }
    if (nearEntrance(ent, ants.posX[id]! >> FP_SHIFT, ants.posY[id]! >> FP_SHIFT)) n++;
  }
  return n;
}

/**
 * Is an enemy Blockade ring standing on one of `viewerColonyId`'s open entrances in
 * `world` (see the file header), the viewer not yet sallying out to it? Reads only.
 */
export function blockadeCaptionCondition(world: WorldState, viewerColonyId: ColonyId): boolean {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined) return false;
  const rp = viewer.rallyPoint;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const other = world.colonies[key as unknown as keyof typeof world.colonies]!;
    if (other.colonyId === viewerColonyId) continue;
    const ent = blockadedEntrance(world, other);
    if (ent === null || !ent.isOpen || !viewer.entrances.includes(ent)) continue;
    if (ringFighters(world, other.colonyId, ent) < BLOCKADE_CAPTION_MIN_FIGHTERS) continue;
    const sallying =
      rp !== null &&
      nearEntrance(ent, rp.tileX, rp.tileY) &&
      (rp.tileX !== ent.surfaceTileX || rp.tileY !== ent.surfaceTileY);
    if (!sallying) return true;
  }
  return false;
}

/**
 * GameScene's per-frame step: while the caption has not shown and the condition holds
 * (blockadeCaptionCondition), offers it to the queue (offerRecurringCaption: it enters
 * only while the queue is idle; a busy queue leaves it owed for the next frame).
 * Returns true iff it was shown this call. GameScene passes its projected world (queued
 * commands folded in), so a rally the player has just picked already counts.
 */
export function offerBlockadeCaption(
  state: BlockadeCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
  ui: RecurringCaptionSink,
  screenX: number,
  screenY: number,
): boolean {
  if (state.shown || !blockadeCaptionCondition(world, viewerColonyId)) return false;
  if (
    !offerRecurringCaption(ui, BLOCKADE_CAPTION_TEXT, screenX, screenY, BLOCKADE_CAPTION_HOLD_MS)
  ) {
    return false;
  }
  state.shown = true;
  return true;
}
