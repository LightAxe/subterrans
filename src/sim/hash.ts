// hash.ts — deterministic integer hash, leaf sim util (no imports).
//
// MUST NOT import Phaser, DOM, sim state, or any non-leaf module — this is a
// pure function shared across the sim (spider meander/rampage targeting and the
// #209 idle-reserve wander) so it can't sit privately inside spider.ts.
// No Math.random, no world.rngState — fully replay-safe.

/**
 * Murmur3 32-bit finalizer over a single integer seed. Good avalanche,
 * deterministic, no rngState draw. Returns an unsigned 32-bit int.
 *
 * Extracted VERBATIM from spider.ts (#209 PR A) so the spider and the idle
 * reserve share one hash; the spider's replay identity is unchanged (same
 * arithmetic, same result).
 */
export function hash32(x: number): number {
  let h = Math.imul(x | 0, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
