// src/render/command-ghosts.test.ts — Stage 3a (issue #18).

import { describe, it, expect } from 'vitest';
import { computeGhostDelta } from './command-ghosts.js';
import { CommandProjection } from './command-projection.js';
import { createScenario } from '../sim/scenario.js';
import { copyWorldState } from '../sim/types.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import { ChamberType } from '../sim/enums.js';
import { UndergroundTileState, ugSet } from '../sim/terrain.js';
import { applyCommands } from '../sim/tick.js';
import type { SimCommand } from '../sim/commands.js';
import type { WorldState } from '../sim/types.js';
import type { NestEntrance } from '../sim/colony/entrance.js';

function world(): WorldState {
  return createScenario(0x3a90d, 'Normal');
}
const mark = (tileX: number, tileY: number, colonyId = PLAYER_COLONY_ID): SimCommand => ({
  type: 'MarkDigTile',
  colonyId,
  tileX,
  tileY,
  issuedAtTick: 0,
});
const cancel = (tileX: number, tileY: number): SimCommand => ({
  type: 'CancelDigMark',
  colonyId: PLAYER_COLONY_ID,
  tileX,
  tileY,
  issuedAtTick: 0,
});
function project(w: WorldState): WorldState {
  return new CommandProjection().get(w);
}

describe('computeGhostDelta', () => {
  it('empty queue → empty delta (projection aliases world)', () => {
    const w = world();
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingMarks).toHaveLength(0);
    expect(d.ghostChambers).toHaveLength(0);
    expect(d.pendingRally).toBeNull();
    expect(d.pendingSpiderPriority).toBeNull();
  });

  it('queued mark → pendingMarks', () => {
    const w = world();
    w.commandQueue.push(mark(20, 20));
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingMarks).toEqual([{ tileX: 20, tileY: 20 }]);
    expect(d.pendingRemovals).toHaveLength(0);
  });

  it('mark then cancel the same tile → net no-op, no ghost', () => {
    const w = world();
    w.commandQueue.push(mark(21, 21), cancel(21, 21));
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingMarks).toHaveLength(0);
    expect(d.pendingRemovals).toHaveLength(0);
  });

  it('cancel of a committed Marked tile → pendingRemovals', () => {
    const w = world();
    ugSet(w.undergroundGrids[PLAYER_COLONY_ID]!, 22, 22, UndergroundTileState.Marked);
    w.commandQueue.push(cancel(22, 22));
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingRemovals).toEqual([{ tileX: 22, tileY: 22 }]);
    expect(d.pendingMarks).toHaveLength(0);
  });

  it('queued rally → pendingRally', () => {
    const w = world();
    w.commandQueue.push({
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: 70,
      tileY: 60,
      issuedAtTick: 0,
    });
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingRally).toEqual({ tileX: 70, tileY: 60 });
  });

  it('queued player spider-priority → pendingSpiderPriority=true (attributed to player)', () => {
    const w = world();
    w.commandQueue.push({
      type: 'MarkSpiderPriority',
      colonyId: PLAYER_COLONY_ID,
      isPriority: true,
      issuedAtTick: 0,
    });
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingSpiderPriority).toBe(true);
  });

  it('enemy-colony commands produce no player ghosts', () => {
    const w = world();
    w.commandQueue.push(mark(30, 30, ENEMY_COLONY_ID));
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingMarks).toHaveLength(0);
  });

  it('queued player MarkFoodPile → pendingFoodMark resolves to that pile tile', () => {
    const w = world();
    // Unique high id + a tile no seeded pile occupies (scenario seeds ids 0..14).
    w.foodPiles.push({
      foodPileId: 9001,
      tileX: 40,
      tileY: 50,
      pickupsRemaining: 5,
      pickupsInitial: 5,
    });
    w.commandQueue.push({
      type: 'MarkFoodPile',
      colonyId: PLAYER_COLONY_ID,
      tileX: 40,
      tileY: 50,
      issuedAtTick: 0,
    });
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingFoodMark).toEqual({ tileX: 40, tileY: 50 });
    expect(d.foodMarkCleared).toBeNull(); // a fresh mark clears no committed pile
  });

  it('enemy MarkFoodPile → no player food-mark ghost', () => {
    const w = world();
    w.foodPiles.push({
      foodPileId: 9002,
      tileX: 41,
      tileY: 51,
      pickupsRemaining: 5,
      pickupsInitial: 5,
    });
    w.commandQueue.push({
      type: 'MarkFoodPile',
      colonyId: ENEMY_COLONY_ID,
      tileX: 41,
      tileY: 51,
      issuedAtTick: 0,
    });
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingFoodMark).toBeNull();
  });

  it('queued MarkFoodPile toggling the committed pile off → foodMarkCleared, no pendingFoodMark', () => {
    const w = world();
    w.foodPiles.push({
      foodPileId: 9003,
      tileX: 42,
      tileY: 52,
      pickupsRemaining: 5,
      pickupsInitial: 5,
    });
    // Commit a priority mark on 9003 through the real handler (no direct sim-field write).
    applyCommands(w, [
      { type: 'MarkFoodPile', colonyId: PLAYER_COLONY_ID, tileX: 42, tileY: 52, issuedAtTick: 0 },
    ]);
    // Re-click the same pile → the projection toggles the priority back off.
    w.commandQueue.push({
      type: 'MarkFoodPile',
      colonyId: PLAYER_COLONY_ID,
      tileX: 42,
      tileY: 52,
      issuedAtTick: 0,
    });
    const d = computeGhostDelta(w, project(w));
    expect(d.foodMarkCleared).toEqual({ tileX: 42, tileY: 52 });
    expect(d.pendingFoodMark).toBeNull();
  });

  it('queued MarkFoodPile redirecting to another pile → pendingFoodMark (new) + foodMarkCleared (old)', () => {
    const w = world();
    w.foodPiles.push({
      foodPileId: 9004,
      tileX: 43,
      tileY: 53,
      pickupsRemaining: 5,
      pickupsInitial: 5,
    });
    w.foodPiles.push({
      foodPileId: 9005,
      tileX: 44,
      tileY: 54,
      pickupsRemaining: 5,
      pickupsInitial: 5,
    });
    // Commit the priority on 9004, then queue a redirect to 9005.
    applyCommands(w, [
      { type: 'MarkFoodPile', colonyId: PLAYER_COLONY_ID, tileX: 43, tileY: 53, issuedAtTick: 0 },
    ]);
    w.commandQueue.push({
      type: 'MarkFoodPile',
      colonyId: PLAYER_COLONY_ID,
      tileX: 44,
      tileY: 54,
      issuedAtTick: 0,
    });
    const d = computeGhostDelta(w, project(w));
    expect(d.pendingFoodMark).toEqual({ tileX: 44, tileY: 54 });
    expect(d.foodMarkCleared).toEqual({ tileX: 43, tileY: 53 });
  });

  it('ghost chamber = a player pending chamber present in projection, absent in world', () => {
    const w = world();
    const proj = world();
    copyWorldState(w, proj); // proj === w in content, distinct object
    proj.pendingChambers['1:30:30'] = {
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.Nursery,
      anchorTileX: 30,
      anchorTileY: 30,
      width: 3,
      height: 3,
    };
    const d = computeGhostDelta(w, proj);
    expect(d.ghostChambers).toHaveLength(1);
    expect(d.ghostChambers[0]!.anchorTileX).toBe(30);
    expect(d.removedChambers).toHaveLength(0);
  });

  it('pending entrance = a player entrance in projection, absent in world (plan §B12)', () => {
    const w = world();
    const proj = world();
    copyWorldState(w, proj);
    proj.colonies[PLAYER_COLONY_ID]!.entrances.push({
      entranceId: 7,
      surfaceTileX: 50,
      surfaceTileY: 60,
      isOpen: false,
    } as unknown as NestEntrance);
    const d = computeGhostDelta(w, proj);
    expect(d.pendingEntrances).toEqual([{ tileX: 50, tileY: 60 }]);
  });
});
