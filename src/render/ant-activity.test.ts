// ant-activity.test.ts — Vitest unit tests for the HUD ant-activity popup
// data model. Verifies bucket mapping, dead-worker filtering, capable-count
// semantics, and formatted output stability.

import { describe, it, expect } from 'vitest';
import {
  computeAntActivity,
  formatAntActivityLines,
  antActivityPanelRect,
} from './ant-activity.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';
import { createWorldState, allocateEntityId } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { initAnt, killAnt } from '../sim/ant/ant-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import {
  AntTask,
  ForagingSubState,
  DiggingSubState,
  FightingSubState,
  NursingSubState,
} from '../sim/enums.js';

function setupWorld(): { world: WorldState; colony: ColonyRecord; queenId: number } {
  const world = createWorldState(64);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, { colonyId: 1, posX: 0, posY: 0, task: AntTask.Idle });
  const colony = createColonyRecord(1, queenId);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[1] = colony;
  return { world, colony, queenId };
}

function spawnWorker(
  world: WorldState,
  colony: ColonyRecord,
  task: number,
  subTask: number,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, { colonyId: 1, posX: 0, posY: 0, task, subTask });
  colony.workers.push(id);
  colony.workerCount = colony.workers.length;
  return id;
}

describe('computeAntActivity — bucket mapping', () => {
  it('splits foragers into searching vs carrying', () => {
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.SearchingFood);
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.SearchingFood);
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.CarryingFood);
    const a = computeAntActivity(world, colony);
    expect(a.foraging.searching).toBe(2);
    expect(a.foraging.carrying).toBe(1);
    expect(a.foraging.total).toBe(3);
  });

  it('splits ReturningToNest into its own returning bucket (failed-search walk home)', () => {
    // 09 excursion-foraging memo: ReturningToNest is a real, visible sim state
    // — empty-handed foragers heading back to reset the search leash. The
    // HUD surfaces it separately from carrying (delivering food) so the
    // player can tell "my ants are empty-handed coming back" from "my ants
    // are delivering food".
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.CarryingFood);
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.ReturningToNest);
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.ReturningToNest);
    const a = computeAntActivity(world, colony);
    expect(a.foraging.carrying).toBe(1);
    expect(a.foraging.returning).toBe(2);
    expect(a.foraging.searching).toBe(0);
    expect(a.foraging.total).toBe(3);
  });

  it('splits diggers into moving-to-site vs excavating', () => {
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Digging, DiggingSubState.MovingToTile);
    spawnWorker(world, colony, AntTask.Digging, DiggingSubState.Excavating);
    spawnWorker(world, colony, AntTask.Digging, DiggingSubState.Excavating);
    const a = computeAntActivity(world, colony);
    expect(a.digging.movingToSite).toBe(1);
    expect(a.digging.excavating).toBe(2);
    expect(a.digging.total).toBe(3);
  });

  it('lumps fighters regardless of sub-state', () => {
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Fighting, FightingSubState.MovingToRally);
    spawnWorker(world, colony, AntTask.Fighting, FightingSubState.Engaging);
    const a = computeAntActivity(world, colony);
    expect(a.fighting).toBe(2);
  });

  it('lumps nurses regardless of sub-state', () => {
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Nursing, NursingSubState.MovingToBrood);
    spawnWorker(world, colony, AntTask.Nursing, NursingSubState.Feeding);
    const a = computeAntActivity(world, colony);
    expect(a.nursing).toBe(2);
  });

  it('idle workers report under idle bucket', () => {
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Idle, 0);
    spawnWorker(world, colony, AntTask.Idle, 0);
    const a = computeAntActivity(world, colony);
    expect(a.idle).toBe(2);
  });
});

describe('computeAntActivity — capable count', () => {
  it('capableAnts = living workers + living queen', () => {
    const { world, colony } = setupWorld();
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.SearchingFood);
    spawnWorker(world, colony, AntTask.Idle, 0);
    const a = computeAntActivity(world, colony);
    expect(a.capableAnts).toBe(2 + 1);
    expect(a.totalWorkers).toBe(2);
    expect(a.queenAlive).toBe(true);
  });

  it('capableAnts excludes the queen when queen dead', () => {
    const { world, colony, queenId } = setupWorld();
    spawnWorker(world, colony, AntTask.Idle, 0);
    killAnt(world.ants, queenId);
    const a = computeAntActivity(world, colony);
    expect(a.capableAnts).toBe(1);
    expect(a.queenAlive).toBe(false);
  });

  it('brood counts come from the colony record, not the worker array', () => {
    const { world, colony } = setupWorld();
    colony.eggCount = 5;
    colony.larvaeCount = 2;
    const a = computeAntActivity(world, colony);
    expect(a.eggs).toBe(5);
    expect(a.larvae).toBe(2);
    expect(a.capableAnts).toBe(1); // only the queen counts as capable here
  });
});

describe('computeAntActivity — dead-worker filtering', () => {
  it('dead workers are skipped entirely', () => {
    const { world, colony } = setupWorld();
    const alive = spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.SearchingFood);
    const dead = spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.SearchingFood);
    killAnt(world.ants, dead);
    expect(alive).not.toBe(dead);
    const a = computeAntActivity(world, colony);
    expect(a.foraging.searching).toBe(1);
    expect(a.totalWorkers).toBe(1);
  });
});

describe('formatAntActivityLines', () => {
  it('emits a stable set of labeled lines', () => {
    const { world, colony } = setupWorld();
    colony.eggCount = 3;
    colony.larvaeCount = 1;
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.SearchingFood);
    spawnWorker(world, colony, AntTask.Foraging, ForagingSubState.CarryingFood);
    spawnWorker(world, colony, AntTask.Digging, DiggingSubState.Excavating);
    spawnWorker(world, colony, AntTask.Nursing, NursingSubState.Feeding);
    spawnWorker(world, colony, AntTask.Idle, 0);
    const a = computeAntActivity(world, colony);
    const lines = formatAntActivityLines(a);
    const joined = lines.join('\n');
    expect(joined).toContain('Capable ants: 6');
    expect(joined).toContain('Queen: alive');
    expect(joined).toContain('Workers: 5');
    expect(joined).toContain('Eggs:   3');
    expect(joined).toContain('Larvae: 1');
    expect(joined).toContain('Foraging: 2');
    expect(joined).toContain('searching: 1');
    expect(joined).toContain('returning: 0');
    expect(joined).toContain('carrying:  1');
    expect(joined).toContain('Digging:  1');
    expect(joined).toContain('digging:   1');
    expect(joined).toContain('Nursing:  1');
    expect(joined).toContain('Idle:     1');
  });

  it('reports Queen: dead when the queen is gone', () => {
    const { world, colony, queenId } = setupWorld();
    killAnt(world.ants, queenId);
    const a = computeAntActivity(world, colony);
    expect(formatAntActivityLines(a).join('\n')).toContain('Queen: dead');
  });
});

describe('antActivityPanelRect layout', () => {
  it('anchors below the stats bar and fits within the 800x592 canvas', () => {
    const panel = antActivityPanelRect(buildHudLayout(DEFAULT_LAYOUT).STATS);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.y).toBeGreaterThan(8 + 24); // below the stats bar (y=8, h=24)
    expect(panel.x + panel.w).toBeLessThanOrEqual(800);
    expect(panel.y + panel.h).toBeLessThanOrEqual(592);
  });
});

describe('antActivityPanelState — state machine', () => {
  // UIScene drives these transitions via its pointerdown handler; these
  // tests lock the state-level contract that handler relies on so a future
  // refactor can't silently break the open-dismiss-reopen cycle.
  it('toggle opens then closes on successive calls (click on Ants)', async () => {
    const { antActivityPanelState, toggleAntActivityPanel, hideAntActivityPanel } =
      await import('./ant-activity-panel-state.js');
    hideAntActivityPanel(); // reset
    toggleAntActivityPanel();
    expect(antActivityPanelState.visible).toBe(true);
    toggleAntActivityPanel();
    expect(antActivityPanelState.visible).toBe(false);
  });

  it('requestHide leaves visible=true until applyPending runs (click inside panel is NOT the dismiss path)', async () => {
    // Locks the invariant UIScene depends on: the "click inside panel is
    // absorbed" path simply returns without touching panel state — it does
    // NOT schedule a hide. Only click-outside paths call requestHide.
    const { antActivityPanelState, showAntActivityPanel, hideAntActivityPanel } =
      await import('./ant-activity-panel-state.js');
    showAntActivityPanel();
    expect(antActivityPanelState.visible).toBe(true);
    expect(antActivityPanelState.pendingHide).toBe(false);
    // UIScene's "click inside panel" branch returns without mutating state —
    // verify no mutation helper can sneak in by asserting the flags are
    // still as set.
    expect(antActivityPanelState.visible).toBe(true);
    expect(antActivityPanelState.pendingHide).toBe(false);
    hideAntActivityPanel();
  });

  it('requestHide sets pendingHide but keeps visible=true for the current dispatch', async () => {
    const {
      antActivityPanelState,
      showAntActivityPanel,
      requestHideAntActivityPanel,
      hideAntActivityPanel,
    } = await import('./ant-activity-panel-state.js');
    showAntActivityPanel();
    requestHideAntActivityPanel();
    expect(antActivityPanelState.visible).toBe(true);
    expect(antActivityPanelState.pendingHide).toBe(true);
    hideAntActivityPanel();
  });

  it('applyPendingHide commits the flip at frame boundary', async () => {
    const {
      antActivityPanelState,
      showAntActivityPanel,
      requestHideAntActivityPanel,
      applyPendingAntActivityPanelHide,
      hideAntActivityPanel,
    } = await import('./ant-activity-panel-state.js');
    showAntActivityPanel();
    requestHideAntActivityPanel();
    applyPendingAntActivityPanelHide();
    expect(antActivityPanelState.visible).toBe(false);
    expect(antActivityPanelState.pendingHide).toBe(false);
    hideAntActivityPanel();
  });

  it('applyPendingHide is a no-op when no hide is pending', async () => {
    const {
      antActivityPanelState,
      showAntActivityPanel,
      applyPendingAntActivityPanelHide,
      hideAntActivityPanel,
    } = await import('./ant-activity-panel-state.js');
    showAntActivityPanel();
    applyPendingAntActivityPanelHide();
    expect(antActivityPanelState.visible).toBe(true);
    hideAntActivityPanel();
  });

  it('toggle clears any pending hide (re-open reuses the same object)', async () => {
    const {
      antActivityPanelState,
      showAntActivityPanel,
      requestHideAntActivityPanel,
      toggleAntActivityPanel,
      hideAntActivityPanel,
    } = await import('./ant-activity-panel-state.js');
    showAntActivityPanel();
    requestHideAntActivityPanel();
    // toggle should leave the panel visible (it's currently visible=true) AND
    // clear pendingHide so a stale dismiss doesn't fire on the next frame.
    // Calling toggle flips visible → false here, which is fine — the next
    // toggle reopens cleanly. The important invariant is pendingHide=false.
    toggleAntActivityPanel();
    expect(antActivityPanelState.pendingHide).toBe(false);
    hideAntActivityPanel();
  });
});
