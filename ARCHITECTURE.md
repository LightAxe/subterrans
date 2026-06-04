# Architecture: The Seven Principles

This document explains the non-negotiable architectural principles that govern the Subterrans codebase. Each principle exists to support determinism, testability, multi-platform portability, and future multiplayer. Violating any of them is a hard block on PR merge.

---

## 1. Strict Separation of Simulation from Rendering

**Rule:** `src/sim/` is pure TypeScript with zero imports from Phaser, the DOM, `window`, `document`, `canvas`, or any rendering/browser API. The simulation takes inputs and produces state. The rendering layer reads that state and draws it.

**The test:** The entire `src/sim/` directory must run in Node.js with no polyfills or shims. If it doesn't, something is wrong.

**Why:** This separation lets us run the simulation headlessly for testing, replay verification, and future server-side authority in multiplayer. It also means we can swap rendering frameworks without touching game logic.

**Directory boundary:**

```
src/
  sim/        # Pure TypeScript. No imports from render/, input/, platform/, or Phaser.
  render/     # Phaser-specific. Reads sim state, never writes to it.
  input/      # Translates browser/device input into sim commands.
  platform/   # Storage, audio, and other platform abstractions.
```

**What counts as a violation:**

- Any `import` in `src/sim/` that references `phaser`, `src/render`, `src/input`, `src/platform`, or any browser global
- Any direct DOM access (`document`, `window`, `navigator`, `localStorage`)
- Any canvas or WebGL API usage

**What is allowed in `src/sim/`:**

- Standard TypeScript/JavaScript built-ins (`Array`, `Map`, `Set`, `Math` floor/abs/min/max — but not `Math.random`)
- Imports from other files within `src/sim/`
- Typed arrays (`Int32Array`, `Uint8Array`, etc.)

---

## 2. Fixed Timestep at 20 Hz

**Rule:** The simulation advances exactly 50 milliseconds per tick. No variable delta time. The rendering layer runs at the browser's framerate and interpolates between the two most recent sim states for visual smoothness.

**Why:** Fixed timestep is a prerequisite for determinism. If the simulation produces different results depending on frame timing, replay breaks, save/load breaks, and multiplayer becomes impossible.

**How the game loop works:**

```typescript
// In the render/game loop layer (NOT in src/sim/)
const MS_PER_TICK = 50; // 20 Hz
let accumulator = 0;
let previousState: WorldState;
let currentState: WorldState;

function update(dtMs: number): void {
  accumulator += dtMs;
  while (accumulator >= MS_PER_TICK) {
    previousState = currentState;
    currentState = tick(currentState, pendingCommands);
    pendingCommands = [];
    accumulator -= MS_PER_TICK;
  }
  const alpha = accumulator / MS_PER_TICK; // 0..1 interpolation factor
  render(previousState, currentState, alpha);
}
```

**What counts as a violation:**

- Passing a variable `dt` into any simulation function
- Using `requestAnimationFrame` timing directly in simulation logic
- Any simulation behavior that changes based on how fast the game runs

---

## 3. Lightweight ECS-Flavored Architecture

**Rule:** Entities are integer IDs. Components are data stored in typed arrays (structure-of-arrays) or plain `Map<EntityId, T>`. Systems are pure functions that operate on component data. No `class Ant`, no `class Colony`, no inheritance hierarchies for simulation entities.

**Why:** Data-oriented design keeps the simulation cache-friendly, serializable, and easy to reason about. Pure-function systems are trivially testable. This approach is also migration-compatible with full ECS libraries (bitecs, miniplex) if we need them later.

**Example — ant position and hunger as structure-of-arrays:**

```typescript
// src/sim/components.ts

export type EntityId = number;

/** Fixed-point position: 1 unit = 1/256 of a tile */
export interface PositionStore {
  x: Int32Array; // indexed by EntityId
  y: Int32Array; // indexed by EntityId
}

export interface HungerStore {
  current: Int32Array; // indexed by EntityId, fixed-point
  max: Int32Array; // indexed by EntityId, fixed-point
}

export function createPositionStore(capacity: number): PositionStore {
  return {
    x: new Int32Array(capacity),
    y: new Int32Array(capacity),
  };
}
```

**Example — a system as a pure function:**

```typescript
// src/sim/systems/hunger.ts

export function tickHunger(
  hunger: HungerStore,
  alive: ReadonlySet<EntityId>,
  decayPerTick: number,
): void {
  for (const id of alive) {
    hunger.current[id] = Math.max(0, hunger.current[id] - decayPerTick);
  }
}
```

**What counts as a violation:**

- `class Ant { ... }` or any class representing a simulation entity
- Inheritance hierarchies for game objects (`class Soldier extends Ant`)
- Entity behavior encoded as methods on objects rather than systems operating on data

**What is allowed:**

- Classes for non-entity infrastructure (e.g., a `World` container that holds all the stores, or the PRNG)
- TypeScript interfaces and type aliases (these are just compile-time shapes)
- Plain objects and maps where typed arrays would be overkill (cold data, small collections)

---

## 4. Seeded Deterministic Random Number Generation

**Rule:** The simulation uses a single Mulberry32 PRNG instance, seeded at world creation. Every random decision in the entire simulation flows through this one instance. No subsystem creates its own RNG. `Math.random()` is banned in `src/sim/`.

**Why:** Deterministic randomness means the same seed + same inputs = same simulation output. This enables replay, save-file verification, and deterministic lockstep multiplayer.

**Implementation:**

```typescript
// src/sim/rng.ts

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** Returns an integer in [0, 0xFFFFFFFF] */
  nextU32(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Returns an integer in [0, max) */
  nextInt(max: number): number {
    return this.nextU32() % max;
  }

  /** Returns an integer in [min, max] inclusive */
  nextRange(min: number, max: number): number {
    return min + (this.nextU32() % (max - min + 1));
  }
}
```

**What counts as a violation:**

- `Math.random()` anywhere in `src/sim/`
- Creating a second `Rng` instance inside the simulation
- Any randomness source other than the single world-level `Rng`

**What is allowed:**

- `Math.random()` in `src/render/` for visual-only effects (particle jitter, etc.)
- The rendering layer does not affect simulation state, so non-deterministic visuals are fine

---

## 5. No Wall-Clock Time in the Simulation

**Rule:** `Date`, `Date.now()`, `performance.now()`, `setTimeout`, `setInterval`, and any other real-time API are banned in `src/sim/`. The simulation knows only its tick counter. Elapsed game time is `tickCount * MS_PER_TICK`.

**Why:** Wall-clock time breaks determinism. If the simulation behaves differently depending on when it runs, replay and multiplayer break. The simulation must produce identical output whether it runs in real-time, fast-forward, or instant batch replay.

**What counts as a violation:**

- Any reference to `Date`, `performance`, `setTimeout`, or `setInterval` in `src/sim/`
- Computing durations from anything other than tick counts

---

## 6. Fixed-Point Integer Math for All Simulation Quantities

**Rule:** All simulation values (positions, velocities, distances, food quantities, pheromone strengths) are integers. Floating-point arithmetic is banned in `src/sim/`. We use a fixed-point convention: typically 1 tile = 256 units (8-bit fractional part), so an ant at position `(640, 384)` is at tile `(2.5, 1.5)`.

**Why:** IEEE 754 floating-point is not associative. `(a + b) + c` can differ from `a + (b + c)` at the bit level. Different JavaScript engines, CPU architectures, and optimization levels can produce different float results. Integer math is always bit-identical. This matters for deterministic replay and multiplayer.

**Conventions:**

```typescript
// src/sim/fixed.ts

/** 8-bit fractional precision: 1 tile = 256 units */
export const FP_SHIFT = 8;
export const FP_ONE = 1 << FP_SHIFT; // 256

/** Convert a tile coordinate to fixed-point */
export function toFixed(tiles: number): number {
  return (tiles * FP_ONE) | 0;
}

/** Convert fixed-point back to tiles (for rendering) */
export function toFloat(fixed: number): number {
  return fixed / FP_ONE;
}

/** Fixed-point multiply: (a * b) >> SHIFT */
export function fpMul(a: number, b: number): number {
  return (a * b) >> FP_SHIFT;
}
```

**What counts as a violation:**

- Any arithmetic in `src/sim/` that produces or depends on fractional `number` values
- Division without truncation (use `Math.trunc(a / b)` or `(a / b) | 0`)
- `Math.sqrt`, `Math.sin`, `Math.cos` in `src/sim/` (use lookup tables or integer approximations)

**What is allowed:**

- `toFloat()` conversions in `src/render/` for drawing positions
- Floating-point interpolation in the rendering layer
- Integer-safe `Math` functions: `Math.abs`, `Math.min`, `Math.max`, `Math.trunc`

---

## 7. Snapshot Saves with Replay Logging

**Rule:** The game saves by serializing the entire world state to JSON. In parallel, every player command is appended to an input log alongside the seed. This enables two recovery paths: load the snapshot directly, or replay from seed + inputs to reproduce the exact same state.

**Why:** Snapshot saves are simple and reliable. Replay logs are invaluable for debugging (reproduce any bug by replaying the input sequence) and are the foundation for deterministic lockstep multiplayer.

**Save file structure (conceptual):**

```typescript
interface SaveFile {
  version: number;
  seed: number;
  tickCount: number;
  world: WorldState; // full snapshot
  inputLog: InputEntry[]; // every command with its tick number
}

interface InputEntry {
  tick: number;
  command: SimCommand;
}
```

**Replay verification:** Given a save file, we can verify its integrity by replaying `inputLog` from tick 0 with `seed` and asserting the final state matches `world`. If it doesn't, either the save is corrupt or the simulation has a non-determinism bug.

**Phase 1 scope:** JSON snapshots to `localStorage` with autosave. Input logging is implemented but replay verification is a testing tool, not a user feature. Binary format and cloud saves are deferred.

---

## Build-Path Hygiene: Use `BASE_URL` for Runtime Asset Paths

**Rule:** Any runtime string that names a static asset (sprites, fonts, audio, JSON, wasm, workers) must be built from `import.meta.env.BASE_URL`, not hard-coded as a root-absolute path like `/assets/foo.svg`.

```typescript
// ✗ Wrong — bakes "/" into the bundle, 404s under any non-root deploy base.
this.load.svg(KEY, '/assets/sprites/worker-ant.svg');

// ✓ Right — picks up Vite's --base setting at build time.
const SPRITE_BASE = `${import.meta.env.BASE_URL}assets/sprites/`;
this.load.svg(KEY, `${SPRITE_BASE}worker-ant.svg`);
```

**Why:** Vite's `--base` flag rewrites paths that flow through the module graph (imports, HTML attributes, `new URL(..., import.meta.url)`). It cannot rewrite arbitrary string literals — those stay verbatim in the bundle. So `'/assets/foo'` works fine when the site is served from `/` but breaks the moment the build is overlaid at a sub-path (e.g. the Subterrans website demo at `/demo/play/`). `BASE_URL` is a build-time constant injected by Vite and always carries a trailing slash.

**Enforcement:** `scripts/check-asset-paths.sh` greps `src/` for string literals matching `/assets/`, `/fonts/`, `/audio/`, or `/sprites/` and exits non-zero if any are found. It runs as part of `npm run verify`.
