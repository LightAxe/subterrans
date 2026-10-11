// blockade-caption.test.ts — #366: "Your entrance is blockaded. …" shows once per match,
// when an enemy Blockade ring (at least three of its Fighting ants on the surface within
// BLOCKADE_RADIUS_TILES of the entrance) stands on one of the player's open entrances;
// not for a Loot or Assault rally, a thin ring, or a Blockade of another colony; held
// back while the player's rally is already just outside the door, and shown once it
// moves away; re-armed by a reset.

import { describe, it, expect } from 'vitest';
import {
  BLOCKADE_CAPTION_HOLD_MS,
  BLOCKADE_CAPTION_MIN_FIGHTERS,
  BLOCKADE_CAPTION_TEXT,
  blockadeCaptionCondition,
  createBlockadeCaptionState,
  offerBlockadeCaption,
  resetBlockadeCaptionState,
} from './blockade-caption.js';
import {
  admitCaption,
  completeCaption,
  createCaptionQueueState,
  recurringCaptionMayEnter,
  type CaptionQueueState,
} from './caption-queue.js';
import type { CaptionKey } from './onboarding-captions.js';
import type { RecurringCaptionSink } from './recurring-captions.js';
import { AntTask, RaidType } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';
import { despawnAnt } from '../sim/ant-death.js';
import { addFighter, raidWorld, rallyOn, type RaidWorld } from '../sim/raid-test-utils.js';
import { BLOCKADE_RADIUS_TILES, ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';

/** A stand-in for UIScene over the real caption queue (as in counter-attack-caption.test). */
class FakeUi implements RecurringCaptionSink {
  readonly q: CaptionQueueState = createCaptionQueueState();
  readonly begun: { text: string; holdMs: number | undefined }[] = [];
  showCaption(
    text: string,
    _x: number,
    _y: number,
    captionKey?: CaptionKey,
    holdMs?: number,
  ): boolean {
    const r = admitCaption(this.q, {
      text,
      x: 0,
      y: 0,
      source: 'event',
      captionKey,
      ...(holdMs === undefined ? {} : { holdMs }),
    });
    if (r.begin) this.begun.push({ text: r.begin.text, holdMs: r.begin.holdMs });
    return r.dropped === undefined;
  }
  captionQueueIdle(): boolean {
    return recurringCaptionMayEnter(this.q);
  }
  finish(): void {
    const r = completeCaption(this.q);
    if (r.begin) this.begun.push({ text: r.begin.text, holdMs: r.begin.holdMs });
  }
  shown(): string[] {
    return this.begun.map((b) => b.text);
  }
}

/** The enemy rallies on the player's door with `type`, with `n` fighters at the door. */
function ringWorld(type: RaidType = RaidType.Blockade, n = BLOCKADE_CAPTION_MIN_FIGHTERS) {
  const r = raidWorld();
  r.enemy.raidType = type;
  rallyOn(r.enemy, r.playerDoor);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(addFighter(r.world, ENEMY_COLONY_ID, r.playerDoor.x + 1 + i, r.playerDoor.y, null));
  }
  return { r, ids };
}

function offer(r: RaidWorld, state = createBlockadeCaptionState(), ui = new FakeUi()) {
  return { state, ui, shown: offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0) };
}

describe('blockade caption', () => {
  it('shows once when the ring forms, with the exact text and hold; never again', () => {
    const { r } = ringWorld();
    const state = createBlockadeCaptionState();
    const ui = new FakeUi();
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual([{ text: BLOCKADE_CAPTION_TEXT, holdMs: BLOCKADE_CAPTION_HOLD_MS }]);
    expect(BLOCKADE_CAPTION_TEXT).toBe(
      "Your entrance is blockaded. Fighters waiting in the tunnel can't reach the ring: rally just outside the door to break it.",
    );
    ui.finish();
    // The ring still stands: not again.
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(false);
    // A second Blockade (the first ended, a new ring forms): not again either.
    r.enemy.rallyPoint = null;
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
    rallyOn(r.enemy, r.playerDoor);
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(true);
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(false);
    expect(ui.shown()).toEqual([BLOCKADE_CAPTION_TEXT]);
  });

  it('stays owed while the queue is busy and shows once it is idle', () => {
    const { r } = ringWorld();
    const state = createBlockadeCaptionState();
    const ui = new FakeUi();
    ui.showCaption('something else', 0, 0);
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(false);
    expect(state.shown).toBe(false);
    ui.finish();
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(true);
  });

  it('is not shown for a Loot or Assault rally with the same fighters at the door', () => {
    for (const type of [RaidType.Loot, RaidType.Assault]) {
      const { r } = ringWorld(type);
      expect(offer(r).shown).toBe(false);
    }
  });

  it('is not shown for a ring of only two fighters', () => {
    const { r } = ringWorld(RaidType.Blockade, BLOCKADE_CAPTION_MIN_FIGHTERS - 1);
    expect(offer(r).shown).toBe(false);
  });

  it('counts only living surface Fighting ants within the radius', () => {
    const { r, ids } = ringWorld();
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(true);
    // One fighter just outside the radius: a ring of two.
    const far = ids[0]!;
    r.world.ants.posX[far] = r.world.ants.posX[far]! + (BLOCKADE_RADIUS_TILES + 1) * FP_ONE;
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('does not count ants that are not Fighting or are below ground', () => {
    const { r, ids } = ringWorld();
    r.world.ants.task[ids[0]!] = AntTask.Foraging;
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
    r.world.ants.task[ids[0]!] = AntTask.Fighting;
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(true);
    r.world.ants.zone[ids[0]!] = Zone.Underground;
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('is not shown for a Blockade on a closed entrance', () => {
    const { r } = ringWorld();
    r.player.entrances.find((e) => e.surfaceTileX === r.playerDoor.x)!.isOpen = false;
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('is not shown for a Blockade on another colony’s entrance (a third colony)', () => {
    const { r } = ringWorld();
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(true);
    // The ring's target is not one of the viewer's entrances: it is a third colony's.
    const third = { ...r.player, colonyId: 3, entrances: r.player.entrances };
    (r.world.colonies as Record<number, unknown>)[3] = third;
    r.player.entrances = [];
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('is not shown when a ring fighter is dead', () => {
    const { r, ids } = ringWorld();
    despawnAnt(r.world, ids[0]!, { cause: 'starvation' });
    expect(blockadeCaptionCondition(r.world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('is not shown for a Blockade on a colony other than the viewer', () => {
    // The player blockades the enemy door; viewed as the player, nothing is owed.
    const r = raidWorld();
    r.player.raidType = RaidType.Blockade;
    rallyOn(r.player, r.enemyDoor);
    for (let i = 0; i < 4; i++) {
      addFighter(r.world, PLAYER_COLONY_ID, r.enemyDoor.x + 1 + i, r.enemyDoor.y, null);
    }
    expect(offer(r).shown).toBe(false);
    // Viewed as the enemy, it is the enemy's entrance that is blockaded.
    expect(blockadeCaptionCondition(r.world, ENEMY_COLONY_ID)).toBe(true);
  });

  it('is held back while the viewer rallies just outside the door, and shows once it moves', () => {
    const { r } = ringWorld();
    const state = createBlockadeCaptionState();
    const ui = new FakeUi();
    const door = r.playerDoor;
    rallyOn(r.player, { x: door.x - 2, y: door.y });
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(false);
    expect(state.shown).toBe(false);
    // Rally far away: the ring still holds, so it shows.
    rallyOn(r.player, { x: door.x - BLOCKADE_RADIUS_TILES - 3, y: door.y });
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(true);
  });

  it('shows when the viewer rallies on the entrance tile itself', () => {
    const { r } = ringWorld();
    rallyOn(r.player, r.playerDoor);
    expect(offer(r).shown).toBe(true);
  });

  it('is re-armed by a reset', () => {
    const { r } = ringWorld();
    const state = createBlockadeCaptionState();
    const ui = new FakeUi();
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(true);
    ui.finish();
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(false);
    resetBlockadeCaptionState(state);
    expect(offerBlockadeCaption(state, r.world, PLAYER_COLONY_ID, ui, 0, 0)).toBe(true);
  });
});
