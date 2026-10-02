// sim-tick-hook.test.ts — #397: the rampage warning's threat check runs before
// every sim tick, so a threat that lasts one tick inside a multi-tick render frame
// still owes the warning (GameScene's per-frame check sees only the frame's last
// tick); and, with the interpolation snapshot, it sees each tick as its rampage
// shelter did (an entrance opened mid-tick, #406 review).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameLoop, MAX_CATCHUP_TICKS, MS_PER_TICK } from '../platform/game-loop.js';
import { createScenario } from '../sim/scenario.js';
import { GameOutcome } from '../sim/game-over.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import { copyWorldState, type SpiderBehaviorState, type WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';
import {
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  SPIDER_GRACE_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
} from '../sim/constants.js';
import { beforeSimTick } from './sim-tick-hook.js';
import { createStoresFillingCaptionState } from './stores-filling-caption.js';
import { createArmyWarningState } from './army-warning.js';
import { createStorageHintState } from './storage-hint.js';
import { createQueenDangerState } from './queen-danger.js';
import { createCounterAttackCaptionState } from './counter-attack-caption.js';
import { createEnemyQueenWoundState } from './enemy-queen-wound.js';
import {
  createRampageCaptionState,
  noteRampageThreat,
  offerOwedRampageCaption,
  rampageThreatenedViewerLastTick,
  type RampageCaptionState,
  type RecurringCaptionSink,
} from './recurring-captions.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
const RAMPAGE_TEXT = 'The spider has gone hungry and is hunting on the surface.';
/** Seed 7: the spider's lair, far from both colonies' entrances. */
const LAIR = { x: 67, y: 117 } as const;
const T1 = SPIDER_GRACE_TICKS + 500;
const HUNGRY = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;

function setTick(world: WorldState, tick: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock, not a render write
  world.tick = tick;
}

function setSpider(world: WorldState, state: SpiderBehaviorState, target: number): void {
  const sp = world.spider!;
  sp.state = state;
  sp.posX = (LAIR.x << FP_SHIFT) + (FP_ONE >> 1);
  sp.posY = (LAIR.y << FP_SHIFT) + (FP_ONE >> 1);
  sp.rampageTargetColonyId = target;
}

/** A seed-7 world at T1, its spider hungry and patrolling at its lair (no threat). */
function quietWorld(): WorldState {
  const world = createScenario(7, 'Normal');
  setTick(world, T1);
  setSpider(world, 'Patrolling', -1);
  world.spider!.hungerTicks = HUNGRY;
  return world;
}

/**
 * A scripted tick: the spider's hunger grows; on the first tick it sets out to camp
 * the player's door (a rampage on it: a threat however far off it still is), and on
 * the second a chase divert clears its target, far from any player door (no
 * threat). The threat lasts exactly one tick. It does the same again on ticks 7 and
 * 8 — inside the second five-tick frame — still hungry: the same hungry spell.
 */
function scriptedTick(world: WorldState, _cmds: readonly SimCommand[]): GameOutcome {
  setTick(world, world.tick + 1);
  world.spider!.hungerTicks++;
  const k = world.tick - T1;
  if (k === 1 || k === 7) setSpider(world, 'Rampaging', P);
  else if (k === 2 || k === 8) setSpider(world, 'Chasing', -1);
  return GameOutcome.None;
}

/** A player entrance four tiles from the spider's lair, still being dug (closed). */
const SHAFT = { x: LAIR.x + 4, y: LAIR.y } as const;

/** quietWorld with that closed entrance: the hungry spider at its lair, out of
 *  reach of every open player door, so no threat. */
function shaftWorld(): WorldState {
  const world = quietWorld();
  world.colonies[P]!.entrances.push({
    entranceId: 9000,
    surfaceTileX: SHAFT.x,
    surfaceTileY: SHAFT.y,
    isOpen: false,
  });
  return world;
}

/**
 * A scripted tick in the sim's order: on the first tick the shaft is finished
 * (step 12 opens the entrance, four tiles from the spider: the rampage shelter at
 * step 15b sees a threat), then the spider walks 20 tiles off (step 17.5), out of
 * reach of every player door. Then nothing more happens.
 */
function shaftTick(world: WorldState, _cmds: readonly SimCommand[]): GameOutcome {
  world.spider!.hungerTicks++;
  if (world.tick === T1) {
    world.colonies[P]!.entrances.find((e) => e.entranceId === 9000)!.isOpen = true;
    world.spider!.posX -= 20 << FP_SHIFT;
  }
  setTick(world, world.tick + 1);
  return GameOutcome.None;
}

class Sink implements RecurringCaptionSink {
  readonly shown: string[] = [];
  captionQueueIdle(): boolean {
    return true;
  }
  showCaption(text: string): boolean {
    this.shown.push(text);
    return true;
  }
}

/** One render frame as GameScene runs it: the loop's ticks, then the per-frame
 *  threat check (with GameScene's interpolation snapshot `prev`) and offer. */
function frame(
  loop: { update(dtMs: number): void },
  world: WorldState,
  s: RampageCaptionState,
  ui: Sink,
  dtMs: number,
  prev: WorldState | null = null,
): void {
  loop.update(dtMs);
  noteRampageThreat(s, world, P, prev);
  offerOwedRampageCaption(s, world, ui, 0, 0);
}

describe('beforeSimTick — the rampage threat is checked every tick (#397)', () => {
  it('a threat lasting one tick inside a five-tick frame owes the warning', () => {
    const world = quietWorld();
    const prev = createScenario(7, 'Normal');
    const s = createRampageCaptionState();
    const ui = new Sink();
    const loop = createGameLoop(scriptedTick, world, {
      onBeforeTick: (w) =>
        beforeSimTick(w, [], P, prev, {
          rampage: s,
          queenDanger: createQueenDangerState(),
          enemyQueenWound: createEnemyQueenWoundState(),
          counterAttack: createCounterAttackCaptionState(),
          storesFilling: createStoresFillingCaptionState(),
          armyWarning: createArmyWarningState(),
          storageHint: createStorageHintState(),
        }),
    });
    frame(loop, world, s, ui, MS_PER_TICK * MAX_CATCHUP_TICKS, prev);
    expect(world.tick).toBe(T1 + MAX_CATCHUP_TICKS); // one frame, five ticks
    // Seen before tick 2, on the world tick 1 left: owed from then, and shown.
    expect(ui.shown).toEqual([RAMPAGE_TEXT]);
    // Shown once: the second one-tick camp, inside the next frame, is the same
    // hungry spell — not shown again.
    frame(loop, world, s, ui, MS_PER_TICK * MAX_CATCHUP_TICKS, prev);
    expect(world.tick).toBe(T1 + 2 * MAX_CATCHUP_TICKS);
    expect(ui.shown).toEqual([RAMPAGE_TEXT]);
  });

  it('owes it from the tick the threat was seen, with the hunger then', () => {
    const world = quietWorld();
    const prev = createScenario(7, 'Normal');
    const s = createRampageCaptionState();
    const loop = createGameLoop(scriptedTick, world, {
      onBeforeTick: (w) =>
        beforeSimTick(w, [], P, prev, {
          rampage: s,
          queenDanger: createQueenDangerState(),
          enemyQueenWound: createEnemyQueenWoundState(),
          counterAttack: createCounterAttackCaptionState(),
          storesFilling: createStoresFillingCaptionState(),
          armyWarning: createArmyWarningState(),
          storageHint: createStorageHintState(),
        }),
    });
    loop.update(MS_PER_TICK * 3);
    expect([s.owedSinceTick, s.owedHungerTicks]).toEqual([T1 + 1, HUNGRY + 1]);
  });

  it('why: checked only once a frame, the same threat is never seen', () => {
    const world = quietWorld();
    const s = createRampageCaptionState();
    const ui = new Sink();
    const loop = createGameLoop(scriptedTick, world);
    frame(loop, world, s, ui, MS_PER_TICK * MAX_CATCHUP_TICKS);
    frame(loop, world, s, ui, MS_PER_TICK * MAX_CATCHUP_TICKS);
    expect(ui.shown).toEqual([]);
    expect(s.owedSinceTick).toBe(-Infinity);
  });

  it('one tick per frame: the per-frame check and the next tick’s check see the same state — shown once', () => {
    const world = quietWorld();
    const prev = createScenario(7, 'Normal');
    const s = createRampageCaptionState();
    const ui = new Sink();
    const loop = createGameLoop(scriptedTick, world, {
      onBeforeTick: (w) =>
        beforeSimTick(w, [], P, prev, {
          rampage: s,
          queenDanger: createQueenDangerState(),
          enemyQueenWound: createEnemyQueenWoundState(),
          counterAttack: createCounterAttackCaptionState(),
          storesFilling: createStoresFillingCaptionState(),
          armyWarning: createArmyWarningState(),
          storageHint: createStorageHintState(),
        }),
    });
    for (let f = 0; f < 4; f++) frame(loop, world, s, ui, MS_PER_TICK, prev);
    expect(ui.shown).toEqual([RAMPAGE_TEXT]);
  });

  it('still runs the AI colonies before the tick and takes the interpolation snapshot', () => {
    const world = createScenario(7, 'Normal');
    const prev = createScenario(7, 'Normal');
    setTick(world, 3);
    expect(world.commandQueue).toEqual([]);
    beforeSimTick(world, [E], P, prev, {
      rampage: createRampageCaptionState(),
      queenDanger: createQueenDangerState(),
      enemyQueenWound: createEnemyQueenWoundState(),
      counterAttack: createCounterAttackCaptionState(),
      storesFilling: createStoresFillingCaptionState(),
      armyWarning: createArmyWarningState(),
      storageHint: createStorageHintState(),
    });
    // The enemy AI's opening commands are queued for this tick's drain...
    expect(world.commandQueue.length).toBeGreaterThan(0);
    expect(world.commandQueue.every((c) => 'colonyId' in c && c.colonyId === E)).toBe(true);
    // ...and the snapshot is of the world as it stands before the tick, those
    // commands included (taken after the AI, as before #397).
    expect(prev.tick).toBe(3);
    expect(prev.commandQueue).toEqual(world.commandQueue);
  });

  it('Jev opponent beta: a passed dispatcher drives each AI colony instead of runAIController', () => {
    const world = createScenario(7, 'Normal');
    const prev = createScenario(7, 'Normal');
    setTick(world, 3);
    const driven: number[] = [];
    beforeSimTick(
      world,
      [E],
      P,
      prev,
      {
        rampage: createRampageCaptionState(),
        queenDanger: createQueenDangerState(),
        enemyQueenWound: createEnemyQueenWoundState(),
        counterAttack: createCounterAttackCaptionState(),
        storesFilling: createStoresFillingCaptionState(),
        storageHint: createStorageHintState(),
      },
      (w, cid) => {
        expect(w).toBe(world);
        driven.push(cid);
      },
    );
    expect(driven).toEqual([E]);
    // The rules AI did not run (it would have queued its opening commands)...
    expect(world.commandQueue).toEqual([]);
    // ...and the interpolation snapshot is still taken.
    expect(prev.tick).toBe(3);
  });

  it('an entrance a tick opens near the spider, which then walks out of reach that tick, owes it (#406 review)', () => {
    // The rampage shelter (step 15b) sees the entrance step 12 opened, and the
    // spider before it moves (step 17.5): its idle workers head in. The world
    // before the tick (a closed door) and after it (the spider far off) show no
    // threat; the tick between them, as the shelter saw it, does.
    for (const ticksPerFrame of [1, MAX_CATCHUP_TICKS]) {
      const world = shaftWorld();
      const prev = createScenario(7, 'Normal');
      const s = createRampageCaptionState();
      const ui = new Sink();
      const loop = createGameLoop(shaftTick, world, {
        onBeforeTick: (w) =>
          beforeSimTick(w, [], P, prev, {
            rampage: s,
            queenDanger: createQueenDangerState(),
            enemyQueenWound: createEnemyQueenWoundState(),
            counterAttack: createCounterAttackCaptionState(),
            storesFilling: createStoresFillingCaptionState(),
            armyWarning: createArmyWarningState(),
            storageHint: createStorageHintState(),
          }),
      });
      frame(loop, world, s, ui, MS_PER_TICK * ticksPerFrame, prev);
      // One tick: seen by the per-frame check. Five: by the next tick's
      // beforeSimTick (by the frame's end the spider is out of reach).
      expect(world.tick).toBe(T1 + ticksPerFrame);
      expect([ticksPerFrame, ui.shown]).toEqual([ticksPerFrame, [RAMPAGE_TEXT]]);
    }
  });

  it('why: on the world before and after each tick alone, that threat is never seen', () => {
    const world = shaftWorld();
    const prev = createScenario(7, 'Normal');
    const s = createRampageCaptionState();
    const ui = new Sink();
    const loop = createGameLoop(shaftTick, world, {
      onBeforeTick: (w) => {
        noteRampageThreat(s, w, P, null);
        copyWorldState(w, prev);
      },
    });
    for (let f = 0; f < 3; f++) frame(loop, world, s, ui, MS_PER_TICK);
    expect(ui.shown).toEqual([]);
  });

  it('reads the tick between only when prev is the world one tick earlier', () => {
    const world = shaftWorld();
    const prev = createScenario(7, 'Normal');
    copyWorldState(world, prev); // the spider at its lair, by the closed door
    shaftTick(world, []); // the door opens; the spider walks off
    expect(rampageThreatenedViewerLastTick(prev, world, P)).toBe(true);
    expect(rampageThreatenedViewerLastTick(prev, world, E)).toBe(false); // not its door
    // A new round or a loaded save copies the world at its own tick: not a tick
    // earlier, so not read.
    for (const tick of [world.tick, world.tick - 2]) {
      setTick(prev, tick);
      expect(rampageThreatenedViewerLastTick(prev, world, P)).toBe(false);
    }
    // Nor while the spider then was not on a rampage (fed).
    setTick(prev, world.tick - 1);
    prev.spider!.hungerTicks = 0;
    expect(rampageThreatenedViewerLastTick(prev, world, P)).toBe(false);
  });

  it('GameScene runs it as the game loop’s onBeforeTick, with its own caption, queen-danger, enemy-queen-wound, counter-attack and stores-filling state', () => {
    // Source-text check (as ai-controller.test.ts does for CLNY-08): no unit test
    // boots the Phaser scene, and no e2e can force a one-tick threat inside a
    // multi-tick frame.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'game-scene.ts'), 'utf8');
    expect(src).toMatch(
      // Jev opponent beta: an optional trailing argument, the per-colony dispatcher
      // that routes a Jev-driven seat to its own controller, may follow main's five.
      /onBeforeTick:\s*\(w\)\s*=>\s*beforeSimTick\(\s*w,\s*this\.aiColonyIds,\s*PLAYER_COLONY_ID,\s*this\.prevState,\s*\{\s*rampage:\s*this\.rampageCaption,\s*queenDanger:\s*this\.queenDanger,\s*enemyQueenWound:\s*this\.enemyQueenWound,\s*counterAttack:\s*this\.counterAttackCaption,\s*storesFilling:\s*this\.storesFilling,\s*armyWarning:\s*this\.armyWarning,\s*storageHint:\s*this\.storageHint,?\s*\}\s*(?:,|\))/,
    );
    // ...and the per-frame check passes the same snapshot, for the frame's last tick.
    expect(src).toMatch(
      /noteRampageThreat\(\s*this\.rampageCaption,\s*this\.world,\s*PLAYER_COLONY_ID,\s*this\.prevState,?\s*\)/,
    );
    // ...and looks for the counter-attack caption's follow-up on the frame's last tick.
    expect(src).toMatch(
      /noteCounterAttackTick\(\s*this\.counterAttackCaption,\s*this\.world,\s*PLAYER_COLONY_ID,?\s*\)/,
    );
    // ...and at the stores for the stores-filling caption, with the storage hint's clock.
    expect(src).toMatch(
      /noteStoresFillingTick\(\s*this\.storesFilling,\s*this\.world,\s*PLAYER_COLONY_ID,\s*this\.storageHint\.lastOfferedTick,\s*this\.armyWarning,?\s*\)/,
    );
  });
});
