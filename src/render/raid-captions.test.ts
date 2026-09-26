// raid-captions.test.ts — #290 PR 6: raid captions from the colony raid counters,
// and the rally-on-an-enemy-entrance test behind the 'rallyRaid' caption.

import { describe, it, expect } from 'vitest';
import {
  RAID_CAPTION_COOLDOWN_TICKS,
  RAID_CAPTION_OWED_TICKS,
  RAID_CAPTION_TEXTS,
  createRaidCaptionState,
  markRaidCaptionShown,
  nextRaidCaption,
  rallyTargetsEnemyEntrance,
  resetRaidCaptionState,
} from './raid-captions.js';
import { tick } from '../sim/tick.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { SIM_VERSION_V51_UNIFIED_HUNGER, type WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { addFighter, raidWorld, rallyOn } from '../sim/raid-test-utils.js';
import { setChamberStockForTest } from '../sim/food/food-test-utils.js';

const P = PLAYER_COLONY_ID as ColonyId;

/** nextRaidCaption, then (as GameScene does once the queue takes it) mark it shown. */
function take(
  s: ReturnType<typeof createRaidCaptionState>,
  w: WorldState,
  colonyId: ColonyId = P,
): ReturnType<typeof nextRaidCaption> {
  const k = nextRaidCaption(s, w, colonyId);
  if (k !== null) markRaidCaptionShown(s, w, k);
  return k;
}

/** Move the test world's clock on by `n` ticks (the captions key their throttles
 *  on world.tick; these fixtures step it without running the sim). */
function advance(w: WorldState, n: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock, not a render write
  w.tick += n;
}

/** A world whose player counters the test drives directly. */
function counterWorld(): WorldState {
  return raidWorld(0).world;
}

describe('nextRaidCaption — counters to captions', () => {
  it('stays quiet while no counter moves', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    expect(take(s, w)).toBeNull();
  });

  it('food lost to raiders → the "being raided" caption', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    w.colonies[P]!.foodLostToRaidsFp += 1024;
    expect(take(s, w)).toBe('raided');
    expect(RAID_CAPTION_TEXTS.raided).toMatch(/stealing from your larder/);
  });

  it('a load taken by the player → "raiding"; a haul deposited → "hauled"', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    w.colonies[P]!.foodRaidedFp += 1024;
    expect(take(s, w)).toBe('looting');
    w.colonies[P]!.raidTrips += 1;
    expect(take(s, w)).toBe('hauled');
  });

  it('each caption is throttled for RAID_CAPTION_COOLDOWN_TICKS; a rise inside it is absorbed', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    const c = w.colonies[P]!;
    c.foodLostToRaidsFp += 1024;
    expect(take(s, w)).toBe('raided');
    advance(w, RAID_CAPTION_COOLDOWN_TICKS - 1);
    c.foodLostToRaidsFp += 1024;
    expect(take(s, w)).toBeNull();
    // Cooldown over, but the earlier rise was absorbed: nothing new → nothing shown.
    advance(w, 1);
    expect(take(s, w)).toBeNull();
    c.foodLostToRaidsFp += 1024;
    expect(take(s, w)).toBe('raided');
  });

  it('throttles are per caption: being raided does not silence your own raid news', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    const c = w.colonies[P]!;
    c.foodLostToRaidsFp += 1024;
    expect(take(s, w)).toBe('raided');
    advance(w, 1);
    c.foodRaidedFp += 1024;
    expect(take(s, w)).toBe('looting');
  });

  it('being raided outranks the player’s own raid news in the same frame', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    const c = w.colonies[P]!;
    c.foodLostToRaidsFp += 1024;
    c.foodRaidedFp += 1024;
    expect(take(s, w)).toBe('raided');
  });

  it('a falling counter (a dead hauler handing its load back) only moves the baseline', () => {
    const w = counterWorld();
    const c = w.colonies[P]!;
    c.foodRaidedFp = 2048;
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    c.foodRaidedFp = 1024;
    expect(take(s, w)).toBeNull();
    c.foodRaidedFp = 1536; // back up, but from the lowered baseline: a real rise
    expect(take(s, w)).toBe('looting');
  });

  it('reset baselines on the current counters, so a loaded save’s past raids stay quiet', () => {
    const w = counterWorld();
    const c = w.colonies[P]!;
    c.foodLostToRaidsFp = 9000;
    c.foodRaidedFp = 7000;
    c.raidTrips = 5;
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    expect(take(s, w)).toBeNull();
  });

  it('a caption the queue dropped (never marked shown) is retried until taken', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    w.colonies[P]!.foodRaidedFp += 1024;
    expect(nextRaidCaption(s, w, P)).toBe('looting'); // dropped: not marked
    advance(w, 1);
    expect(nextRaidCaption(s, w, P)).toBe('looting'); // still owed, no new rise needed
    markRaidCaptionShown(s, w, 'looting');
    advance(w, 1);
    expect(nextRaidCaption(s, w, P)).toBeNull();
  });

  it('an owed caption goes stale after RAID_CAPTION_OWED_TICKS', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    w.colonies[P]!.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s, w, P)).toBe('raided');
    advance(w, RAID_CAPTION_OWED_TICKS);
    expect(nextRaidCaption(s, w, P)).toBe('raided');
    advance(w, 1);
    expect(nextRaidCaption(s, w, P)).toBeNull();
  });

  it('an owed caption does not block a lower-priority one that the queue then takes', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, P);
    const c = w.colonies[P]!;
    c.foodLostToRaidsFp += 1024;
    c.foodRaidedFp += 1024;
    expect(take(s, w)).toBe('raided');
    expect(take(s, w)).toBe('looting');
    expect(take(s, w)).toBeNull();
  });

  it('a missing colony yields nothing', () => {
    const w = counterWorld();
    const s = createRaidCaptionState();
    expect(take(s, w, 99 as ColonyId)).toBeNull();
  });
});

describe('nextRaidCaption — driven by a real V52 raid', () => {
  it('the player’s fighters loot the enemy larder → "raiding", then haul home → "hauled"', () => {
    const r = raidWorld(6000);
    rallyOn(r.player, r.enemyDoor);
    // Two player fighters already inside the enemy nest, beside its larder (x 86..89, row 6).
    addFighter(r.world, PLAYER_COLONY_ID, 90, 6, ENEMY_COLONY_ID);
    addFighter(r.world, PLAYER_COLONY_ID, 91, 6, ENEMY_COLONY_ID);
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, r.world, P);
    const seen: string[] = [];
    for (let t = 0; t < 3000 && seen.length < 2; t++) {
      tick(r.world, []);
      const k = take(s, r.world);
      if (k !== null) seen.push(k);
    }
    expect(seen).toEqual(['looting', 'hauled']);
  });

  it('enemy raiders in the player’s larder → "being raided"', () => {
    const r = raidWorld(0);
    setChamberStockForTest(r.world, r.player, r.playerLarder, 6000);
    rallyOn(r.enemy, r.playerDoor);
    // An enemy fighter inside the player's nest, in the tunnel beside its larder
    // (x 35..38; the row-6 tunnel runs x 10..38, the queen at 10..14).
    addFighter(r.world, ENEMY_COLONY_ID, 33, 6, PLAYER_COLONY_ID);
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, r.world, P);
    let first: string | null = null;
    for (let t = 0; t < 600 && first === null; t++) {
      tick(r.world, []);
      first = take(s, r.world);
    }
    expect(first).toBe('raided');
    expect(r.world.colonies[P]!.foodLostToRaidsFp).toBeGreaterThan(0);
  });
});

describe('rallyTargetsEnemyEntrance', () => {
  it("is true on an enemy's open entrance in a V52 world", () => {
    const r = raidWorld();
    expect(rallyTargetsEnemyEntrance(r.world, P, r.enemyDoor.x, r.enemyDoor.y)).toBe(true);
  });

  it("is false on the colony's own entrance or an empty tile", () => {
    const r = raidWorld();
    expect(rallyTargetsEnemyEntrance(r.world, P, r.playerDoor.x, r.playerDoor.y)).toBe(false);
    expect(rallyTargetsEnemyEntrance(r.world, P, r.enemyDoor.x + 3, r.enemyDoor.y)).toBe(false);
  });

  it('is false on a closed enemy entrance', () => {
    const r = raidWorld();
    for (const e of r.enemy.entrances) e.isOpen = false;
    expect(rallyTargetsEnemyEntrance(r.world, P, r.enemyDoor.x, r.enemyDoor.y)).toBe(false);
  });

  it('is false before V52 (no raids in that world)', () => {
    const r = raidWorld();
    r.world.simVersion = SIM_VERSION_V51_UNIFIED_HUNGER;
    expect(rallyTargetsEnemyEntrance(r.world, P, r.enemyDoor.x, r.enemyDoor.y)).toBe(false);
  });
});
