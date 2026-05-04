// src/sim/combat.ts
// Phase 9 / CMBT-04..07 — pure-sim combat detection and resolution (instant-kill model).
//
// Model: two ants from DIFFERENT colonies sharing the same (zone, posX>>FP_SHIFT, posY>>FP_SHIFT) fight.
// Each round: deterministic coin flip via world.rngState picks a winner; loser's alive flag is zeroed.
// tickDeathCleanup (step 5 next tick) performs roster cleanup — combat.ts never calls swap-remove.
//
// Determinism: iterate tileKeys ascending; within a tile, iterate ant slot indices ascending;
// between colonies, pick the two lowest colonyIds first.
//
// No HP field — the existing AntComponents SoA has no hp slot and adding one would require a
// Phase-wide data model change. Instant-kill matches PRD §4 "fight rounds resolve in a single coin flip".

import { Rng } from './rng.js';
import { makeTileKey } from './tile-key.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import type { Zone } from './terrain.js';
import { FP_SHIFT } from './fixed.js';

/**
 * Sweep all live ants, bucket by tile, and resolve combat on tiles shared by 2+ colonies.
 * Mutates: world.ants.alive (instant-kills losers), world.colonies[*].killCount (increments
 * winners), world.rngState (advances once per round).
 */
/**
 * Issue #58 — caller passes the rng instance.
 *
 * Pre-fix this function was `(world)`-only and constructed a fresh Rng from
 * `world.rngState` internally. That state was still the tick-start value
 * (tickAntMovement mutates a separate rng_tick instance and only writes
 * back at end-of-tick), so combat's RNG sequence was effectively a
 * parallel stream that the end-of-tick writeback discarded — the
 * `world.rngState = rng.getState()` line we used to do here was overwritten
 * by tick.ts step 19. Functionally byte-deterministic (same seed → same
 * outcomes) but contradicts the design intent that "rng pulls accumulate."
 *
 * v11+: caller passes `rng_tick` so combat shares the tick's stream.
 * pre-v11: caller passes a fresh `Rng(world.rngState)` to preserve the
 *          dead-writeback behaviour for byte-identical replay of older saves.
 */
export function detectAndResolveCombat(world: WorldState, rng: Rng): void {
  const { ants } = world;
  const count = ants.alive.length; // capacity; iterate all slots (alive/colonyId guard)

  // Bucket live ants by tileKey.
  const bucket = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.colonyId[i] === 0) continue;
    const tileX = ants.posX[i]! >> FP_SHIFT;
    const tileY = ants.posY[i]! >> FP_SHIFT;
    // Phase 09.1 Chunk 4: pass currentGridColonyId so underground ants in
    // different grids at the same (tileX, tileY) bucket separately. makeTileKey
    // internally zeroes the gridByte for Surface, so passing this
    // unconditionally is safe and preserves surface bucketing byte-for-byte.
    const key = makeTileKey(
      ants.zone[i] as unknown as Zone,
      tileX,
      tileY,
      ants.currentGridColonyId[i] as ColonyId,
    );
    const slot = bucket.get(key);
    if (slot === undefined) bucket.set(key, [i]);
    else slot.push(i);
  }

  // Deterministic iteration: sort tileKeys ascending.
  const keys = Array.from(bucket.keys()).sort((a, b) => a - b);
  for (const key of keys) {
    const participants = bucket.get(key)!;
    if (participants.length < 2) continue;
    // Quick exit: all participants from one colony.
    const firstCid = ants.colonyId[participants[0]!]!;
    let multiColony = false;
    for (let j = 1; j < participants.length; j++) {
      if (ants.colonyId[participants[j]!]! !== firstCid) {
        multiColony = true;
        break;
      }
    }
    if (!multiColony) continue;
    resolveCombatOnTile(world, key, participants, rng);
  }
}

/**
 * Resolve combat on a single tile. Runs rounds until fewer than 2 distinct colonies remain.
 * Mutates world.ants.alive, world.colonies[*].killCount, and the passed rng instance.
 *
 * Issue #58 — caller passes rng. Previously constructed `new Rng(world.rngState)`
 * internally and did `world.rngState = rng.getState()` at the bottom; both
 * removed because tick.ts step 19 owns the world.rngState writeback.
 */
export function resolveCombatOnTile(world: WorldState, _tileKey: number, participants: readonly number[], rng: Rng): void {
  const { ants } = world;

  // Loop until only one colony remains among alive participants.
  // Each round guarantees one death → provably terminates in ≤ participants.length - 1 rounds.
  for (let iter = 0; iter < participants.length; iter++) {
    // Group alive participants by colonyId; sort colony ids ascending for determinism.
    const byColony = new Map<ColonyId, number[]>();
    for (const idx of participants) {
      if (ants.alive[idx] !== 1) continue;
      const cid = ants.colonyId[idx]! as ColonyId;
      const list = byColony.get(cid);
      if (list === undefined) byColony.set(cid, [idx]);
      else list.push(idx);
    }
    if (byColony.size < 2) break;

    const cids = Array.from(byColony.keys()).sort((a, b) => a - b);
    const cidA = cids[0]!;
    const cidB = cids[1]!;
    // Sort each group's slot indices ascending (was inserted in iteration order which is already ascending)
    // but be defensive in case caller passed arbitrary order.
    const groupA = byColony.get(cidA)!;
    const groupB = byColony.get(cidB)!;
    groupA.sort((a, b) => a - b);
    groupB.sort((a, b) => a - b);
    const antA = groupA[0]!;
    const antB = groupB[0]!;

    const flip = rng.nextInt(2); // 0 → A wins, 1 → B wins
    if (flip === 0) {
      killAnt(world, antB, cidA);
    } else {
      killAnt(world, antA, cidB);
    }
  }
  // Issue #58 — no writeback. The pre-fix `world.rngState = rng.getState()`
  // was always overwritten by tick.ts step 19 (rng_tick.getState()) so it
  // was dead code. Caller (tick.ts) owns the single end-of-tick writeback.
}

/**
 * Instant-kill: zero alive flag, increment killer killCount.
 * Roster cleanup is the responsibility of tickDeathCleanup at step 5 next tick.
 */
export function killAnt(world: WorldState, antIndex: number, killerColonyId: ColonyId): void {
  world.ants.alive[antIndex] = 0;
  if (killerColonyId !== 0) {
    const killerColony = world.colonies[killerColonyId];
    if (killerColony !== undefined) {
      killerColony.killCount += 1;
    }
  }
}
