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
  handleSurfaceCommandTap,
  handleSurfaceDigTap,
} from './surface-input.js';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES } from '../render/camera.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import { FP_ONE } from '../sim/fixed.js';
import { SPIDER_SPRITE_WIDTH } from '../render/ant-sprite-layer.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT, PLAYER_COLONY_ID } from '../sim/constants.js';
import { MAX_COMMANDS_PER_TICK, type SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeViewState(
  view: 'surface' | 'underground' = 'surface',
  camX = 64,
  camY = 64,
): ViewState {
  return {
    activeView: view,
    activeTool: view === 'surface' ? 'command' : 'dig',
    surfaceCamera: {
      x: camX,
      y: camY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundCamera: {
      x: camX,
      y: camY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundVisited: false,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    showPheromoneOverlay: true,
  };
}

/** tile → screen px, mirroring the renderer's integer-tile snap. */
function tileToScreen(tileX: number, tileY: number, camX: number, camY: number) {
  const left = Math.floor(camX - VIEWPORT_WIDTH_TILES / 2);
  const top = Math.floor(camY - VIEWPORT_HEIGHT_TILES / 2);
  return { x: (tileX - left) * TILE_SIZE_PX, y: (tileY - top) * TILE_SIZE_PX };
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
    const { x, y } = tileToScreen(64, 64, 64, 64);
    expect(isSpiderHit(world, vs, x, y, null)).toBe(true);
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
// handleSurfaceDigTap
// ---------------------------------------------------------------------------

describe('handleSurfaceDigTap', () => {
  it('valid target → DesignateEntrance', () => {
    const world = makeWorld({ colonies: { [PLAYER_COLONY_ID]: makeColony() } });
    handleSurfaceDigTap(world, 20, 2, false);
    const cmd = lastCmd(world) as { type: string; surfaceTileX: number; surfaceTileY: number };
    expect(cmd.type).toBe('DesignateEntrance');
    expect([cmd.surfaceTileX, cmd.surfaceTileY]).toEqual([20, 2]);
  });

  it('invalid target (food pile) → no-op', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 1, tileX: 5, tileY: 2, pickupsRemaining: 9, pickupsInitial: 9 }],
    });
    handleSurfaceDigTap(world, 5, 2, false);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Paused-cap (enqueueCommand) — across this producer
// ---------------------------------------------------------------------------

describe('paused-queue cap', () => {
  it('drops a Dig-tap entrance command once the queue is at the cap while paused', () => {
    // Pre-fill with MAX non-Sync commands.
    const pre: SimCommand[] = Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const world = makeWorld({ commandQueue: pre, colonies: { [PLAYER_COLONY_ID]: makeColony() } });
    const dropped = handleSurfaceDigTap(world, 20, 2, true /* paused */);
    expect(dropped).toBe(true);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK); // not pushed
  });

  it('still enqueues when under the cap while paused', () => {
    const world = makeWorld({ colonies: { [PLAYER_COLONY_ID]: makeColony() } });
    const dropped = handleSurfaceDigTap(world, 20, 2, true);
    expect(dropped).toBe(false);
    expect(world.commandQueue).toHaveLength(1);
  });
});
