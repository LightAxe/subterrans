# Subterrans — Contributor Guide

A modern ant colony simulation game — a spiritual successor to SimAnt (1991) with a retro pixel aesthetic and contemporary design.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Rendering:** Phaser 3
- **Testing:** Vitest (unit/integration), Playwright (browser/E2E)
- **Build:** Vite (tentative, finalized during PRD)
- **Target:** Web browsers (Chrome, Firefox, Safari, Edge — latest two versions)

## Directory Layout

```
src/
  sim/        # Pure TypeScript simulation. SACRED BOUNDARY — no Phaser, no DOM, no browser APIs.
  render/     # Phaser-specific rendering. Reads sim state, never writes to it.
  input/      # Translates browser/device input into simulation commands.
  platform/   # Platform abstractions: storage, audio stubs, feature detection.
assets/
  sprites/    # Sprite sheets and tilesets (Phase 2; Phase 1 uses Graphics API).
  audio/      # Sound effects and music (Phase 2).
  fonts/      # Custom fonts.
docs/         # Additional documentation for contributors.
```

## Architectural Principles (Summary)

These are non-negotiable. See [ARCHITECTURE.md](ARCHITECTURE.md) for full explanations and code examples.

1. **Strict sim/render separation** — `src/sim/` has zero dependencies on Phaser, the DOM, or any browser API. It must run in Node.js unchanged.
2. **Fixed 20 Hz timestep** — Simulation advances exactly 50ms per tick. Rendering interpolates at display framerate. Variable delta time is forbidden.
3. **Lightweight ECS-flavored architecture** — Entities are integer IDs, components are typed arrays or maps, systems are pure functions. No classes for entities. No ECS library in Phase 1.
4. **Seeded deterministic PRNG** — Single Mulberry32 instance per world. `Math.random()` is banned in `src/sim/`.
5. **No wall-clock time in simulation** — `Date`, `performance.now()`, and all real-time APIs are banned in `src/sim/`. Time = tick count.
6. **Fixed-point integer math** — All simulation quantities are integers (1 tile = 256 units). Floats are banned in `src/sim/`.
7. **Snapshot saves with replay logging** — JSON world snapshots + input log. Same seed + same inputs = same output.

## Multi-Platform Constraints

Phase 1 targets web only. The architecture preserves portability for native wrappers (Capacitor, Tauri) in later phases.

**Banned in `src/sim/`:** Any browser API, any rendering API, `Math.random()`, `Date`/`performance.now()`, floating-point arithmetic.

**Banned in `src/render/` and `src/input/`:** Direct writes to simulation state. These layers read sim state and produce commands; they never mutate it.

**Abstraction boundary:** Platform-specific concerns (storage, audio, input devices) go through `src/platform/`, which exposes a stable interface that `src/sim/` never imports. Only `src/render/`, `src/input/`, and the top-level game loop import from `src/platform/`.

## Testing Requirements

- **`src/sim/`**: Full test coverage. Every system function, every component store operation, every edge case. These are pure functions operating on data — they are trivially testable.
- **`src/render/`, `src/input/`, `src/platform/`**: Smoke tests. Verify initialization, basic rendering, input translation.
- **Deterministic replay tests**: A recorded input sequence + seed must always produce the same final world state. These tests catch non-determinism bugs.
- **All tests run in CI** on every push and PR.

## Branching & PR Workflow

**All changes — including doc-only and one-line fixes — go through a feature branch and a pull request.** Direct pushes to `main` are not the path here, even when admin bypass is technically available. The `main` branch is protected: PR required, ≥1 approving review, force-pushes blocked, branch deletion blocked.

Branch names: `feat/<short-description>`, `fix/<short-description>`, `chore/<short-description>`, `docs/<short-description>`. Open the PR against `main`, fill in the summary and test plan, and wait for review. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full mechanics.

This applies to AI agents working in this repo as well as human contributors. The size of the change is not the criterion.

## PR Review Process

Every PR is reviewed by at least two independent AI code reviewers:

1. **Architectural review** — Uses the `subterrans-pr-review` skill (architectural compliance, principle violations, code quality).
2. **Independent review** — A second agent providing an independent perspective.

Either reviewer can block; both must approve for merge (or owner override). The review checklist includes:

- [ ] No imports crossing the `src/sim/` boundary
- [ ] No `Math.random()`, `Date`, `performance.now()` in `src/sim/`
- [ ] No floating-point arithmetic in `src/sim/`
- [ ] No classes for simulation entities
- [ ] No variable timestep usage
- [ ] Tests cover new simulation logic
- [ ] Deterministic replay is not broken (replay tests pass)

## Review guidelines

These rules are addressed to AI code reviewers inspecting pull requests.

**Be adversarial.** Push back hard on anything that differs from the requirements below or from established best practice. Do not soften criticism, do not assume the author had a good reason, and do not skip a finding because the diff is small or the author is the project owner. A useful review surfaces problems the author missed; a polite review that approves a violation is worse than no review at all. If a rule below is violated, say so plainly and block the PR — do not bury the finding in a list of nits.

Use strong language deliberately — these are non-negotiable invariants of the codebase, not style preferences. Block the PR on any violation in the **Determinism** or **Sim/Render boundary** sections; flag the rest as actionable comments.

### Determinism (sim/ only)

- The directory `src/sim/` must remain deterministic. Any new non-determinism source is a blocker.
- `Math.random()` is forbidden in `src/sim/`. All randomness must go through the seeded Mulberry32 PRNG (`src/sim/rng.ts`). Flag any `Math.random` reference under `src/sim/` regardless of context.
- Wall-clock APIs are forbidden in `src/sim/`: `Date`, `Date.now()`, `performance.now()`, `setTimeout`, `setInterval`, `requestAnimationFrame`. Time in the simulation is tick count, not real time.
- Floating-point arithmetic is forbidden in `src/sim/`. All quantities are fixed-point integers using `FP_SHIFT = 8` / `FP_ONE = 256` (see `src/sim/fixed.ts`). Float literals (`1.5`, `0.1`), the division operator (`/`), and `Math.sqrt`/`sin`/`cos`/`atan2` are banned. The ESLint `simSafetyConfig` enforces this; review still reads PRs that disable the rule inline.
- Every PRNG call must be seeded from the world's RNG instance — never construct a fresh `Mulberry32` per call site, and never thread a literal seed through new code without explaining why in the PR description.

### Sim/render boundary (FNDN-04, FNDN-07)

- `src/sim/` must not import from `src/render/`, `src/input/`, `src/platform/`, `phaser`, or any browser global (`window`, `document`, `localStorage`, `navigator`, `fetch`). This is enforced by `eslint.config.ts` and the `scripts/check-sim-boundary.sh` grep backstop — flag any change that loosens either.
- `src/render/`, `src/input/`, and `src/platform/` must not mutate `WorldState` or any nested simulation store. They read sim state and enqueue commands via `commandQueue` (`src/sim/commands.ts`). A direct write to a sim store from outside `src/sim/` is a blocker even if tests pass.
- New code under `src/sim/` must run unchanged in Node.js — no DOM types, no `HTMLElement`, no Phaser scene references. If a file under `src/sim/` needs a browser API, the design is wrong; suggest moving the logic to `src/platform/` or `src/render/`.

### Fixed timestep

- Simulation advances exactly 50 ms per tick (20 Hz). Code under `src/sim/` must not accept or branch on a `dt` / `deltaTime` / `elapsed` parameter. Variable timestep is a blocker.
- Interpolation for rendering is the responsibility of `src/render/` and reads the *previous* and *current* tick snapshots — flag any render code that mutates sim state to "smooth" a frame.

### ECS conventions

- Entities are integer IDs (`EntityId = number`). Do not introduce `class Ant`, `class Pheromone`, or other entity classes — components live in typed-array stores (`Int32Array`, `Uint8Array`) or `Map<EntityId, T>`, not on instances.
- Systems are pure functions over component stores. A new `src/sim/` module that holds mutable module-level state outside the world snapshot is a blocker — that state will not survive save/load or replay.
- New components should follow the structure-of-arrays pattern already used in `src/sim/ant/`, `src/sim/colony/`, `src/sim/pheromone/`. Flag array-of-structs designs unless the PR explains why SoA is impractical for that data.

### Hot-loop performance

- Per-tick loops over entities (ant updates, pheromone diffusion, combat resolution) run thousands of times per second. Flag allocations inside these loops: `new Array`, `[...spread]`, object literals, `.map`/`.filter`/`.reduce` chains that create intermediate arrays, closure creation. Reuse pre-allocated buffers from the world struct.
- `JSON.stringify` / `JSON.parse` and regex construction inside per-tick code paths are blockers. They belong in save/load, not the tick loop.

### Test coverage

- Any new logic under `src/sim/` must ship with Vitest unit tests in the same PR. Untested sim code is a blocker, not a follow-up.
- Changes to tick-order, command application, save format, or PRNG usage must include or update a deterministic replay test. If the PR claims "replay still works" without a test demonstrating it, ask for one.
- Render/input/platform changes need at least a smoke test (initialization + one happy path). Full coverage is not required at those layers.

### Asset paths and build hygiene

- Runtime asset URLs in `src/render/` must be built from `import.meta.env.BASE_URL` (or the `assetsBase` registry value plumbed via `mount()`), never hard-coded as root-absolute (`/assets/...`) or relative (`./assets/...`). Hard-coded paths break the embedded library build at non-root deploy paths. See `vite.lib.config.ts` and `src/main.ts`.
- The library entry point is `src/main.ts`. Adding new top-level exports there expands the public API surface — flag undocumented additions and ask for a JSDoc block matching the existing `MountOptions` / `MountedGame` / `mount` style.

## Building and Running

```bash
cd code/
npm install
npm run dev       # Start dev server (once scaffold is in place)
npm run test      # Run Vitest
npm run test:e2e  # Run Playwright
```

## Debugging snapshots (F9 exports)

In-game, `F9` downloads a debug snapshot (`subterrans-debug-seed<seed>-tick<tick>.json` — seed, tick, full input log, world snapshot, per-ant trace). To analyze one offline:

```bash
node --experimental-transform-types scripts/analyze-snapshot.ts <snapshot.json>
```

The CLI replays the recorded inputLog from seed and byte-compares the result against the captured snapshot (a free SCEN-06 determinism check — exits 1 on regression), then reports tile-occupancy clusters, underground ants stuck on non-Open tiles, and stationary / oscillating ants from a per-ant motion history sampled during replay. Each motion group is annotated with its dominant `(task, subTask)` so a real bug stands out from expected stuck cases. See PR #121 for the design notes.

## Playtrace upload (issue #122 / ADR 0013)

End-of-game survey overlay with an opt-in debug-snapshot upload. **Disabled by default** — the survey overlay and the pause menu's "Quit & feedback" row are hidden when the `VITE_PLAYTRACE_ENDPOINT` env var is unset or empty, and `npm run build` produces a bundle with the feature off.

To exercise the upload flow on localhost without standing up the website's Lambda + S3 stack:

```bash
cd code/
cp .env.example .env.local
# uncomment VITE_PLAYTRACE_ENDPOINT=/api/playtrace in .env.local
npm run dev
```

The dev server has a built-in mock for `POST /api/playtrace` (see `vite.config.ts` — `playtraceMockPlugin`). Play to game-over (or use the pause menu's "Quit & feedback" entry), fill in the survey, and hit Submit. The dev-server terminal prints a one-line summary of the received envelope plus a pretty-printed JSON dump (snapshot elided). The mock returns the same `202 + { accepted, sessionId }` body the production Lambda will return.

## Note

This repository is the public, open-source portion of a larger project. Research, planning, and internal design documents live in a separate private repository.
