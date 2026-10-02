// health-test-utils.ts — #400 test fixtures for the health model (not used by the sim).
import type { WorldState } from './types.js';
import { allocateEntityId } from './types.js';
import type { ColonyRecord } from './colony/colony-store.js';
import { ChamberType } from './enums.js';
import { CHAMBER_DIMENSIONS } from './colony/chamber.js';
import { UndergroundTileState, ugSet, Zone } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { addChamberForTest } from './food/food-test-utils.js';

/** Depth (tile row) of the staged Queen chamber's top edge. */
const STAGED_QUEEN_CHAMBER_Y = 9;

/**
 * Stage `colony`'s queen in her nest, as if she had founded it: open a shaft from
 * the colony's first entrance down to a completed Queen chamber (5×3) and put her on
 * its middle tile, underground in her own grid — her home ground (health.ts). With
 * a completed chamber the queen relocation pass keeps her drifting inside it, so a
 * tick() run leaves her at home. Returns her entity id.
 */
export function stageQueenInNest(world: WorldState, colony: ColonyRecord): number {
  const grid = world.undergroundGrids[colony.colonyId]!;
  const x = colony.entrances[0]!.surfaceTileX;
  const { width, height } = CHAMBER_DIMENSIONS[ChamberType.Queen];
  const left = x - (width >> 1);
  for (let y = 0; y < STAGED_QUEEN_CHAMBER_Y; y++) ugSet(grid, x, y, UndergroundTileState.Open);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      ugSet(grid, left + dx, STAGED_QUEEN_CHAMBER_Y + dy, UndergroundTileState.Open);
    }
  }
  addChamberForTest(world, colony, {
    chamberId: allocateEntityId(world),
    chamberType: ChamberType.Queen,
    posX: left << FP_SHIFT,
    posY: STAGED_QUEEN_CHAMBER_Y << FP_SHIFT,
    width,
    height,
  });
  const q = colony.queenEntityId;
  world.ants.zone[q] = Zone.Underground;
  world.ants.currentGridColonyId[q] = colony.colonyId;
  world.ants.posX[q] = (x << FP_SHIFT) + (FP_ONE >> 1);
  world.ants.posY[q] = ((STAGED_QUEEN_CHAMBER_Y + 1) << FP_SHIFT) + (FP_ONE >> 1);
  return q;
}
