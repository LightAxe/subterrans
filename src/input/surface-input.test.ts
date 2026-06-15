// surface-input.test.ts — Vitest unit tests for the Stage 1 controls-rework
// surface tap handlers (issue #18).
//
// The arbiter owns the left button and calls these PURE handlers on a
// tap-without-drag. Tests cover:
//   - pure helpers: findFoodPileAt, isEmptySurfaceTile, isForeignColonyEntrance,
//     isValidEntranceTarget, isSpiderHit
//   - handleSurfaceCommandTap priority: spider → food → clear-rally →
//     foreign-entrance → empty (Codex R1-4)
//   - handleSurfaceDigTap: DesignateEntrance on a valid target; no-op otherwise
//   - paused-cap: enqueueCommand drops past MAX_COMMANDS_PER_TICK while paused

import { describe, it, expect } from 'vitest';
import {
  findFoodPileAt,
  isEmptySurfaceTile,
  isForeignColonyEntrance,
  isValidEntranceTarget,
  isSpiderHit,
  effectiveSpiderPriority,
  effectiveRallyState,
  handleSurfaceCommandTap,
  handleSurfaceDigTap,
} from './surface-input.js';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { CommandFeedforward } from '../render/command-feedforward.js';
import { createScenario } from '../sim/scenario.js';
import { makeCameraView, worldToScreen } from '../render/camera-adapter.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import { FP_ONE } from '../sim/fixed.js';
import { SPIDER_SPRITE_WIDTH } from '../render/ant-sprite-layer.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT, PLAYER_COLONY_ID } from '../sim/constants.js';
import { MAX_COMMANDS_PER_TICK, type SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ViewState whose cameras are world-pixel CameraViews centered on tile
 * (camTileX, camTileY). World-space camera model (issue #18 Stage 2): 1 tile =
 * TILE_SIZE_PX world px, so centering on a tile is `tile * TILE_SIZE_PX`.
 */
function makeViewState(
  view: 'surface' | 'underground' = 'surface',
  camTileX = 64,
  camTileY = 64,
): ViewState {
  return {
    activeView: view,
    activeTool: view === 'surface' ? 'command' : 'dig',
    surfaceCamera: makeCameraView(camTileX * TILE_SIZE_PX, camTileY * TILE_SIZE_PX),
    undergroundCamera: makeCameraView(camTileX * TILE_SIZE_PX, camTileY * TILE_SIZE_PX),
    undergroundVisited: false,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    showPheromoneOverlay: true,
  };
}

/**
 * Screen-pixel coordinate that the world-space camera projects a tile's CENTER
 * to. isSpiderHit projects clicks via screenToWorld and tests against the
 * spider's world-pixel box, so a click here lands exactly on the spider's
 * rendered center. Inverse of the adapter's screenToWorld (uses worldToScreen).
 */
function tileCenterToScreen(tileX: number, tileY: number, vs: ViewState) {
  const worldX = tileX * TILE_SIZE_PX;
  const worldY = tileY * TILE_SIZE_PX;
  const { screenX, screenY } = worldToScreen(worldX, worldY, vs.surfaceCamera);
  return { x: screenX, y: screenY };
}

function makeWorld(
  overrides: {
    tick?: number;
    foodPiles?: WorldState['foodPiles'];
    colonies?: WorldState['colonies'];
    spider?: WorldState['spider'];
    spiderPriorityColonyId?: WorldState['spiderPriorityColonyId'];
    commandQueue?: SimCommand[];
  } = {},
): WorldState {
  const sw = SURFACE_GRID_WIDTH;
  const sh = SURFACE_GRID_HEIGHT;
  return {
    tick: overrides.tick ?? 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: overrides.commandQueue ?? ([] as SimCommand[]),
    ants: {} as WorldState['ants'],
    colonies: overrides.colonies ?? {},
    pheromoneGrids: {},
    surface: { data: new Uint8Array(sw * sh), width: sw, height: sh },
    // Fully-walkable frozen terrain so every empty tile is a valid entrance
    // target unless a test sets the component mask otherwise.
    bakedSurfaceEffect: new Uint8Array(sw * sh),
    surfaceComponentMask: null,
    undergroundGrids: {},
    foodPiles: overrides.foodPiles ?? [],
    pendingChambers: {},
    spider: overrides.spider ?? null,
    spiderPriorityColonyId: overrides.spiderPriorityColonyId ?? null,
  } as unknown as WorldState;
}

function makeColony(
  overrides: {
    colonyId?: ColonyId;
    rallyPoint?: { tileX: number; tileY: number } | null;
    entrances?: Array<{ surfaceTileX: number; surfaceTileY: number }>;
  } = {},
): WorldState['colonies'][number] {
  // Only the fields the surface tap handlers read are populated; the cast keeps
  // the stub minimal (the handlers never touch the rest of ColonyRecord).
  return {
    colonyId: overrides.colonyId ?? (PLAYER_COLONY_ID as ColonyId),
    entrances: overrides.entrances ?? [],
    rallyPoint: overrides.rallyPoint ?? null,
  } as unknown as WorldState['colonies'][number];
}

function makeSpider(tileX: number, tileY: number): WorldState['spider'] {
  return {
    posX: tileX * FP_ONE,
    posY: tileY * FP_ONE,
  } as unknown as WorldState['spider'];
}

// handleSurfaceDigTap now gates its DesignateEntrance emit on feedforward.willTakeEffect
// (the SAME trial-apply the hover cue uses — Codex parity), which deep-clones the projected
// world via createScenario + projectionCopy + the real applyCommands. That needs a COMPLETE
// WorldState, not the hand-stubbed `makeWorld` above, so the Dig-tap tests build a real
// scenario. Seed 12345 'Normal' gives a deterministic surface: the player colony starts with
// one entrance at column 24, row 64, and the surface is fully walkable, so (2,2)/(3,2) are
// valid NEW entrance targets (distinct columns) while (24,2) is rejected by the sim's
// column-uniqueness gate — the exact divergence the feedforward gate now closes.
const PLAYER_START_ENTRANCE_COL = 24;
function realWorld(overrides: { commandQueue?: SimCommand[] } = {}): WorldState {
  const world = createScenario(12345, 'Normal');
  if (overrides.commandQueue) world.commandQueue = overrides.commandQueue;
  return world;
}

// A feedforward instance for a tap call (mirrors underground-input.test.ts): the tap gates its
// emit on feedforward.willTakeEffect against the PROJECTED world — the same trial-apply the cue
// uses — so the test exercises the real emit gate (column-dup / rally / capped entrances are
// dropped here, not enqueued). A fresh instance per call is fine (lazily owns one scratch world).
function ff(): CommandFeedforward {
  return new CommandFeedforward();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('findFoodPileAt', () => {
  it('returns the pile at the tile, or null', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 1, tileX: 5, tileY: 2, pickupsRemaining: 9, pickupsInitial: 9 }],
    });
    expect(findFoodPileAt(world, 5, 2)?.foodPileId).toBe(1);
    expect(findFoodPileAt(world, 6, 2)).toBeNull();
  });
});

describe('isEmptySurfaceTile', () => {
  it('false on a food pile / entrance / out-of-bounds; true on bare ground', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 1, tileX: 5, tileY: 2, pickupsRemaining: 9, pickupsInitial: 9 }],
      colonies: {
        [PLAYER_COLONY_ID]: makeColony({ entrances: [{ surfaceTileX: 7, surfaceTileY: 2 }] }),
      },
    });
    expect(isEmptySurfaceTile(world, 5, 2)).toBe(false); // food
    expect(isEmptySurfaceTile(world, 7, 2)).toBe(false); // entrance
    expect(isEmptySurfaceTile(world, -1, 2)).toBe(false); // oob
    expect(isEmptySurfaceTile(world, 10, 2)).toBe(true); // bare
  });
});

describe('isForeignColonyEntrance', () => {
  it('true only for an entrance owned by another colony', () => {
    const ENEMY = 2 as ColonyId;
    const world = makeWorld({
      colonies: {
        [PLAYER_COLONY_ID]: makeColony({ entrances: [{ surfaceTileX: 3, surfaceTileY: 1 }] }),
        [ENEMY]: makeColony({ colonyId: ENEMY, entrances: [{ surfaceTileX: 9, surfaceTileY: 1 }] }),
      },
    });
    expect(isForeignColonyEntrance(world, 9, 1, PLAYER_COLONY_ID)).toBe(true);
    expect(isForeignColonyEntrance(world, 3, 1, PLAYER_COLONY_ID)).toBe(false); // own
    expect(isForeignColonyEntrance(world, 5, 1, PLAYER_COLONY_ID)).toBe(false); // none
  });
});

describe('isValidEntranceTarget', () => {
  it('true on fully-walkable empty ground, false on a food pile', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 1, tileX: 5, tileY: 2, pickupsRemaining: 9, pickupsInitial: 9 }],
    });
    expect(isValidEntranceTarget(world, 20, 2)).toBe(true);
    expect(isValidEntranceTarget(world, 5, 2)).toBe(false);
  });
});

describe('isSpiderHit', () => {
  it('true within the sprite half-extent, false outside', () => {
    const vs = makeViewState('surface', 64, 64);
    const world = makeWorld({ spider: makeSpider(64, 64) });
    // Click that projects (screenToWorld) onto the spider's world-pixel center.
    const { x, y } = tileCenterToScreen(64, 64, vs);
    expect(isSpiderHit(world, vs, x, y, null)).toBe(true);
    // At DEFAULT_ZOOM (1) a screen offset of SPIDER_SPRITE_WIDTH (48) px maps to a
    // world offset of 48 px — clear of the half-extent (24) → miss.
    expect(isSpiderHit(world, vs, x + SPIDER_SPRITE_WIDTH, y, null)).toBe(false);
  });
  it('false when there is no spider', () => {
    const vs = makeViewState('surface', 64, 64);
    const world = makeWorld({ spider: null });
    expect(isSpiderHit(world, vs, 100, 100, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSurfaceCommandTap — priority order
// ---------------------------------------------------------------------------

function lastCmd(world: WorldState): SimCommand | undefined {
  return world.commandQueue[world.commandQueue.length - 1];
}

describe('handleSurfaceCommandTap priority', () => {
  it('1. spider hit → MarkSpiderPriority (toggles isPriority)', () => {
    const world = makeWorld({ spider: makeSpider(10, 2), spiderPriorityColonyId: null });
    handleSurfaceCommandTap(world, 10, 2, true /* spiderHit */, false);
    const cmd = lastCmd(world) as { type: string; isPriority: boolean };
    expect(cmd.type).toBe('MarkSpiderPriority');
    expect(cmd.isPriority).toBe(true);
  });

  it('2. food pile → MarkFoodPile (when no spider hit)', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 1, tileX: 5, tileY: 2, pickupsRemaining: 9, pickupsInitial: 9 }],
    });
    handleSurfaceCommandTap(world, 5, 2, false, false);
    expect((lastCmd(world) as { type: string }).type).toBe('MarkFoodPile');
  });

  it('3. clear-rally fires only when the down-tile IS the current rally point', () => {
    const world = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 8, tileY: 2 } }) },
    });
    handleSurfaceCommandTap(world, 8, 2, false, false);
    expect((lastCmd(world) as { type: string }).type).toBe('ClearRallyPoint');
  });

  it('3 precedes 4: a rally placed ON an enemy entrance is clearable (Codex R1-4)', () => {
    const ENEMY = 2 as ColonyId;
    const world = makeWorld({
      colonies: {
        [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 9, tileY: 1 } }),
        [ENEMY]: makeColony({ colonyId: ENEMY, entrances: [{ surfaceTileX: 9, surfaceTileY: 1 }] }),
      },
    });
    handleSurfaceCommandTap(world, 9, 1, false, false);
    // Down-tile == rally → clear wins over the foreign-entrance rally.
    expect((lastCmd(world) as { type: string }).type).toBe('ClearRallyPoint');
  });

  it('4. foreign entrance (not the rally tile) → SetRallyPoint', () => {
    const ENEMY = 2 as ColonyId;
    const world = makeWorld({
      colonies: {
        [PLAYER_COLONY_ID]: makeColony({ rallyPoint: null }),
        [ENEMY]: makeColony({ colonyId: ENEMY, entrances: [{ surfaceTileX: 9, surfaceTileY: 1 }] }),
      },
    });
    handleSurfaceCommandTap(world, 9, 1, false, false);
    const cmd = lastCmd(world) as { type: string; tileX: number; tileY: number };
    expect(cmd.type).toBe('SetRallyPoint');
    expect([cmd.tileX, cmd.tileY]).toEqual([9, 1]);
  });

  it('5. empty tile → SetRallyPoint', () => {
    const world = makeWorld({ colonies: { [PLAYER_COLONY_ID]: makeColony() } });
    handleSurfaceCommandTap(world, 20, 2, false, false);
    expect((lastCmd(world) as { type: string }).type).toBe('SetRallyPoint');
  });

  it('negative tile is a no-op', () => {
    const world = makeWorld({ colonies: { [PLAYER_COLONY_ID]: makeColony() } });
    handleSurfaceCommandTap(world, -1, 2, false, false);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// effectiveSpiderPriority + paused spider-priority toggle (Codex P2)
// ---------------------------------------------------------------------------

describe('effectiveSpiderPriority', () => {
  it('falls back to the live spiderPriorityColonyId when nothing is queued', () => {
    const offWorld = makeWorld({ spiderPriorityColonyId: null });
    expect(effectiveSpiderPriority(offWorld, PLAYER_COLONY_ID)).toBe(false);
    const onWorld = makeWorld({ spiderPriorityColonyId: PLAYER_COLONY_ID });
    expect(effectiveSpiderPriority(onWorld, PLAYER_COLONY_ID)).toBe(true);
  });

  it('reflects the LATEST queued MarkSpiderPriority for the player colony', () => {
    const world = makeWorld({
      spiderPriorityColonyId: null,
      commandQueue: [
        {
          type: 'MarkSpiderPriority',
          colonyId: PLAYER_COLONY_ID,
          isPriority: true,
          issuedAtTick: 0,
        },
        {
          type: 'MarkSpiderPriority',
          colonyId: PLAYER_COLONY_ID,
          isPriority: false,
          issuedAtTick: 1,
        },
      ],
    });
    // Last-queued wins (mirrors tick.ts FIFO apply order) → effectively OFF.
    expect(effectiveSpiderPriority(world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('ignores queued MarkSpiderPriority for OTHER colonies', () => {
    const ENEMY = 2 as ColonyId;
    const world = makeWorld({
      spiderPriorityColonyId: null,
      commandQueue: [
        { type: 'MarkSpiderPriority', colonyId: ENEMY, isPriority: true, issuedAtTick: 0 },
      ],
    });
    expect(effectiveSpiderPriority(world, PLAYER_COLONY_ID)).toBe(false);
  });
});

describe('paused spider-priority tap-tap toggles correctly (Codex P2)', () => {
  it('while PAUSED, two taps net priority-on-then-off (frozen sim, queue-aware)', () => {
    // Bare-user-paused: the sim never advances, so spiderPriorityColonyId stays
    // frozen at null across both taps. The toggle must resolve against the queue.
    const world = makeWorld({ spider: makeSpider(10, 2), spiderPriorityColonyId: null });
    handleSurfaceCommandTap(world, 10, 2, true /* spiderHit */, true /* paused */);
    handleSurfaceCommandTap(world, 10, 2, true, true);
    const cmds = world.commandQueue.filter((c) => c.type === 'MarkSpiderPriority') as Array<{
      isPriority: boolean;
    }>;
    expect(cmds).toHaveLength(2);
    expect(cmds[0]!.isPriority).toBe(true); // first tap turns priority ON
    expect(cmds[1]!.isPriority).toBe(false); // second tap toggles it back OFF
  });

  it('unpaused behaviour unchanged: a single tap toggles against the live flag', () => {
    // Priority already ON in the live world (queue empty, as it is after a tick
    // drains) → one tap turns it OFF.
    const world = makeWorld({
      spider: makeSpider(10, 2),
      spiderPriorityColonyId: PLAYER_COLONY_ID,
    });
    handleSurfaceCommandTap(world, 10, 2, true /* spiderHit */, false /* unpaused */);
    const cmd = lastCmd(world) as { type: string; isPriority: boolean };
    expect(cmd.type).toBe('MarkSpiderPriority');
    expect(cmd.isPriority).toBe(false); // toggled OFF against the live ON flag
  });
});

// ---------------------------------------------------------------------------
// effectiveRallyState + paused rally tap-tap (Codex P2)
// ---------------------------------------------------------------------------

describe('effectiveRallyState', () => {
  it('falls back to the live rallyPoint when nothing is queued', () => {
    const noneWorld = makeWorld({ colonies: { [PLAYER_COLONY_ID]: makeColony() } });
    expect(effectiveRallyState(noneWorld, PLAYER_COLONY_ID)).toBeNull();
    const setWorld = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 8, tileY: 2 } }) },
    });
    expect(effectiveRallyState(setWorld, PLAYER_COLONY_ID)).toEqual({ tileX: 8, tileY: 2 });
  });

  it('reflects the LATEST queued Set/Clear for the player colony (last wins)', () => {
    // A queued Set THEN Clear nets no rally; a queued Clear THEN Set nets the Set.
    const clearLast = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 1, tileY: 1 } }) },
      commandQueue: [
        { type: 'SetRallyPoint', colonyId: PLAYER_COLONY_ID, tileX: 8, tileY: 2, issuedAtTick: 0 },
        { type: 'ClearRallyPoint', colonyId: PLAYER_COLONY_ID, issuedAtTick: 1 },
      ],
    });
    expect(effectiveRallyState(clearLast, PLAYER_COLONY_ID)).toBeNull();
    const setLast = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 1, tileY: 1 } }) },
      commandQueue: [
        { type: 'ClearRallyPoint', colonyId: PLAYER_COLONY_ID, issuedAtTick: 0 },
        { type: 'SetRallyPoint', colonyId: PLAYER_COLONY_ID, tileX: 9, tileY: 3, issuedAtTick: 1 },
      ],
    });
    expect(effectiveRallyState(setLast, PLAYER_COLONY_ID)).toEqual({ tileX: 9, tileY: 3 });
  });

  it('ignores queued Set/Clear for OTHER colonies', () => {
    const ENEMY = 2 as ColonyId;
    const world = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 4, tileY: 4 } }) },
      commandQueue: [
        { type: 'ClearRallyPoint', colonyId: ENEMY, issuedAtTick: 0 },
        { type: 'SetRallyPoint', colonyId: ENEMY, tileX: 7, tileY: 7, issuedAtTick: 1 },
      ],
    });
    // Enemy commands don't shadow the player's live rally.
    expect(effectiveRallyState(world, PLAYER_COLONY_ID)).toEqual({ tileX: 4, tileY: 4 });
  });
});

describe('paused rally tap-tap toggles correctly (Codex P2)', () => {
  it('while PAUSED, tap-tap on an EMPTY tile nets Set then Clear (queue-aware)', () => {
    // Bare-user-paused: the sim never advances, so playerColony.rallyPoint stays
    // frozen at null across both taps. The clear-vs-set decision must resolve
    // against the queue — otherwise the second tap would queue a SECOND Set.
    const world = makeWorld({ colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: null }) } });
    handleSurfaceCommandTap(world, 20, 2, false /* spiderHit */, true /* paused */);
    handleSurfaceCommandTap(world, 20, 2, false, true);
    const cmds = world.commandQueue.filter(
      (c) => c.type === 'SetRallyPoint' || c.type === 'ClearRallyPoint',
    );
    expect(cmds.map((c) => c.type)).toEqual(['SetRallyPoint', 'ClearRallyPoint']);
  });

  it('while PAUSED, tap-tap on the (effective) rally tile nets Clear then Set', () => {
    // The tile already IS the live rally. First tap clears it; second tap sees the
    // queued Clear (effective rally null) and re-sets it on the empty tile.
    const world = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 20, tileY: 2 } }) },
    });
    handleSurfaceCommandTap(world, 20, 2, false /* spiderHit */, true /* paused */);
    handleSurfaceCommandTap(world, 20, 2, false, true);
    const cmds = world.commandQueue.filter(
      (c) => c.type === 'SetRallyPoint' || c.type === 'ClearRallyPoint',
    );
    expect(cmds.map((c) => c.type)).toEqual(['ClearRallyPoint', 'SetRallyPoint']);
  });

  it('unpaused behaviour unchanged: tapping the live rally tile clears it', () => {
    // Queue empty (as after a tick drains) → effective rally equals the live one.
    const world = makeWorld({
      colonies: { [PLAYER_COLONY_ID]: makeColony({ rallyPoint: { tileX: 8, tileY: 2 } }) },
    });
    handleSurfaceCommandTap(world, 8, 2, false /* spiderHit */, false /* unpaused */);
    expect((lastCmd(world) as { type: string }).type).toBe('ClearRallyPoint');
  });
});

// ---------------------------------------------------------------------------
// handleSurfaceDigTap
// ---------------------------------------------------------------------------

describe('handleSurfaceDigTap', () => {
  it('valid target → DesignateEntrance', () => {
    const world = realWorld();
    handleSurfaceDigTap(world, world, ff(), 2, 2, false);
    const cmd = lastCmd(world) as { type: string; surfaceTileX: number; surfaceTileY: number };
    expect(cmd.type).toBe('DesignateEntrance');
    expect([cmd.surfaceTileX, cmd.surfaceTileY]).toEqual([2, 2]);
  });

  it('invalid target (food pile) → no-op', () => {
    const world = realWorld();
    // Drop a food pile on an otherwise-valid target; the sim's DesignateEntrance gate rejects it,
    // so feedforward.willTakeEffect is false and nothing enqueues.
    world.foodPiles.push({
      foodPileId: 999,
      tileX: 2,
      tileY: 2,
      pickupsRemaining: 9,
      pickupsInitial: 9,
    });
    world.surfaceComponentMask = null; // re-derive the walkable mask with the pile present
    handleSurfaceDigTap(world, world, ff(), 2, 2, false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('duplicate-column target → no-op (cue/command parity, Codex)', () => {
    // The colony already has its starting entrance at column 24. A SECOND entrance in the SAME
    // column (different row) is empty ground inside the walkable component — isValidEntranceTarget
    // (the old gate) returned TRUE for it — but the sim's column-uniqueness rule silently drops it.
    // The hover cue paints it red via the full trial-apply; gating the tap on the SAME
    // feedforward.willTakeEffect closes the divergence so no doomed no-op is enqueued.
    const world = realWorld();
    const dropped = handleSurfaceDigTap(world, world, ff(), PLAYER_START_ENTRANCE_COL, 2, false);
    expect(dropped).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('validates the entrance against the projected world, not committed (Codex)', () => {
    // (2,2) is a valid entrance target in the committed world...
    const committed = realWorld();
    // ...but the PROJECTED world already has a queued DesignateEntrance for (2,2) folded in, so a
    // SECOND entrance there is a duplicate the sim drops — the tap must read the projection (else a
    // paused re-tap re-queues a duplicate no-op). The projection makes the would-be tile invalid.
    const projected = realWorld();
    projected.colonies[PLAYER_COLONY_ID]!.entrances.push({
      entranceId: 9001,
      surfaceTileX: 2,
      surfaceTileY: 2,
      isOpen: false,
    });
    const dropped = handleSurfaceDigTap(committed, projected, ff(), 2, 2, false);
    expect(dropped).toBe(false);
    expect(committed.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Paused-cap (enqueueCommand) — across this producer
// ---------------------------------------------------------------------------

describe('paused-queue cap', () => {
  it('drops a Dig-tap entrance command once the queue is at the cap while paused', () => {
    // Pre-fill with MAX non-Sync commands. NoOp leaves the projected world unchanged, so (2,2)
    // is still a geometrically-valid entrance target — the drop is purely the cap (feedforward
    // returns 'blocked', willTakeEffect is still true), exercising the paused-cap guard.
    const pre: SimCommand[] = Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const world = realWorld({ commandQueue: pre });
    const dropped = handleSurfaceDigTap(world, world, ff(), 2, 2, true /* paused */);
    expect(dropped).toBe(true);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK); // not pushed
  });

  it('still enqueues when under the cap while paused', () => {
    const world = realWorld();
    const dropped = handleSurfaceDigTap(world, world, ff(), 2, 2, true);
    expect(dropped).toBe(false);
    // createScenario seeds no commands, so the entrance is the only queued command.
    expect(world.commandQueue).toHaveLength(1);
  });
});
