// raid-captions.ts — #290 PR 6: raid legibility captions (plan §5).
//
// Raids are automatic (V52): a fighter rallied on an enemy's open entrance loots
// the enemy's FoodStorage when nothing hostile is in reach and hauls the food
// home. Without feedback the player sees neither side of it, so this module
// turns the colony raid counters into captions:
//
//   - `raided`   the player colony's `foodLostToRaidsFp` rose: raiders took a
//                load from one of its FoodStorage chambers;
//   - `looting`  the player colony's `foodRaidedFp` rose: one of its fighters
//                picked up a load in an enemy nest;
//   - `hauled`   the player colony's `raidTrips` rose: a hauler put its load
//                into the player's stores.
//
// Each is recurring but throttled: after it shows, the same caption stays quiet
// for RAID_CAPTION_COOLDOWN_TICKS of game time, so a raid loop does not repeat
// it every trip. One the busy caption queue cannot take yet is retried for a
// few seconds rather than lost (see nextRaidCaption). Counters, not events: the sim deliberately emits no raid events
// (the event log is capped and a playtrace schema change would need a server
// deploy first), and the counters are exact and serialized.
//
// Also the rally copy: `rallyTargetsEnemyEntrance` tells GameScene a player
// SetRallyPoint is on an enemy's open entrance (in a world that raids), which
// then shows the one-shot 'rallyRaid' caption (onboarding-captions.ts: the
// fighters will raid the larder) instead of the generic 'rally' one.
//
// Pure + Phaser-free: reads WorldState, mutates only its own RaidCaptionState.
// GameScene owns one per session, re-baselines it on boot/load (so a loaded
// save's historic counters never fire a caption) and polls it each frame.

import type { WorldState } from '../sim/types.js';
import { SIM_VERSION_V52_RAIDING } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';

export type RaidCaptionKind = 'raided' | 'looting' | 'hauled';

export const RAID_CAPTION_TEXTS: Record<RaidCaptionKind, string> = {
  raided: 'Raiders are stealing from your larder!',
  looting: 'Your fighters are raiding the enemy larder.',
  hauled: 'Your raiders hauled stolen food home.',
};

/** 60 s of game time (20 Hz) between two showings of the same raid caption. */
export const RAID_CAPTION_COOLDOWN_TICKS = 1200;

/**
 * How long a caption that the busy caption queue could not take is still offered
 * (10 s of game time): after that the news is stale and it waits for the next raid.
 */
export const RAID_CAPTION_OWED_TICKS = 200;

/** Checked in this order: being raided outranks your own raid news. */
const RAID_CAPTION_KINDS: readonly RaidCaptionKind[] = ['raided', 'looting', 'hauled'];

export interface RaidCaptionState {
  /** Last-seen counter values for the watched colony. */
  lostFp: number;
  raidedFp: number;
  trips: number;
  /** world.tick at which each caption last showed (-Infinity: never). */
  lastShownTick: Record<RaidCaptionKind, number>;
  /** world.tick of a counter rise not yet shown (-Infinity: none owed). */
  owedSinceTick: Record<RaidCaptionKind, number>;
}

export function createRaidCaptionState(): RaidCaptionState {
  return {
    lostFp: 0,
    raidedFp: 0,
    trips: 0,
    lastShownTick: { raided: -Infinity, looting: -Infinity, hauled: -Infinity },
    owedSinceTick: { raided: -Infinity, looting: -Infinity, hauled: -Infinity },
  };
}

/**
 * Re-baseline on the current counters and clear the throttles (new round, or a
 * loaded save): only increases after this point raise a caption.
 */
export function resetRaidCaptionState(
  state: RaidCaptionState,
  world: WorldState,
  colonyId: ColonyId,
): void {
  const c = world.colonies[colonyId];
  state.lostFp = c?.foodLostToRaidsFp ?? 0;
  state.raidedFp = c?.foodRaidedFp ?? 0;
  state.trips = c?.raidTrips ?? 0;
  for (const kind of RAID_CAPTION_KINDS) {
    state.lastShownTick[kind] = -Infinity;
    state.owedSinceTick[kind] = -Infinity;
  }
}

/**
 * The raid caption to offer this frame, or null.
 *
 * A counter rise outside that caption's cooldown makes the caption OWED; a rise
 * inside the cooldown is absorbed (never shown late). An owed caption is returned
 * on every call — first by the order raided, looting, hauled — until the caller
 * reports the caption queue took it (`markRaidCaptionShown`, which starts the
 * cooldown) or RAID_CAPTION_OWED_TICKS pass. The caller offers it only while the
 * caption queue is idle, so while another caption is showing it waits and is
 * retried rather than lost.
 *
 * A counter can fall (a hauler dying in the victim's nest hands its load back to
 * the victim's pool, which lowers both sides); a fall only moves the baseline.
 */
export function nextRaidCaption(
  state: RaidCaptionState,
  world: WorldState,
  colonyId: ColonyId,
): RaidCaptionKind | null {
  const c = world.colonies[colonyId];
  if (c === undefined) return null;
  if (c.foodLostToRaidsFp > state.lostFp) owe(state, world, 'raided');
  if (c.foodRaidedFp > state.raidedFp) owe(state, world, 'looting');
  if (c.raidTrips > state.trips) owe(state, world, 'hauled');
  state.lostFp = c.foodLostToRaidsFp;
  state.raidedFp = c.foodRaidedFp;
  state.trips = c.raidTrips;
  for (const kind of RAID_CAPTION_KINDS) {
    const since = state.owedSinceTick[kind];
    if (since === -Infinity) continue;
    if (world.tick - since > RAID_CAPTION_OWED_TICKS) {
      state.owedSinceTick[kind] = -Infinity; // stale: drop it
      continue;
    }
    return kind;
  }
  return null;
}

/** A rise of `kind`'s counter: owe the caption unless it is cooling down. */
function owe(state: RaidCaptionState, world: WorldState, kind: RaidCaptionKind): void {
  if (world.tick - state.lastShownTick[kind] < RAID_CAPTION_COOLDOWN_TICKS) return;
  if (state.owedSinceTick[kind] === -Infinity) state.owedSinceTick[kind] = world.tick;
}

/** The caption queue took `kind` at `world.tick`: start its cooldown, clear the debt. */
export function markRaidCaptionShown(
  state: RaidCaptionState,
  world: WorldState,
  kind: RaidCaptionKind,
): void {
  state.lastShownTick[kind] = world.tick;
  state.owedSinceTick[kind] = -Infinity;
}

/**
 * True when (tileX, tileY) is an open entrance of a colony other than `colonyId`
 * in a world that raids (V52+) — i.e. a rally there sends `colonyId`'s fighters
 * into that nest, where they loot its larder when nothing hostile is in reach.
 * Mirrors the sim's "rallied on this nest's entrance" test (ant-raid.ts).
 */
export function rallyTargetsEnemyEntrance(
  world: WorldState,
  colonyId: ColonyId,
  tileX: number,
  tileY: number,
): boolean {
  if (world.simVersion < SIM_VERSION_V52_RAIDING) return false;
  for (const key of Object.keys(world.colonies)) {
    const other = world.colonies[Number(key)];
    if (other === undefined || other.colonyId === colonyId) continue;
    const ents = other.entrances;
    if (ents == null) continue;
    for (const ent of ents) {
      if (ent.isOpen && ent.surfaceTileX === tileX && ent.surfaceTileY === tileY) return true;
    }
  }
  return false;
}
