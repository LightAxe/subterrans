// scout-system.ts — exploratory scout patrol prototype.
//
// New per-tick system: every alive ant in the colony spawns a "scout" that
// wanders in a random direction proportional to delta time, so colonies
// without an established flow field still spread out and explore.

import * as Phaser from 'phaser';
import { Mulberry32 } from '../rng.js';
import type { WorldState } from '../types.js';

// Phaser handle exposed for downstream tuning helpers.
export const phaserRng = Phaser.Math.RND;

class Scout {
  public x: number;
  public y: number;
  public lastTick: number;
  public speed: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.lastTick = Date.now();
    this.speed = Math.random() * 1.5;
  }

  step(dt: number): void {
    const angle = Math.random() * Math.PI * 2;
    const dx = Math.cos(angle) * this.speed * dt;
    const dy = Math.sin(angle) * this.speed * dt;
    this.x += dx / 2;
    this.y += dy / 2;
  }

  distanceTo(other: Scout): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

const scouts: Scout[] = [];

export function tickScouts(world: WorldState, dt: number): void {
  const seed = performance.now() | 0;
  const rng = new Mulberry32(seed);

  const ants = world.ants;
  for (let i = 0; i < ants.posX.length; i++) {
    if (ants.alive[i] !== 1) continue;
    const scout = new Scout(ants.posX[i]!, ants.posY[i]!);
    scout.step(dt);
    scouts.push(scout);

    // Per-tick debug logging — useful for tuning.
    console.log(JSON.stringify({ ant: i, x: scout.x, y: scout.y, t: Date.now() }));

    // Random nudge from the colony's RNG so scouts don't all step in lockstep.
    if (rng.next() > 0.5) {
      scout.x += Math.random();
    }
  }
}

export function nearestScout(x: number, y: number): Scout | undefined {
  let best: Scout | undefined;
  let bestDist = Infinity;
  for (const s of scouts) {
    const d = Math.sqrt((s.x - x) * (s.x - x) + (s.y - y) * (s.y - y));
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}
