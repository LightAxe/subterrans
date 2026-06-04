// game-scene-logic.ts — Pure helpers extracted from GameScene for testability.
//
// These functions have no Phaser dependency and can be unit-tested under Node (Vitest).
// GameScene imports and uses these; Plan 07 covers Phaser-coupled integration via Playwright.

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import type { SimCommand } from '../sim/commands.js';

// ---------------------------------------------------------------------------
// GamePhase state machine (object-const per project convention — not enum)
// ---------------------------------------------------------------------------

export const GamePhase = {
  Playing: 0,
  Paused: 1,
  GameOver: 2,
  SavePrompt: 3,
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

// ---------------------------------------------------------------------------
// decideBootMode — pure boot-path decider
// ---------------------------------------------------------------------------

/**
 * Returns 'prompt' if a save exists (user should be asked to Continue or start New Game),
 * or 'fresh' if no save is present.
 */
export function decideBootMode(hasSaveFn: () => boolean): 'prompt' | 'fresh' {
  return hasSaveFn() ? 'prompt' : 'fresh';
}

// ---------------------------------------------------------------------------
// deriveAIColonyIds — discovers non-player colony IDs
// ---------------------------------------------------------------------------

/**
 * Returns all colony IDs from world.colonies except the player colony, in ascending order.
 *
 * ADR-0006: world.colonies is a PLAIN OBJECT — uses Object.keys, never .keys()/.entries()/.get().
 */
export function deriveAIColonyIds(world: WorldState, playerColonyId: ColonyId): ColonyId[] {
  return Object.keys(world.colonies)
    .map((key) => Number(key) as ColonyId)
    .filter((cid) => cid !== playerColonyId)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// appendInputLog — SCEN-06 replay truth: never truncates
// ---------------------------------------------------------------------------

/**
 * Appends all commands from cmds into log.
 * SCEN-06: inputLog is AUTHORITATIVE — no truncation, no max size.
 * Plan 04 Task 1's replay equivalence test asserts byte-for-byte parity when
 * replayed against createScenario(seed). Dropping commands silently breaks that contract.
 */
export function appendInputLog(log: SimCommand[], cmds: readonly SimCommand[]): void {
  for (const c of cmds) log.push(c);
}

// ---------------------------------------------------------------------------
// resetInputLog — session ownership: clears the log in-place
// ---------------------------------------------------------------------------

/**
 * Empties the inputLog without reassigning the reference.
 *
 * (seed, inputLog) is the Phase 4 / Phase 9 replay contract and describes the
 * CURRENT session only. bootFresh must start with an empty log; bootFromSave
 * must start empty before appending the persisted log. restartGame reuses the
 * GameScene instance so leaked commands from the previous run would otherwise
 * silently break autosave/replay truth.
 *
 * In-place mutation preserves the object identity that holders (e.g. the
 * autosave closure) have already captured.
 */
export function resetInputLog(log: SimCommand[]): void {
  log.length = 0;
}

// ---------------------------------------------------------------------------
// generateFreshSeed — wall-clock to positive int32
// ---------------------------------------------------------------------------

/**
 * Converts a wall-clock timestamp (Date.now()) to a positive int32 suitable as a sim seed.
 * Date.now() is ~1.7e12 which exceeds int32 max. Bitmask-clamp to positive int32:
 *   (nowMs & 0x7fffffff) | 0
 * Bitwise ops truncate to int32; 0x7fffffff mask ensures the sign bit is clear → always positive.
 * No Math.floor needed — bitwise ops already truncate.
 */
export function generateFreshSeed(nowMs: number): number {
  return (nowMs & 0x7fffffff) | 0;
}
