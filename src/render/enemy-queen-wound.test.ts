// enemy-queen-wound.test.ts — #427: "Their queen is wounded!" fires once the enemy
// queen drops below half her max HP, once per wound spell, re-arming only once she has
// healed back to three quarters; decided per sim tick (so frame batching cannot change
// it), and never once the round is over.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceEnemyQueenWound,
  createEnemyQueenWoundState,
  noteEnemyQueenWoundTick,
  stepEnemyQueenWound,
  woundLevel,
  type EnemyQueenWoundState,
} from './enemy-queen-wound.js';
import { beforeSimTick } from './sim-tick-hook.js';
import { createStoresFillingCaptionState } from './stores-filling-caption.js';
import { createArmyWarningState } from './army-warning.js';
import { createStorageHintState } from './storage-hint.js';
import { createQueenDangerState } from './queen-danger.js';
import { createCounterAttackCaptionState } from './counter-attack-caption.js';
import { createRampageCaptionState } from './recurring-captions.js';
import {
  captionKeyRetries,
  checkAndTrigger,
  resetCaptions,
  triggered,
  untrigger,
} from './onboarding-captions.js';
import { admitCaption, createCaptionQueueState } from './caption-queue.js';
import { createGameLoop, MAX_CATCHUP_TICKS, MS_PER_TICK } from '../platform/game-loop.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { GameOutcome } from '../sim/game-over.js';
import { despawnAnt } from '../sim/ant-death.js';
import { Zone } from '../sim/terrain.js';
import type { WorldState } from '../sim/types.js';
import {
  COMBAT_HP_QUEEN,
  ENEMY_COLONY_ID,
  HEAL_SAFE_TICKS,
  PLAYER_COLONY_ID,
  QUEEN_HEAL_INTERVAL_TICKS,
  QUEEN_HP_HOME,
} from '../sim/constants.js';
import { stageQueenInNest } from '../sim/health-test-utils.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';

const WOUNDED = 'Their queen is wounded!';

/** One look at `hp` of `max`; returns the caption it decided, if any (and clears it). */
function look(s: EnemyQueenWoundState, hp: number, max = QUEEN_HP_HOME): string | null {
  stepEnemyQueenWound(s, hp, max);
  const c = s.captionOwed;
  s.captionOwed = null;
  return c;
}

/** Looks at each HP in turn; returns the indices that decided the caption. */
function looks(s: EnemyQueenWoundState, hps: readonly number[], max = QUEEN_HP_HOME): number[] {
  const at: number[] = [];
  hps.forEach((hp, i) => {
    if (look(s, hp, max) !== null) at.push(i);
  });
  return at;
}

function setTick(w: WorldState, t: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
  w.tick = t;
}

describe('woundLevel — below ½ of her max HP is wounded, ¾ or more is healed', () => {
  it('in her nest (max 50): 24 wounded, 25–37 between, 38 healed', () => {
    expect(QUEEN_HP_HOME).toBe(50);
    expect(woundLevel(1, 50)).toBe('wounded');
    expect(woundLevel(24, 50)).toBe('wounded');
    expect(woundLevel(25, 50)).toBe('between');
    expect(woundLevel(37, 50)).toBe('between');
    expect(woundLevel(38, 50)).toBe('healed');
    expect(woundLevel(50, 50)).toBe('healed');
  });

  it('away (max 46): 22 wounded, 23–34 between, 35 healed', () => {
    expect(COMBAT_HP_QUEEN).toBe(46);
    expect(woundLevel(22, 46)).toBe('wounded');
    expect(woundLevel(23, 46)).toBe('between');
    expect(woundLevel(34, 46)).toBe('between');
    expect(woundLevel(35, 46)).toBe('healed');
  });

  it('the lines are exact where ½ and ¾ of her max are whole HP (max 40: 19 / 20, 29 / 30)', () => {
    expect(woundLevel(19, 40)).toBe('wounded');
    expect(woundLevel(20, 40)).toBe('between'); // exactly half is not below it
    expect(woundLevel(29, 40)).toBe('between');
    expect(woundLevel(30, 40)).toBe('healed'); // exactly three quarters re-arms
  });

  it('a dead or zero-HP queen reads as wounded (the round-over guard is separate)', () => {
    expect(woundLevel(0, 50)).toBe('wounded');
  });
});

describe('stepEnemyQueenWound — once per wound spell', () => {
  beforeEach(() => resetCaptions());

  it('fires once when she first drops below half', () => {
    const s = createEnemyQueenWoundState();
    expect(look(s, 50)).toBeNull();
    expect(look(s, 30)).toBeNull();
    expect(look(s, 25)).toBeNull(); // exactly half is not below it
    expect(look(s, 24)).toBe(WOUNDED);
    expect(triggered.get('enemyQueenWounded')).toBe(true);
  });

  it('does not fire again in the same spell: more blows, a hover at the half line, a partial heal', () => {
    const s = createEnemyQueenWoundState();
    expect(looks(s, [50, 20])).toEqual([1]);
    // Hovering at the line, healing to 37 (just short of ¾) and dropping again.
    expect(looks(s, [16, 1, 24, 25, 24, 26, 24, 30, 37, 20, 37, 24, 12])).toEqual([]);
  });

  it('re-arms only once she has healed back to three quarters, then fires on the next drop', () => {
    const s = createEnemyQueenWoundState();
    expect(looks(s, [20])).toEqual([0]);
    expect(stepEnemyQueenWound(s, 37, 50)).toBe('nothing'); // between: no re-arm
    expect(triggered.get('enemyQueenWounded')).toBe(true);
    expect(stepEnemyQueenWound(s, 38, 50)).toBe('rearm');
    expect(triggered.has('enemyQueenWounded')).toBe(false);
    expect(looks(s, [38, 30, 25])).toEqual([]); // a hit that leaves her at half or above
    expect(looks(s, [24])).toEqual([0]); // a new spell
    expect(looks(s, [10, 49, 50, 49, 24])).toEqual([4]); // healed fully, wounded again
  });

  it('uses the max HP passed (her max where she stands)', () => {
    const s = createEnemyQueenWoundState();
    expect(look(s, 23, 46)).toBeNull(); // half of 46
    expect(look(s, 22, 46)).toBe(WOUNDED);
    expect(stepEnemyQueenWound(s, 35, 46)).toBe('rearm');
    expect(look(s, 24, 50)).toBe(WOUNDED);
  });

  it('a wounded queen at the first look fires (a save loaded mid-fight)', () => {
    expect(look(createEnemyQueenWoundState(), 12)).toBe(WOUNDED);
  });
});

describe('retryable in the caption queue (#395 mechanism)', () => {
  beforeEach(() => resetCaptions());

  it('its key is retryable', () => {
    expect(captionKeyRetries('enemyQueenWounded')).toBe(true);
  });

  it('dropped or evicted while she is still wounded, the next look offers it again', () => {
    const s = createEnemyQueenWoundState();
    const text = look(s, 20)!;
    expect(text).toBe(WOUNDED);
    // Waiting in the pending slot behind another caption, it is evicted by an event
    // caption that is not retryable; UIScene then un-marks its key (enqueueCaption).
    const q = createCaptionQueueState();
    admitCaption(q, { text: 'on screen', x: 0, y: 0, source: 'event' });
    const ours = {
      text,
      x: 0,
      y: 0,
      source: 'event' as const,
      captionKey: 'enemyQueenWounded' as const,
      retryable: captionKeyRetries('enemyQueenWounded'),
    };
    expect(admitCaption(q, ours).queued).toBe(ours);
    const evicted = admitCaption(q, { text: 'rally', x: 0, y: 0, source: 'event' }).evictedPending;
    expect(evicted).toBe(ours);
    untrigger(evicted!.captionKey!);
    // Still wounded: offered again, no new spell needed.
    expect(look(s, 20)).toBe(WOUNDED);
    // And once it has shown, not again.
    expect(look(s, 19)).toBeNull();
  });

  it('a caption that never showed is offered again for the rest of the spell, even once she is back to half', () => {
    const s = createEnemyQueenWoundState();
    expect(look(s, 24)).toBe(WOUNDED);
    untrigger('enemyQueenWounded'); // the queue dropped it (UIScene un-marks the key)
    // She heals back to half and above (between): still the same spell, still owed.
    expect(look(s, 25)).toBe(WOUNDED);
    expect(look(s, 30)).toBeNull(); // shown now: once
    untrigger('enemyQueenWounded'); // say it was dropped again
    expect(look(s, 37)).toBe(WOUNDED);
    // Back to ¾: the spell is over; dropped again here, it is not offered until a new spell.
    untrigger('enemyQueenWounded');
    expect(stepEnemyQueenWound(s, 38, 50)).toBe('rearm');
    expect(looks(s, [37, 30, 25])).toEqual([]);
    expect(looks(s, [24])).toEqual([0]);
  });

  it('a hit that never takes her below half starts no spell', () => {
    const s = createEnemyQueenWoundState();
    expect(looks(s, [50, 30, 25, 37, 26])).toEqual([]);
    expect(s.inSpell).toBe(false);
  });
});

describe('the look at a world: their queen, her max HP where she stands, never after the round', () => {
  beforeEach(() => resetCaptions());

  /** Both queens staged in their nests at full home HP. */
  function world(): { w: WorldState; q: number; mine: number } {
    const w = createScenario(7, 'Normal');
    const q = stageQueenInNest(w, w.colonies[ENEMY_COLONY_ID]!);
    const mine = stageQueenInNest(w, w.colonies[PLAYER_COLONY_ID]!);
    w.ants.hp[q] = QUEEN_HP_HOME;
    w.ants.hp[mine] = QUEEN_HP_HOME;
    return { w, q, mine };
  }

  it('reads the viewer’s opponent’s queen, not the viewer’s own', () => {
    const { w, q, mine } = world();
    const s = createEnemyQueenWoundState();
    w.ants.hp[mine] = 3; // the player's own queen badly hurt: not "their" queen
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull();
    w.ants.hp[q] = 24;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBe(WOUNDED);
    // Seen from the other side (CLNY-08), the player's queen is "theirs".
    resetCaptions();
    expect(advanceEnemyQueenWound(createEnemyQueenWoundState(), w, ENEMY_COLONY_ID)).toBe(WOUNDED);
  });

  it('judges her against her max HP in her nest (50): 25 is not below half, 24 is', () => {
    const { w, q } = world();
    const s = createEnemyQueenWoundState();
    w.ants.hp[q] = 25;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull();
    w.ants.hp[q] = 24;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBe(WOUNDED);
  });

  it('only in her nest, where her bar is drawn: off home ground no look raises or re-arms it', () => {
    const { w, q } = world();
    const s = createEnemyQueenWoundState();
    // On the surface (before she founds her nest; no bar is drawn there), badly hurt.
    w.ants.zone[q] = Zone.Surface;
    w.ants.hp[q] = 10;
    noteEnemyQueenWoundTick(s, w, PLAYER_COLONY_ID);
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull();
    // Home, still below half: announced now.
    w.ants.zone[q] = Zone.Underground;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBe(WOUNDED);
    // Healed to 36 at home (between); stepping off home ground lowers her max to 46,
    // where 36 would read as ¾ — but no look decides anything there: not re-armed.
    w.ants.hp[q] = 36;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull();
    w.ants.zone[q] = Zone.Surface;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull();
    expect(triggered.get('enemyQueenWounded')).toBe(true);
    // Back home and hurt again in the same spell: no second caption.
    w.ants.zone[q] = Zone.Underground;
    w.ants.hp[q] = 20;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull();
    // In another colony's grid she is away too.
    w.ants.hp[q] = 40;
    w.ants.currentGridColonyId[q] = PLAYER_COLONY_ID;
    noteEnemyQueenWoundTick(s, w, PLAYER_COLONY_ID);
    expect(triggered.get('enemyQueenWounded')).toBe(true); // 40 of 46 there: no re-arm
  });

  it('held back (a recurring caption owed): not shown, offered again by the next look', () => {
    const { w, q } = world();
    const s = createEnemyQueenWoundState();
    w.ants.hp[q] = 20;
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID, true)).toBeNull();
    expect(triggered.has('enemyQueenWounded')).toBe(false); // un-marked, not lost
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID, true)).toBeNull(); // still owed
    // The recurring caption has shown: the next frame presents it.
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBe(WOUNDED);
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID)).toBeNull(); // once
    // Held back while already shown this spell: nothing to hold.
    expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID, true)).toBeNull();
    expect(triggered.get('enemyQueenWounded')).toBe(true);
  });

  it('decides nothing once the round is over, and drops a caption still owed', () => {
    for (const dead of ['mine', 'theirs'] as const) {
      resetCaptions();
      const { w, q, mine } = world();
      const s = createEnemyQueenWoundState();
      w.ants.hp[q] = 20;
      noteEnemyQueenWoundTick(s, w, PLAYER_COLONY_ID); // decided, owed to the frame
      expect(s.captionOwed, dead).toBe(WOUNDED);
      despawnAnt(w, dead === 'mine' ? mine : q, { cause: 'starvation' });
      expect(advanceEnemyQueenWound(s, w, PLAYER_COLONY_ID), dead).toBeNull();
      expect(s.captionOwed, dead).toBeNull();
      // A look after the end decides nothing, even re-armed.
      untrigger('enemyQueenWounded');
      noteEnemyQueenWoundTick(s, w, PLAYER_COLONY_ID);
      expect(s.captionOwed, dead).toBeNull();
      expect(triggered.has('enemyQueenWounded'), dead).toBe(false);
    }
  });
});

describe('GameScene’s wiring on the real sim: the game loop, beforeSimTick, a frame step', () => {
  beforeEach(() => resetCaptions());

  /**
   * The game loop with beforeSimTick as its onBeforeTick and advanceEnemyQueenWound
   * once per render frame while the round is on (GameScene presents only while
   * Playing). The enemy queen is staged in her nest at full home HP; both colonies'
   * stores are kept full so both queens eat (and so she heals by the sim's own rules:
   * 1 HP per QUEEN_HEAL_INTERVAL_TICKS once HEAL_SAFE_TICKS pass without a blow). On
   * each sim tick in `blows` a blow of that many HP lands on her after the tick's
   * steps (fixture: as combat.ts applyDamage does — lower HP, stamp lastHitTick).
   */
  function harness() {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const player = world.colonies[PLAYER_COLONY_ID]!;
    const q = stageQueenInNest(world, enemy);
    world.ants.hp[q] = QUEEN_HP_HOME;
    const s = createEnemyQueenWoundState();
    const prev = createScenario(7, 'Normal');
    const rampage = createRampageCaptionState();
    const danger = createQueenDangerState();
    const blows = new Map<number, number>();
    const killMine = new Set<number>(); // sim ticks on which the player's queen dies
    let over: GameOutcome | null = null;
    const loop = createGameLoop(
      (w, cmds) => {
        const simTick = w.tick;
        setColonyFoodForTest(w, enemy, 2048);
        setColonyFoodForTest(w, player, 2048);
        if (killMine.has(simTick)) despawnAnt(w, player.queenEntityId, { cause: 'starvation' });
        const outcome = tick(w, cmds);
        const dmg = blows.get(simTick) ?? 0;
        if (dmg > 0) {
          w.ants.hp[q] = Math.max(1, w.ants.hp[q]! - dmg);
          w.ants.lastHitTick[q] = simTick;
        }
        return outcome;
      },
      world,
      {
        onBeforeTick: (w) =>
          beforeSimTick(w, [], PLAYER_COLONY_ID, prev, {
            rampage: rampage,
            queenDanger: danger,
            enemyQueenWound: s,
            counterAttack: createCounterAttackCaptionState(),
            storesFilling: createStoresFillingCaptionState(),
            armyWarning: createArmyWarningState(),
            storageHint: createStorageHintState(),
          }),
        onTickOutcome: (o) => {
          over = o;
        },
      },
    );
    /** world.tick at each frame step that presented the caption (the frame's end). */
    const shown: number[] = [];
    /** One render frame that runs `n` sim ticks, then GameScene's frame step. */
    const frameOf = (n: number): void => {
      loop.update(n * MS_PER_TICK);
      if (over !== null) return; // GameScene: GameOver, no frame step
      if (advanceEnemyQueenWound(s, world, PLAYER_COLONY_ID) !== null) shown.push(world.tick);
    };
    const runTo = (t: number, n = 1): void => {
      while (world.tick < t && over === null) frameOf(Math.min(n, t - world.tick));
    };
    return {
      world,
      q,
      s,
      loop,
      blows,
      killMine,
      shown,
      frameOf,
      runTo,
      over: () => over,
      hp: () => world.ants.hp[q]!,
    };
  }

  it('fires once when a blow takes her below half, not again while she stays wounded, and again after she heals to ¾', () => {
    const h = harness();
    h.blows.set(100, 30); // 50 → 20
    h.blows.set(300, 2); // more blows in the same spell
    h.blows.set(500, 4);
    h.runTo(1000, MAX_CATCHUP_TICKS);
    // Decided at the look after the blow's tick (world tick 101), inside the 5-tick
    // frame of sim ticks 100–104, and presented at that frame's end.
    expect(h.shown).toEqual([105]);
    // She heals at the sim's rate once safe: 1 HP per 40 ticks, 100 ticks after a blow.
    expect(h.hp()).toBeGreaterThan(14);
    expect(h.hp()).toBeLessThan(38);
    // Let her heal to ¾ (38): the caption re-arms; no caption on the way up.
    for (let i = 0; i < 400 && h.hp() < 38; i++) h.frameOf(MAX_CATCHUP_TICKS);
    expect(h.hp()).toBeGreaterThanOrEqual(38);
    expect(h.shown).toEqual([105]);
    expect(triggered.has('enemyQueenWounded')).toBe(false);
    // A follow-up raid that finds her mostly healed and wounds her again: announced.
    expect(h.world.tick % MAX_CATCHUP_TICKS).toBe(0);
    const t = h.world.tick + 50;
    h.blows.set(t, 20);
    h.runTo(t + 10, MAX_CATCHUP_TICKS);
    expect(h.shown).toEqual([105, t + MAX_CATCHUP_TICKS]);
    // #227: long runs of full-scenario ticks — generous timeout for the coverage gate.
  }, 30_000);

  it('a fight that leaves her hovering round the half line raises it once', () => {
    const h = harness();
    // A 3-HP blow every 200 ticks; between them she heals 3 (from 100 ticks after the
    // blow, 1 HP per 40): she hovers at 24–27, crossing the half line every cycle, for
    // over three minutes, and never reaches ¾.
    h.blows.set(100, 26); // 50 → 24
    for (let t = 300; t < 4000; t += 200) h.blows.set(t, 3);
    h.runTo(4000, 3);
    expect(h.shown).toEqual([102]); // the 3-tick frame of sim ticks 99–101
    expect(h.hp()).toBeGreaterThanOrEqual(24);
    expect(h.hp()).toBeLessThanOrEqual(27);
    // #227: generous timeout for the coverage gate.
  }, 30_000);

  it('heals at #415’s rate: from 24 HP it takes HEAL_SAFE_TICKS plus 14 heal intervals to re-arm', () => {
    const h = harness();
    h.blows.set(100, 26); // 50 → 24 on sim tick 100
    h.runTo(101);
    expect(h.hp()).toBe(24);
    for (let i = 0; i < 2000 && triggered.has('enemyQueenWounded'); i++) h.frameOf(1);
    expect(triggered.has('enemyQueenWounded')).toBe(false); // re-armed
    const rearmedAt = h.world.tick;
    expect(h.hp()).toBe(38);
    // The first heal tick at least HEAL_SAFE_TICKS after the blow, then 13 more.
    const firstHeal =
      Math.ceil((100 + HEAL_SAFE_TICKS) / QUEEN_HEAL_INTERVAL_TICKS) * QUEEN_HEAL_INTERVAL_TICKS;
    expect(rearmedAt).toBe(firstHeal + 13 * QUEEN_HEAL_INTERVAL_TICKS + 1);
    // #227: generous timeout for the coverage gate.
  }, 30_000);

  it('no caption on game over: she is wounded on the tick the round ends', () => {
    const h = harness();
    h.runTo(200);
    h.killMine.add(203); // the player's queen dies on sim tick 203: Defeat
    h.blows.set(203, 30); // and the enemy queen drops below half on the same tick
    h.frameOf(MAX_CATCHUP_TICKS); // sim ticks 200..203; the loop stops at the outcome
    expect(h.over()).toBe(GameOutcome.Defeat);
    expect(h.world.tick).toBe(204);
    expect(h.hp()).toBe(20);
    expect(h.shown).toEqual([]);
    // Even if a frame step ran now, it presents nothing.
    expect(advanceEnemyQueenWound(h.s, h.world, PLAYER_COLONY_ID)).toBeNull();
    // #227: generous timeout for the coverage gate.
  }, 30_000);

  it('no caption on game over: decided on the round’s last tick but one, inside the same frame', () => {
    const h = harness();
    h.runTo(200);
    h.blows.set(201, 30); // wounded on sim tick 201: decided at the look before 202
    h.killMine.add(203); // the round ends on sim tick 203, in the same 5-tick frame
    h.frameOf(MAX_CATCHUP_TICKS);
    expect(h.over()).toBe(GameOutcome.Defeat);
    expect(h.s.captionOwed).toBe(WOUNDED); // decided before the end…
    expect(h.shown).toEqual([]); // …never presented
    expect(advanceEnemyQueenWound(h.s, h.world, PLAYER_COLONY_ID)).toBeNull();
    expect(h.s.captionOwed).toBeNull();
    // #227: generous timeout for the coverage gate.
  }, 30_000);

  it('no caption while paused: no sim tick runs, so no look decides anything', () => {
    const h = harness();
    h.runTo(150);
    h.loop.pause();
    for (let i = 0; i < 20; i++) h.loop.update(MAX_CATCHUP_TICKS * MS_PER_TICK);
    expect(h.world.tick).toBe(150);
    expect(h.s.captionOwed).toBeNull();
    // Resumed: the blow lands on the next tick and is announced at the look after it.
    h.loop.resume();
    h.blows.set(150, 30);
    h.frameOf(2);
    expect(h.shown).toEqual([152]);
    // #227: generous timeout for the coverage gate.
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Batching invariance: the property test (as queen-danger.test.ts's for #418).
//
// One LOOK per sim tick's end state (beforeSimTick's before each tick, the frame
// step's after the frame's last), each deciding as of its own tick:
//
//   at the look                      | the look decides
//   ---------------------------------+---------------------------------------------
//   wounded (hp < 25), armed         | the caption; disarmed
//   wounded, disarmed                | nothing
//   between (25 ≤ hp < 38)           | nothing
//   healed (hp ≥ 38)                 | re-arm
//   any: a second look, same state   | nothing (idempotent)
//
// So, for any HP sequence and any batching, a frame presents the caption iff the
// per-tick model (`oracle`, written independently with the literal thresholds of a
// 50-HP queen) decided it at a tick in (the frame's first tick, its last tick]. The
// scripts flip her across both lines for a tick or two at a time, so a rule decided
// once per frame (on the frame's last tick only) would miss spells inside a frame.
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Her HP after each sim tick: episodes of fights, heals, hovers and one-tick flips. */
function randomScript(seed: number, n: number): number[] {
  const r = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const out: number[] = [];
  let hp = QUEEN_HP_HOME;
  const push = (v: number): void => {
    hp = Math.max(1, Math.min(QUEEN_HP_HOME, v));
    if (out.length < n) out.push(hp);
  };
  while (out.length < n) {
    const k = r();
    if (k < 0.2) {
      // A fight: blows of 1–5 HP on some ticks.
      const len = int(5, 80);
      for (let i = 0; i < len; i++) push(r() < 0.3 ? hp - int(1, 5) : hp);
    } else if (k < 0.35) {
      // Healing at the sim's rate, for a while.
      const len = int(40, 400);
      for (let i = 0; i < len; i++) push(i % QUEEN_HEAL_INTERVAL_TICKS === 0 ? hp + 1 : hp);
    } else if (k < 0.5) {
      // Flips across the half line for a tick or two at a time.
      const len = int(4, 40);
      for (let i = 0; i < len; i++) push(r() < 0.5 ? int(23, 24) : int(25, 26));
    } else if (k < 0.75) {
      // Flips across the ¾ line, then (often) a drop below half within a few ticks.
      const len = int(1, 12);
      for (let i = 0; i < len; i++) push(r() < 0.5 ? 37 : 38);
      if (r() < 0.7) for (let i = 0, d = int(1, 4); i < d; i++) push(int(15, 24));
    } else if (k < 0.9) {
      // One heavy blow, or a full heal.
      push(r() < 0.5 ? hp - int(10, 30) : QUEEN_HP_HOME);
    } else {
      // Calm.
      for (let i = 0, len = int(1, 120); i < len; i++) push(hp);
    }
  }
  return out;
}

/** The per-tick model: the world ticks at which the caption is decided. Sim tick t's
 *  end state is looked at on world tick t + 1; the look before tick 0 sees full HP. */
function oracle(script: readonly number[]): Set<number> {
  const captions = new Set<number>();
  let armed = true;
  for (let t = 0; t < script.length; t++) {
    const hp = script[t]!;
    if (hp < 25) {
      if (armed) captions.add(t + 1);
      armed = false;
    } else if (hp >= 38) {
      armed = true;
    }
  }
  return captions;
}

/** Frame sizes (sim ticks per render frame, 0..MAX_CATCHUP_TICKS) by frame index. */
type Batching = { readonly name: string; readonly size: (frame: number) => number };

function batchings(seed: number): Batching[] {
  const out: Batching[] = [{ name: '1', size: () => 1 }];
  for (const n of [2, 3, MAX_CATCHUP_TICKS]) {
    for (let off = 0; off < n; off++) {
      out.push({ name: `${n}+${off}`, size: (i) => (i === 0 && off > 0 ? off : n) });
    }
  }
  const cycle = (name: string, sizes: readonly number[]): Batching => ({
    name,
    size: (i) => sizes[i % sizes.length]!,
  });
  out.push(cycle('irregular A', [1, 5, 2, 0, 4, 3, 5, 0, 1, 1, 5, 2]));
  const r = prng(seed ^ 0x9e3779b9);
  const sizes = Array.from({ length: 97 }, () => Math.floor(r() * (MAX_CATCHUP_TICKS + 1)));
  sizes[0] = 1;
  out.push(cycle('random', sizes));
  return out;
}

describe('batching invariance: every frame presents what the per-tick model decided', () => {
  const world = createScenario(7, 'Normal');
  const q = stageQueenInNest(world, world.colonies[ENEMY_COLONY_ID]!);
  const prev = createScenario(7, 'Normal');

  /**
   * Play `script` (her HP after each sim tick) through GameScene's wiring — the game
   * loop, `hook` as its onBeforeTick, advanceEnemyQueenWound once per render frame —
   * with `batching`'s frame sizes; return the frames that disagree with the oracle.
   * `hook` 'beforeSimTick' is GameScene's own; 'note' calls the tracker's per-tick look
   * alone (the same look, without the world copy the interpolation snapshot costs).
   */
  function mismatches(
    script: readonly number[],
    batching: Batching,
    hook: 'beforeSimTick' | 'note',
  ): string[] {
    resetCaptions();
    setTick(world, 0);
    world.ants.hp[q] = QUEEN_HP_HOME;
    const s = createEnemyQueenWoundState();
    const rampage = createRampageCaptionState();
    const danger = createQueenDangerState();
    const loop = createGameLoop(
      (w) => {
        w.ants.hp[q] = script[w.tick]!;
        setTick(w, w.tick + 1);
        return GameOutcome.None;
      },
      world,
      {
        onBeforeTick:
          hook === 'beforeSimTick'
            ? (w) =>
                beforeSimTick(w, [], PLAYER_COLONY_ID, prev, {
                  rampage: rampage,
                  queenDanger: danger,
                  enemyQueenWound: s,
                  counterAttack: createCounterAttackCaptionState(),
                  storesFilling: createStoresFillingCaptionState(),
                  armyWarning: createArmyWarningState(),
                  storageHint: createStorageHintState(),
                })
            : (w) => noteEnemyQueenWoundTick(s, w, PLAYER_COLONY_ID),
      },
    );
    const want = oracle(script);
    const bad: string[] = [];
    for (let i = 0; world.tick < script.length; i++) {
      const from = world.tick;
      loop.update(Math.min(batching.size(i), script.length - from) * MS_PER_TICK);
      const to = world.tick;
      const got = advanceEnemyQueenWound(s, world, PLAYER_COLONY_ID) !== null;
      let expected = false;
      for (let t = from + 1; t <= to; t++) if (want.has(t)) expected = true;
      if (got !== expected) bad.push(`[${batching.name}] frame ${from}..${to}: ${got}/${expected}`);
    }
    return bad.slice(0, 5);
  }

  const SEEDS = [3, 17, 29, 43, 71, 89];
  it.each(SEEDS)('random script, seed %i', (seed) => {
    const script = randomScript(seed, 4000);
    expect(oracle(script).size).toBeGreaterThanOrEqual(8); // re-arms are exercised
    for (const b of batchings(seed)) expect(mismatches(script, b, 'note')).toEqual([]);
  });

  it('the random scripts include spells that start and end within one frame’s ticks', () => {
    // A caption decided, then re-armed, within MAX_CATCHUP_TICKS ticks: a rule that
    // looked only at each frame's last tick would miss it.
    let short = 0;
    for (const seed of SEEDS) {
      const script = randomScript(seed, 4000);
      for (const T of oracle(script)) {
        for (let t = T; t < Math.min(script.length, T + MAX_CATCHUP_TICKS - 1); t++) {
          if (script[t]! >= 38) {
            short += 1;
            break;
          }
        }
      }
    }
    expect(short).toBeGreaterThan(5);
  });

  it('a spell that starts and ends inside one frame still presents the caption', () => {
    // Below half on one sim tick, healed past ¾ the next (a scripted flip): only a
    // look at that tick's own end state can see it inside a 5-tick frame.
    const script = [50, 50, 20, 40, 40, 40, 40, 40, 40, 40];
    expect([...oracle(script)]).toEqual([3]);
    for (const b of batchings(1)) expect(mismatches(script, b, 'beforeSimTick')).toEqual([]);
  });

  it('through beforeSimTick (GameScene’s own wiring), on a random script', () => {
    const script = randomScript(5, 1500);
    expect(oracle(script).size).toBeGreaterThanOrEqual(3);
    for (const b of batchings(5)) expect(mismatches(script, b, 'beforeSimTick')).toEqual([]);
    // #227: generous timeout for the coverage gate (a world copy per tick).
  }, 60_000);
});

describe('GameScene presents it only from the Playing-only frame step', () => {
  // Source-text check (as sim-tick-hook.test.ts does for the per-tick wiring): no
  // unit test boots the Phaser scene. GameScene presents the caption from
  // checkQueenStatusForEffects, which update() runs only while Playing — never
  // Paused (any pause reason) or GameOver.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'game-scene.ts'), 'utf8');

  it('one presentation call, inside checkQueenStatusForEffects, with the retryable key', () => {
    expect(src.match(/advanceEnemyQueenWound\(/g)).toHaveLength(1);
    const start = src.indexOf('private checkQueenStatusForEffects(): void {');
    const end = src.indexOf('\n  private ', start + 1);
    const body = src.slice(start, end);
    expect(body).toMatch(
      /advanceEnemyQueenWound\(\s*this\.enemyQueenWound,\s*this\.world,\s*PLAYER_COLONY_ID,\s*recurringOwed \|\| uiScene === null,?\s*\)/,
    );
    expect(body).toMatch(/showCaption\(woundCaption,[^)]*'enemyQueenWounded'\)/);
  });

  it('gives way to an owed recurring caption, as the storage hint does: after them, held back, withdrawn', () => {
    const start = src.indexOf('private checkQueenStatusForEffects(): void {');
    const body = src.slice(start, src.indexOf('\n  private ', start + 1));
    // Presented after the recurring captions are offered and `recurringOwed` is known.
    const owed = body.indexOf('const recurringOwed =');
    expect(owed).toBeGreaterThan(-1);
    expect(body.indexOf('advanceEnemyQueenWound(')).toBeGreaterThan(owed);
    expect(body.indexOf('advanceEnemyQueenWound(')).toBeGreaterThan(
      body.indexOf('offerOwedRampageCaption('),
    );
    // A wound caption waiting in the pending slot is withdrawn while one is owed.
    expect(body).toMatch(
      /if \(recurringOwed && uiScene\?\.pendingCaptionKey\?\.\(\) === 'enemyQueenWounded'\) \{\s*uiScene\.withdrawPendingCaption\?\.\('enemyQueenWounded'\);/,
    );
  });

  it('checkQueenStatusForEffects runs only while Playing', () => {
    expect(src.match(/this\.checkQueenStatusForEffects\(\)/g)).toHaveLength(1);
    expect(src).toMatch(
      /if \(this\.gamePhase === GamePhase\.Playing\) \{\s*this\.consumeEventsForRender\(\);\s*this\.checkQueenStatusForEffects\(\);/,
    );
  });

  it('a new session starts the tracker afresh', () => {
    const start = src.indexOf('private resetSessionState(): void {');
    const body = src.slice(start, src.indexOf('\n  private ', start + 1));
    expect(body).toMatch(/this\.enemyQueenWound = createEnemyQueenWoundState\(\);/);
    expect(body).toMatch(/resetCaptions\(\);/);
  });
});

// The caption text comes from the one-shot registry.
it('the caption reads "Their queen is wounded!"', () => {
  resetCaptions();
  expect(checkAndTrigger('enemyQueenWounded')).toBe(WOUNDED);
});
