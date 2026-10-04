# Architecture: The Seven Principles

This document explains the non-negotiable architectural principles that govern the Subterrans codebase. Each principle exists to support determinism, testability, multi-platform portability, and future multiplayer. Violating any of them is a hard block on PR merge.

The seven principles (plus a build-path hygiene rule) come first; the final section, [Implemented Systems](#implemented-systems), maps what the codebase actually contains as of Phase 3 and which principle each part answers to.

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
// Illustrative SoA sketch — real component stores live in e.g. src/sim/ant/ant-store.ts

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
// Illustrative — real systems live in e.g. src/sim/colony/colony-system.ts

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
    this.state = seed >>> 0; // coerce to uint32 (matches setState + PRD §4 vectors)
  }

  /** Returns an integer in [0, 0xFFFFFFFF] */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0); // Mulberry32 advance — keep uint32
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

  /** Snapshot / restore for the tick RNG contract (#161): tick() reconstructs an
   *  Rng from state.rngState at tick start and writes getState() back at tick
   *  end, so the stream is a pure function of WorldState. */
  getState(): number {
    return this.state;
  }
  setState(state: number): void {
    this.state = state >>> 0;
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

/** Fixed-point multiply. Math.imul for C-style 32-bit signed semantics; signed
 *  >> preserves negatives (do NOT use >>>). */
export function fpMul(a: number, b: number): number {
  return Math.imul(a, b) >> FP_SHIFT;
}
/** Fixed-point divide. Left-shift the dividend for sub-unit precision; Math.trunc
 *  for integer semantics. The only sanctioned division in src/sim/. */
export function fpDiv(a: number, b: number): number {
  // eslint-disable-next-line no-restricted-syntax -- fpDiv is the only sanctioned division in src/sim/; result immediately truncated
  return Math.trunc((a << FP_SHIFT) / b);
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

**Rule:** The game saves by serializing the entire world state to JSON. In parallel, every command applied to the simulation — the player's *and the AI's* — is appended to an input log alongside the seed. (The AI controller is a render-layer policy that issues `SimCommand`s, so its commands are part of the replayable input — see Principle 1.) This enables two recovery paths: load the snapshot directly, or replay from seed + inputs to reproduce the same state.

**Why:** Snapshot saves are simple and reliable. Replay logs are invaluable for debugging (reproduce any bug by replaying the input sequence) and are the foundation for deterministic lockstep multiplayer.

**Save file structure (conceptual):**

```typescript
interface SaveFile {
  version: number; // save-envelope format version
  seed: number;
  inputLog: SimCommand[]; // every drained command — player AND AI — in order (replay truth)
  snapshot: WorldState; // full serialized world (carries its own simVersion + tick)
  savedAtMs?: number; // wall-clock stamp, display only
}
```

**Replay verification:** Given a save file, replaying `inputLog` from tick 0 with `seed` should reproduce the snapshot's simulation state — **excluding the pending `commandQueue`**. Autosave fires on a wall-clock timer, not a tick boundary, so a snapshot can capture commands that are queued but not yet drained into `inputLog`; a from-seed replay starts with an empty queue, so that queue legitimately differs and is stripped before comparison (see `scripts/analyze-snapshot.ts`). Two more rules make a replay faithful (#296, `src/platform/input-log-replay.ts`): commands are regrouped by the recorded per-command `drainTick` — the tick whose batch the sim actually consumed them in — not by `issuedAtTick` (the sim's own self-emits are issued one tick before they drain; for logs without `drainTick` the fallback is `origin === 'sim' ? issuedAtTick + 1 : issuedAtTick`), and the replaying world's regenerated `commandQueue` is discarded before each tick so a self-emit is never applied twice. The replaying world is generated with `createScenario(seed, difficulty, simVersion)` at the snapshot's recorded `simVersion`, not created at LATEST and re-stamped, so that a world-generation gate rebuilds the recorded map (#395). No world-generation step is gated today: #408 reaped the only one, V69's food fairness. Post-1.0 world-generation gates make it matter again. A mismatch in the rest of the state means the save is corrupt or the simulation has a non-determinism bug. The underlying determinism property is proven separately by `src/sim/determinism.test.ts` — two fresh runs from the same seed produce byte-identical serialized state (there both queues are identical, so nothing is excluded).

**Save versioning and `simVersion`:** The envelope lives in `localStorage` with a 30-second autosave. A save loads by **deserializing its snapshot**. The snapshot is authoritative: loading does not re-derive state from `seed` + `inputLog`. Separately from the envelope `version`, the simulation carries a `simVersion`. It increments whenever a change would make an already-written save **deserialize or continue incorrectly**, or would change the world a seed generates:

- an added, removed or reinterpreted `WorldState` field;
- a tick-order change;
- an algorithm change;
- a change in PRNG draw count or order;
- a change to the rule-based AI's policy (`src/render/ai-controller.ts`), because a loaded game continues under the AI;
- an algorithm change to world generation (`createScenario`), even though no saved snapshot is affected (#395). A bare constant retune does not count; see below.

**World generation, replay and Retry.** The from-seed replay above regenerates the world at the snapshot's recorded `simVersion`. Retry from the end-of-game survey does not: it starts the seed again at LATEST, the newest rules, just as a new game does (`createRetryWorld` in `src/render/game-scene-logic.ts`). Building an older map and stamping LATEST on it would leave a world whose map no longer follows from its `seed` and `simVersion`, and the from-seed replay relies on that link.

Since #408, `createScenario`'s `simVersion` argument only stamps the world. No world-generation step is version-gated, so every version gets the same map, and with `MIN === LATEST` Retry regenerates the map the lost game started on. While V69's food fairness was gated and pre-V69 saves still loaded (MIN was V50 until #400), a game resumed from one retried on its seed's V69 map: same terrain, different food. The argument stays because post-1.0 world-generation gates make it matter again. Such a gate in `createScenario` reads `world.simVersion`, which the function's first step sets from the argument. The replay and the byte gate's `BYTE_GATE_SIM_VERSION` pin both pass a version through it.

A pre-1.0 world-generation change is not gated, so `createScenario` cannot rebuild a map from before it. Once `MIN === LATEST`, `analyze-snapshot` accepts only snapshots at LATEST, and a replay is faithful only on the build that recorded it.

Saves below `MIN_ACCEPTED_SIM_VERSION` are rejected outright. There is no migration of an old save *format* into a new one. Saves from a *newer* build are preserved, not loaded, so they can be recovered there.

**Current rule, pre-1.0: no gates; MIN moves with LATEST.** Owner decision, 2026-10-01: backward compatibility is a 1.0-level concern, and before 1.0 it cost more than it bought.

- **No gates and no cross-version proofs.** New behaviour is **not** wrapped in `simVersion >=` gates, and older versions are not proven byte-identical.
- **Both versions move together.** Each sim-behaviour change bumps `LATEST_SIM_VERSION` and raises `MIN_ACCEPTED_SIM_VERSION` to the same value. `MIN === LATEST` is the normal state. Once it holds, a save loads only on a build at its own `simVersion`.
- **Older in-progress saves are wiped.** They are rejected with `OldSimVersionError`, and that is accepted.
- **Determinism within a build still holds.** The same seed and commands give the same game, proven by replay and save/load-continue tests. Once `MIN === LATEST`, sticky-on-load holds trivially, because every loadable save is at LATEST.
- **Existing gates were reaped (#408).** 64 gate sites across 20 versions, V51 to V70, predated this rule. Most were in `src/sim/`; a few were in the AI controller, HUD readers and `save.ts`. With `MIN === LATEST` all of them were production-dead.
  - #408 removed them in three PRs (#417, #420 and part 3) as the mechanical refactor below, keeping LATEST byte-identical.
  - It kept the gating machinery for post-1.0 (see "Re-enabling simVersion gates" below).
  - The rules of V70 and earlier no longer exist in code, so MIN can never go below V71: the reap floor.
- **Legacy version-pinned tests.** Delete or re-pin to LATEST any old-version-pinned test that an ungated change or a MIN raise breaks. Examples are a `*-vNN-parity.test.ts` golden or a save test that loads a pre-MIN save. Never keep one green with a gate.
  - #408 deleted the goldens and the pins on the reaped gates.
  - A few pre-V50 pins on rules that have no gate remain. They are harmless.
- **Out-of-window snapshots replay on their own build.** A snapshot outside `[MIN, LATEST]` (an F9 export or a playtrace) must be replayed on the build that recorded it. `scripts/analyze-snapshot.ts` says so and points at a build. For a playtrace that is the recording build itself, from its `gameVersion` git SHA. An F9 export has no build id, so the CLI points at the last commit at that `simVersion`. If origin/main never reached that version, it lists the branch commits that touched it. That commit is not necessarily the recording build: a bare constant retune at the same `simVersion` (retunes never bump it) can still make the replay diverge.
- **Transition and guards.** Sim PRs opened under the earlier policy (#402 V69, #405 V70) landed gated with MIN left at V50. The first sim PR after them, #400 (V71), set `MIN === LATEST`.
  - `version-policy.test.ts` enforces the MIN/LATEST rules.
  - "No gates" is a review rule, backed by `src/platform/no-new-gates.test.ts`. That test fails on any of these in non-test code under `src/`, `scripts/` or `bench/`:
    - a `SIM_VERSION_V<n>` reference outside the registry's declarations in `src/sim/types.ts` and the `MIN_ACCEPTED_SIM_VERSION` line (and its import) in `save.ts`;
    - a relational comparison (`<`, `<=`, `>`, `>=`) of a `simVersion` value outside the window check in `snapshot-window.ts`.
  - The no-new-gates test is deleted at 1.0 (below).

**Post-1.0 plan: sticky gates and a rolling acceptance window.** This is how the gates were written between #228 and 2026-10-01 (#408 has since reaped them). It is meant to return at 1.0, once players have saves worth keeping; the next section is the turn-on guide.

- **Sticky on load.** A save keeps the `simVersion` it was written under; it is never silently upgraded. Behaviour changes are wrapped in `if (world.simVersion >= V_X)` gates, so a save from an earlier accepted version continues under the rules it was created with.
- **Rolling acceptance window.** Within the accepted window, deserialization validates each field and defaults the ones introduced across that window. For example, a pre-difficulty save loads as `Normal`, and a pre-spider save's spider fields load as `null`. A supported older save therefore opens without a transform step. The window is honoured, not zero-width: `MIN_ACCEPTED_SIM_VERSION` stays put while `LATEST_SIM_VERSION` advances, and each behaviour change ships a sticky `simVersion >=` gate. Raising MIN is then a deliberate, justified exception, because it wipes real players' saves. (#228)

**Re-enabling simVersion gates (post-1.0).** This is the turn-on guide for 1.0. It says what already exists, what the one turn-on PR changes, and what each gated PR after it does.

*Status.* #408 reaped the last pre-1.0 gates (V51–V70), keeping LATEST byte-identical. #247, #342 and #354 had already reaped those up to V49.
- The mechanism that gates need stayed, listed below. Do not rebuild it.
- The rules of V70 and earlier no longer exist in code, so MIN can never go below V71. `LAST_GATED_SIM_VERSION` in `version-policy.test.ts` enforces that floor.
- Until the turn-on, `src/platform/no-new-gates.test.ts` keeps new gates out.

*Already in place: do not rebuild.*

| Piece | Where |
|---|---|
| `world.simVersion`: the field, stamped LATEST on a new world, copied with the world | `src/sim/types.ts` (`WorldState.simVersion`, `createWorldState`, `copyWorldState`) |
| Serialized and sticky on load: the saved value is validated and kept, never restamped | `src/platform/save.ts` (`serializeWorldState`, `deserializeWorldState`) |
| Load validation, run first: `validateSimVersion`, `OldSimVersionError`, `FutureSimVersionError`. A save from a newer build is preserved, not deleted (`'incompatible-future'`) | `src/platform/save.ts`; `bootFromSave` in `src/render/game-scene.ts` |
| `LATEST_SIM_VERSION`; `MIN_ACCEPTED_SIM_VERSION` with its "why it is VNN" notes | `src/sim/types.ts`; `src/platform/save.ts` |
| The version registry: `LEGACY_SIM_VERSION` and every `SIM_VERSION_V<n>_<SUFFIX>` entry with its history. Keep the names and the `export const LATEST_SIM_VERSION = SIM_VERSION_V<n>_<SUFFIX>;` line format, because the git pickaxe recipes parse them | `src/sim/types.ts`; the recipes in `src/platform/snapshot-window.ts` |
| Policy guard: LATEST is the newest registered version, MIN ≤ LATEST, the floor | `src/platform/version-policy.test.ts` |
| Byte gate: capture/verify, the `BYTE_GATE_SIM_VERSION` pin (`parsePinnedSimVersion`), `BYTE_GATE_SWEEP`, `BYTE_GATE_PROJECTION`, `BYTE_GATE_COVERAGE` | `src/platform/byte-gate.test.ts`, `world-hash.ts`, `food-projection.ts` |
| World generation at a given version | `createScenario(seed, difficulty, simVersion)` in `src/sim/scenario.ts` |
| Retry and new games at LATEST | `createRetryWorld` in `src/render/game-scene-logic.ts` |
| Snapshot replay. An out-of-window snapshot is refused with a pointer to its recording build; an in-window one replays at its own version | `scripts/analyze-snapshot.ts`, `src/platform/snapshot-window.ts` |
| Envelopes that carry the version: the playtrace `simVersion` and `gameVersion` SHA, and the F9 debug snapshot | `src/render/playtrace-upload.ts`, `src/platform/debug-snapshot.ts` |
| Load-side defaults for fields added inside the window, the rolling-window pattern. Examples: `fleeShelterUntilTick` is optional on load, an absent `alarmActive` loads as false, an absent difficulty as Normal, absent V54 spider fields as −1 | `src/platform/save.ts` |
| Policy docs | AGENTS.md "simVersion and saves", this principle, CONTEXT.md (`simVersion`), `.coderabbit.yaml` |

*Turn-on checklist: one PR at 1.0.*
- **(a) Floor.** Set MIN to the 1.0 LATEST, never below the reap floor (V71). Pre-1.0, MIN already equals LATEST. If the 1.0 release bumps LATEST, every pre-1.0 save is rejected then, once. From then on MIN is held.
- **(b) `version-policy.test.ts`.** Replace "MIN equals LATEST once past the transition", and the transition branches, with the window rule: MIN is held while LATEST advances, and raising MIN needs a declared break. Keep the newest-registered, MIN ≤ LATEST and floor assertions. Templates:
  - the rolling-window test: `git show c8889d4^:src/platform/version-policy.test.ts`;
  - the `DELIBERATE_WINDOW_BREAK_AT` ritual: `git show c8889d4^:src/platform/save.ts`.

  The turn-on PR itself leaves MIN === LATEST, so under that rule it declares the break at the 1.0 LATEST. The next PR that bumps LATEST sets it back to `null` and opens the window.
- **(c) Policy text and the guard.**
  - AGENTS.md "simVersion and saves": the rules, the standing rebuttal list and the PR checklist line;
  - the "Current rule, pre-1.0" block above, which this section's rule replaces;
  - the CONTEXT.md `simVersion` and "Input log / replay" entries;
  - the `.coderabbit.yaml` `**` instruction: flag a missing gate, and require `BYTE_GATE_SIM_VERSION` evidence for a gated change;
  - delete `src/platform/no-new-gates.test.ts`.

  Every other statement of the pre-1.0 rule changes too. Find them with `git grep -nE "[Pp]re-1\.0|PRE-1\.0|[Bb]efore 1\.0|[Uu]ntil 1\.0"`; the grep is the instruction. Today they include:
  - the `types.ts` registry header, which every gated PR reads when it adds its constant;
  - the `save.ts` MIN doc;
  - the `constants.ts` header;
  - `snapshot-window.ts`, both its header and the `SAME_BUILD_RULE` text the CLI prints;
  - `analyze-snapshot.ts`;
  - the `byte-gate.test.ts` header;
  - in AGENTS.md: the principle summary (item 7), the deterministic-replay-tests bullet and the replay review guideline;
  - in this document: the last sentences of "World generation, replay and Retry", the "What a bump does" list and the closing pointer to AGENTS.md;
  - the `.coderabbit.yaml` `src/sim/**` entry's pointer to the policy;
  - test comments in `save.test.ts`, `snapshot-window.test.ts` and `food-fairness.test.ts`.
- **(d) Tracking.** If no 1.0 tracking issue links here yet, file one, and close it with this PR.

*Every gated PR after that.*
- **(a) Version.** Add `SIM_VERSION_V<n>_<SUFFIX>` with a registry entry, and point LATEST at it. MIN does not move.
- **(b) Gate.** Wrap the new behaviour in `if (world.simVersion >= SIM_VERSION_V<n>_<SUFFIX>)` and leave the old path byte-untouched. Besides sim code, that covers:
  - world generation in `createScenario`, which reads `world.simVersion` (its first step sets it from the argument);
  - the AI controller's policy (`src/render/ai-controller.ts`), because a loaded game continues under the AI;
  - render readers that interpret the rule, such as a HUD bar or a caption.
- **(c) New `WorldState` fields.** The serializer always writes them. The deserializer defaults them for older in-window saves, and any validation that depends on the version keys on the validated `simVersion`.
- **(d) `analyze-snapshot`.** Strip from the replay's serialization any always-emitted new field that an older in-window snapshot lacks. Otherwise every such snapshot reads as a SCEN-06 regression.
- **(e) Proof.** Capture the byte gate on the base with `BYTE_GATE_SWEEP=1`. Then verify on the branch with `BYTE_GATE_SWEEP=1` and `BYTE_GATE_SIM_VERSION=<base LATEST>`: the old path must stay byte-identical. The sweep flag is stored in the baseline, so a mismatched pair fails loudly. The new behaviour gets the usual within-build determinism, economy sweep and mutation tests.
- **(f) Optional V-pinned tests.** An audit of V(n−1) against Vn, or a golden pinned at V(n−1).

*Worked examples in history.* At `884b649`, the merge base of #408's first PR, every pre-1.0 gate is still in place:
- `src/sim/ant/ant-raid.ts`: four versions (V52, V53, V59, V60) in one module;
- `src/sim/scenario.ts:486`: a world-generation gate (V69);
- `src/render/ai-controller.ts`: AI-policy gates (V53, V61–V63, V69);
- `src/render/hud-stats.ts`, `src/render/queen-danger.ts`: render readers (V66);
- `src/platform/save.ts:1952`, `:2167`, `:2195`: version-conditional load validation (V60, V52, V51/V66);
- `scripts/analyze-snapshot.ts:274–300`: the V54 snapshot-key strip;
- tests: the V64-against-V65 audit in `src/sim/alarm-invasion.test.ts`, and the golden pinned at V67, `src/sim/rampage-shelter-v67-parity.test.ts`.

#408's three squash commits on main (`git log --grep='#408 part'`), read in reverse, show each gate's full footprint: site, orphans and tests. Each PR's per-subsystem commits stay fetchable, for example `git fetch origin pull/417/head` for part 1 and `pull/420/head` for part 2.

*Why the old gates were not kept.* The old gates kept pre-1.0 saves replaying under their own rules. At 1.0, MIN rises to the 1.0 LATEST, so no pre-1.0 save will ever load again, and post-1.0 gates guard only post-1.0 changes. No pre-1.0 legacy branch could ever be reached again, so keeping those 64 sites would have cost review and test time for nothing. What a post-1.0 gate needs is the mechanism, which stayed. Git history keeps every pattern as a template.

**Gate reaping (dead-branch removal, #228, #408).** Once `MIN_ACCEPTED_SIM_VERSION` passes a version `VNN`, every `world.simVersion < VNN` branch is unreachable in production: no loadable save and no fresh world can be below MIN. `createScenario`'s `simVersion` argument creates such a world only in tests, because `analyze-snapshot` refuses a snapshot below MIN. #408 used this to reap the remaining pre-1.0 gates, after #247, #342 and #354. Post-1.0 it applies whenever a deliberate MIN raise leaves gates behind. Reaping is a mechanical refactor:

0. **Spike first.** In a scratch worktree, reap every candidate site at once and run the full suite and the byte gate. The failing tests are the exact fallout map for each commit, including tests that pinned an old version by accident. Throw the spike away.
1. **List the gates.** Run `git grep -n "SIM_VERSION_V" -- src scripts bench` (most are in `src/sim/`; a few are in the AI controller, HUD readers, `save.ts` and `analyze-snapshot`). Pick those with `VNN <= MIN_ACCEPTED_SIM_VERSION`.
2. **Delete the legacy branch,** making the `>=` side unconditional. Do not otherwise reword the surviving code. Delete the orphans with it: constants, helpers, imports and "before VNN …" comment sentences that only the legacy side used. Keep provenance tags such as "(#NNN, VNN)".
3. **Fix the tests.**
   - Delete the tests that pin the old side (they set `world.simVersion` below `VNN`).
   - Rewrite a comparison test (V(n−1) against Vn, or an audit) to its LATEST half, as absolute assertions.
   - Refixture a test that pinned an old version by accident.
   - Never `-u` a snapshot.
4. **Prove byte-identity** with the capture/verify harness (`src/platform/byte-gate.test.ts`). Capture with `BYTE_GATE_MODE=capture BYTE_GATE_SWEEP=1` on the pre-reap commit and verify with the same flags after. `BYTE_GATE_SWEEP` adds a both-AI sweep and a raid-type cycle to the six scenarios.
   - `src/sim/determinism.test.ts` must also be green, and the `__snapshots__` must not change.
   - Once per PR, compare `check:ai-economy --seeds=200` and `--both-ai --seeds=100` per-seed rows between base and head. That samples about 50× more AI ticks than the byte gate.
5. **Build a mutation table.** For every reaped site, force the legacy behaviour at LATEST and run the related tests; each mutant must fail at least one. This replaces the non-vacuity that the deleted old-version halves gave. Pin a surviving mutant with a new LATEST test, or show that it is equivalent.
6. **Keep the registry entries** in `types.ts`: they are history, and the `snapshot-window.ts` recipes parse them.
7. **Split by subsystem.** Reap one subsystem per commit, each commit green and byte-identical on its own, and group the commits into a few cohesive PRs.

**What does *not* bump `simVersion`:**

- **Render-only changes.** Drawing, HUD, camera and input code never touches sim state. The AI controller's policy is not render-only (see above).
- **Bare balance-constant retunes.** A retune shifts live balance for new and loaded games alike, without changing how a saved snapshot deserializes or continues. The one thing a retune does *not* preserve is byte-identical replay of an *older* save from `seed` + `inputLog`. Replay byte-identity (verified by `src/sim/determinism.test.ts`) is therefore asserted **within a single build**, not across builds.

What a bump does depends on the policy in force:

- **Pre-1.0:** a bump only marks the save and snapshot boundary. Older saves are rejected, and older snapshots, including world-generation changes, replay on their recording build.
- **Post-1.0:** the bump-and-gate rule keeps an older save **loadable and correct when continued on a newer build**. A field, shape, tick-order or algorithm change can break that, so those bump and gate. A constant retune cannot. For an algorithm change to world generation, the gate also keeps an older world's from-seed replay faithful (#395).

**Deferred:** binary save format and cloud saves.

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

---

## Implemented Systems

The principles above are the rules; this section maps what the codebase actually contains as of the post-Phase-3 two-role controls rework (2026-06); Phase 3 ("First Real Round") shipped 2026-05-27. Simulation systems live under `src/sim/` and run through the tick dispatcher; rendering, input, and AI policy live under `src/render/` and `src/input/`.

### Simulation — `src/sim/`

- **Tick dispatcher** (`tick.ts`) — `tick(world, commands)` applies the `SimCommand` array the platform game loop drained from `world.commandQueue`. The loop (`game-loop.ts`) owns the `splice` and invokes an optional `onAfterDrain` seam; `GameScene`'s callback appends those commands to the replay `inputLog` — `tick` itself never drains the queue or logs. It then runs ~19 ordered steps each tick: reconcile colony stats → food consumption / starvation → death cleanup → queen egg production → lifecycle transitions → worker allocation → flow-field rebuild → task assignment → chamber/entrance completion → forage routing → pheromone deposit/decay → movement → forager & nurse actions → health (clamp / heal) → combat → spider (so its retreat reads post-combat HP) → game-over check → RNG writeback.
- **World / ECS** (`types.ts`, `ant/ant-store.ts`) — a plain-object `WorldState`; ants stored as structure-of-arrays typed arrays (Principle 3).
- **Colony lifecycle** (`colony/`) — eggs → larvae → workers; the queen's egg interval scales with food surplus and nurses accelerate larva maturation, with Nursery capacity as the growth bottleneck (the *reproduction lever*). From V70 (#395) she lays only while the colony's stores cover the *egg reserve* — the whole colony's meals for `QUEEN_EGG_RESERVE_RUNWAY_TICKS`, the new egg's larva included (`lifecycle-system.ts` `eggReserveFp`) — so she never lays against food the colony has not got, and storage capacity becomes a second growth bottleneck: the brood can be no bigger than the larder can feed.
- **Foraging & pheromones** (`pheromone/`, foraging systems) — grid-based `FoodTrail` and `DangerTrail` pheromone layers (Principle: pheromones-as-grid); leash-bounded search waves; BFS flow-field pathfinding (in `dig-system.ts` / `entrance-flow.ts` / `chamber-flow.ts`; `tick.ts` orchestrates and owns the per-world caches) for dig / entrance / chamber routing.
- **Food, hunger and raids** (`food/`, `hunger.ts`, `ant/ant-raid.ts`) — every unit of food lives in one located **food store** (`world.food`, `food/food-store.ts`, structure-of-arrays records, #290 V50): each colony's entrance **pool**, each FoodStorage chamber's **stock**, and each surface **food pile**; the only other place food exists is an ant's carried load (`ants.foodCarrying`). All reads and writes go through the **food facade** (`food/food-api.ts`) — colony totals and capacity, pile pickups, deposits (a FoodStorage chamber's stock, else the pool), meals and withdrawals — so no caller indexes the store directly. **Hunger** (`hunger.ts`, #288) is one clock for every ant that eats: the tick of its last meal plus a per-kind profile (meal interval, meal size, starve-after); from V51 workers and fighters eat from the colony's food like the queen and larvae, the queen first, and a hungry fighter away from home walks back to eat. **Raids** (`ant/ant-raid.ts`, V52) are automatic: a fighter rallied on an enemy's open entrance, below ground in that nest with nothing hostile in reach, loots one load from a FoodStorage stock (never the pool), hauls it home and deposits it through the facade; `fighterMayLoot` is the single "may this fighter loot?" predicate. From V60 (#352) the rally carries a **raid type** stored on the colony (`ColonyRecord.raidType`, `raid-order.ts`): Loot (the V53 rule), Deny, Spoil and Assault branch in `ant/ant-raid.ts`, and Blockade — fighters holding a surface ring round the enemy entrance instead of going in — is its own behaviour module, `ant/ant-blockade.ts` (tick step 10c2). Each colony counts food stolen, food lost to raids and completed raid hauls on its `ColonyRecord` (`foodRaidedFp`, `foodLostToRaidsFp`, `raidTrips`); the render layer's raid captions and the playtrace summary's `raidAggregate` read those counters, not events (the ant-activity panel counts the `Looting` / `Hauling` sub-states).
- **Combat** (`combat.ts`) — HP / damage / cooldown resolution for ants, queens, and the spider, with a home-ground damage bonus underground.
- **Health** (`health.ts`, #400 V71) — an ant's max HP by territory (higher on its home ground, underground in its own nest; HP clamps down when it leaves) and healing: every creature heals slowly while fed and safe (not hit for `HEAL_SAFE_TICKS`), ants only on home ground, the spider anywhere. Tick step 16f, after movement and before combat.
- **Spider** (`spider.ts`) — a neutral predator with a hunger clock, a telegraphed hunt reticle, chase / rampage / feed states, and danger-pheromone deposition; clamped to stay a margin inside the playfield.
- **AI state machine** (`ai-state.ts`) — the enemy colony moves through Peacetime → WarFooting → Probing → Invading → Recovery. The FSM *transitions* themselves (`advanceAIState`) run **in-sim** — tick step 18b, after the game-over check — so a tick()-only replay of the input log *reproduces* them rather than reading them back: nothing records them (the render-side `SyncAIState` echo that once mirrored the record into the log was retired in #258, and `src/render/ai-controller-replay-parity.integration.test.ts` pins the parity). Only the *policy* that issues commands lives in `src/render/ai-controller.ts`: it reads sim state and enqueues the same `SimCommand`s a player would (Principle 1 — same colony systems for player and AI).
- **Difficulty** (`scenario.ts`, `ai-state.ts`) — `Easy | Normal | Hard`, chosen at boot; tunes AI thresholds, spider hunger, and the egg interval.
- **Win / loss** (`game-over.ts`) — single-queen survival: `Victory` / `Defeat` / `MutualDestruction`, decided when a queen dies, plus a Stalemate tiebreak (no food on the map and both colonies starving). There is no time limit from simVersion V67 (#376); before V67 a Timeout tiebreak ended a match with both queens alive at tick 24 000 by living worker count.

### Platform — `src/platform/`

- **Game loop** (`game-loop.ts`) — the fixed-timestep accumulator (Principle 2), with pause/resume and 1× / 2× / 4× speed.
- **Save / load** (`save.ts`) — serialize/deserialize with boundary validation, 30-second autosave, and the versioning policy in Principle 7.

### Render / input — `src/render/`, `src/input/`

- Two Phaser scenes: `game-scene.ts` (game world, phase FSM, draw dispatch) and `ui-scene.ts` (HUD and overlays). Surface and underground terrain/entity draw modules, a pheromone overlay, the AI controller, and an optional end-of-game survey + playtrace upload (`playtrace-upload.ts`, gated on a non-empty resolved `playtraceEndpoint` — the `mount({ playtraceEndpoint })` option if set, else the `VITE_PLAYTRACE_ENDPOINT` build-time env var; empty disables it).
- Input translates keyboard/pointer into `SimCommand`s — the one-way flow of Principle 1.
- **E2E observability:** `window.__phase9_ui` exposes read-only HUD state, and a dev-only, tree-shaken `window.__phase9_test` seam exposes just enough for Playwright to drive and assert the game without reaching into simulation internals.

> See `AGENTS.md` for the contributor-facing review checklist (sim/render boundary, determinism, the pre-1.0 `simVersion` policy) these systems are held to.
