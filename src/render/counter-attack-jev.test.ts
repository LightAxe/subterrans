// counter-attack-jev.test.ts — Jev opponent beta (playtest 5, #436): the counter-attack
// caption against a colony that attacks with rallies (the Jev-driven seat) instead of
// AI invasions. Its assault ends when its rally leaves the player's entrance; the
// caption is owed then if its whole army is broken, with the rout path's cooldown,
// copy and army gate; and "attacks again" (which lapses the follow-up) is its rally
// back on the player's entrance, not the AI state machine it leaves running.

import { describe, it, expect } from 'vitest';
import {
  COUNTER_ATTACK_BUILD_UP_TEXT,
  COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS,
  COUNTER_ATTACK_CAPTION_TEXT,
  COUNTER_ATTACK_READY_FIGHTERS,
  counterAttackCaptionOwed,
  createCounterAttackCaptionState,
  noteCounterAttackTick,
  offerCounterAttackCaption,
  setRallyAttackers,
  type CounterAttackCaptionState,
} from './counter-attack-caption.js';
import type { RecurringCaptionSink } from './recurring-captions.js';
import type { WorldState } from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { createDefaultAIStateRecord, getAIStateForColony } from '../sim/ai-state.js';
import { addFighter } from '../sim/raid-test-utils.js';
import { RaidType } from '../sim/enums.js';
import {
  AI_INVADING_FIGHTER_THRESHOLD,
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
} from '../sim/constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
const NORMAL_NEED = AI_INVADING_FIGHTER_THRESHOLD[1];

/** Records what it was shown; the queue is always idle. */
class IdleUi implements RecurringCaptionSink {
  readonly shown: string[] = [];
  showCaption(text: string): boolean {
    this.shown.push(text);
    return true;
  }
  captionQueueIdle(): boolean {
    return true;
  }
}

function setTick(w: WorldState, t: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
  w.tick = t;
}

/** A Normal match at tick 2000 with `playerFighters` player fighters and `enemyFighters`
 *  enemy fighters (the enemy starts with none on the Fighting task). */
function world(playerFighters = COUNTER_ATTACK_READY_FIGHTERS, enemyFighters = 4): WorldState {
  const w = createScenario(7, 'Normal');
  setTick(w, 2000);
  for (let i = 0; i < playerFighters; i++) addFighter(w, P, 10, 10, null);
  for (let i = 0; i < enemyFighters; i++) addFighter(w, E, 20, 10, null);
  return w;
}

/** The enemy's rally on the player's first entrance (an assault), with `raidType`. */
function rallyOnPlayerDoor(w: WorldState, raidType: RaidType = RaidType.Assault): void {
  const door = w.colonies[P]!.entrances[0]!;
  const enemy = w.colonies[E]!;
  enemy.rallyPoint = { tileX: door.surfaceTileX, tileY: door.surfaceTileY };
  enemy.raidType = raidType;
}

/** The enemy's rally on its own entrance (Jev's guard_home / the muster). */
function rallyHome(w: WorldState): void {
  const door = w.colonies[E]!.entrances[0]!;
  w.colonies[E]!.rallyPoint = { tileX: door.surfaceTileX, tileY: door.surfaceTileY };
  w.colonies[E]!.raidType = RaidType.Loot;
}

/** One per-tick look at tick `t` (what beforeSimTick does). */
function lookAt(s: CounterAttackCaptionState, w: WorldState, t: number): void {
  setTick(w, t);
  noteCounterAttackTick(s, w, P);
}

function jevState(): CounterAttackCaptionState {
  const s = createCounterAttackCaptionState();
  setRallyAttackers(s, [E]);
  return s;
}

describe('Jev opponent: an assault by rally owes the counter-attack caption when it ends', () => {
  it('the rally leaves the player door with its army broken: owed as of that tick, and shown', () => {
    const w = world();
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    expect(counterAttackCaptionOwed(s)).toBe(false); // under way: nothing yet
    w.colonies[E]!.rallyPoint = null; // recalled
    lookAt(s, w, 2100);
    expect(s.owedRoutTick).toBe(2100);
    expect(s.owedAttackerId).toBe(E);
    const ui = new IdleUi();
    expect(offerCounterAttackCaption(s, w, P, ui, 400, 60)).toBe(true);
    // 12 player fighters against 4: the army gate passes, the Assault copy.
    expect(ui.shown).toEqual([COUNTER_ATTACK_CAPTION_TEXT]);
  });

  it('a rally moved off their door to its own entrance (called home) also ends it', () => {
    const w = world();
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    rallyHome(w);
    lookAt(s, w, 2050);
    expect(s.owedRoutTick).toBe(2050);
  });

  it('whatever the raid type, a rally on the player door is an assault', () => {
    const w = world();
    const s = jevState();
    rallyOnPlayerDoor(w, RaidType.Loot);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    expect(counterAttackCaptionOwed(s)).toBe(true);
  });

  it('its army not broken (at or above the base need) when the rally leaves: nothing owed', () => {
    const w = world(COUNTER_ATTACK_READY_FIGHTERS, NORMAL_NEED);
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    // One fewer fighter would have been broken.
    const w2 = world(COUNTER_ATTACK_READY_FIGHTERS, NORMAL_NEED - 1);
    const s2 = jevState();
    rallyOnPlayerDoor(w2);
    lookAt(s2, w2, 2000);
    w2.colonies[E]!.rallyPoint = null;
    lookAt(s2, w2, 2001);
    expect(counterAttackCaptionOwed(s2)).toBe(true);
  });

  it('the player army not ready: the build-up copy, then the Assault copy once it is', () => {
    const w = world(6, 4);
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    const ui = new IdleUi();
    expect(offerCounterAttackCaption(s, w, P, ui, 400, 60)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT]);
    for (let i = 0; i < 6; i++) addFighter(w, P, 10, 10, null);
    lookAt(s, w, 2200);
    expect(s.owedFollowUp).toBe(true);
    expect(offerCounterAttackCaption(s, w, P, ui, 400, 60)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT, COUNTER_ATTACK_CAPTION_TEXT]);
  });

  it('looking twice at the same world owes it once (frame step, then the next beforeSimTick)', () => {
    const w = world();
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    const ui = new IdleUi();
    expect(offerCounterAttackCaption(s, w, P, ui, 400, 60)).toBe(true);
    lookAt(s, w, 2001);
    expect(counterAttackCaptionOwed(s)).toBe(false);
  });

  it('the rout cooldown applies between two assaults', () => {
    const w = world();
    const s = jevState();
    const ui = new IdleUi();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    expect(offerCounterAttackCaption(s, w, P, ui, 400, 60)).toBe(true);
    // A second assault ends inside the cooldown: nothing.
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2100);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001 + COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS - 1);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    // A third, ending at the cooldown: owed again.
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2001 + COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001 + COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS);
    expect(counterAttackCaptionOwed(s)).toBe(true);
  });

  it('a rally already on the player door when watching starts (a loaded save) ends like any other', () => {
    const w = world();
    rallyOnPlayerDoor(w);
    const s = jevState(); // a fresh round's state: nothing seen yet
    lookAt(s, w, 2000);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    expect(counterAttackCaptionOwed(s)).toBe(true);
  });

  it('a colony that is not a rally attacker (the rules AI) owes nothing for its rally', () => {
    const w = world();
    const s = createCounterAttackCaptionState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    expect(counterAttackCaptionOwed(s)).toBe(false);
  });

  it('a seat that falls back mid-assault is forgotten: its rally ending owes nothing', () => {
    const w = world();
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    setRallyAttackers(s, []);
    expect(s.rallyOnViewer).toEqual([]);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    expect(counterAttackCaptionOwed(s)).toBe(false);
  });
});

describe("Jev opponent: the follow-up lapses on Jev's rally, not on the AI state it leaves running", () => {
  /** A build-up caption shown for a Jev assault that ended at 2001. */
  function afterBuildUp(): { w: WorldState; s: CounterAttackCaptionState; ui: IdleUi } {
    const w = world(6, 4);
    const s = jevState();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2000);
    w.colonies[E]!.rallyPoint = null;
    lookAt(s, w, 2001);
    const ui = new IdleUi();
    offerCounterAttackCaption(s, w, P, ui, 400, 60);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT]);
    return { w, s, ui };
  }

  function ghostInvading(w: WorldState): void {
    let rec = getAIStateForColony(w, E);
    if (rec === null) {
      rec = createDefaultAIStateRecord(E);
      w.aiState.push(rec);
    }
    rec.state = 'Invading';
  }

  it('the ghost AI state reading Invading does not lapse it', () => {
    const { w, s, ui } = afterBuildUp();
    ghostInvading(w);
    for (let i = 0; i < 6; i++) addFighter(w, P, 10, 10, null);
    lookAt(s, w, 2300);
    expect(s.owedFollowUp).toBe(true);
    expect(offerCounterAttackCaption(s, w, P, ui, 400, 60)).toBe(true);
    expect(ui.shown.at(-1)).toBe(COUNTER_ATTACK_CAPTION_TEXT);
  });

  it("Jev's rally back on the player door lapses a pending follow-up", () => {
    const { w, s } = afterBuildUp();
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2300);
    for (let i = 0; i < 6; i++) addFighter(w, P, 10, 10, null);
    lookAt(s, w, 2301);
    expect(s.buildUpTick).toBeNull();
    expect(counterAttackCaptionOwed(s)).toBe(false);
  });

  it('…and an owed one the busy queue has not taken yet', () => {
    const { w, s } = afterBuildUp();
    for (let i = 0; i < 6; i++) addFighter(w, P, 10, 10, null);
    lookAt(s, w, 2300);
    expect(s.owedFollowUp).toBe(true);
    rallyOnPlayerDoor(w);
    lookAt(s, w, 2301);
    expect(counterAttackCaptionOwed(s)).toBe(false);
  });
});
