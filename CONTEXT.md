# Subterrans — Domain Glossary

The project's ubiquitous language: the terms specific to Subterrans, each with a
tight definition of what it **is** and the synonyms we've decided *not* to use.
When several words mean the same thing, this file picks the canonical one — match
it in code, comments, tests, commits, and PRs. This is vocabulary only; for *why*
decisions were made see the ADRs, and for *how* the systems fit together see
[ARCHITECTURE.md](ARCHITECTURE.md).

> Keep entries tight (1–2 sentences, define what it IS) and project-specific.
> General programming concepts don't belong here.

## Simulation core

**Sim / simulation** (`src/sim/`):
The pure, deterministic game logic — takes inputs, produces state.
_Avoid_: engine, backend, model.

**Tick**:
One fixed simulation step — 50 ms, 20 Hz. Game time is `tick × 50 ms`.
_Avoid_: frame (that's a render concept), update, step.

**WorldState**:
The complete in-memory state of one match — the single source of truth the sim
reads and writes. Most of it persists in a save, but some fields are **transient**
(e.g. telemetry `events`) and are not serialized / are reset on load.
_Avoid_: game state, world model; **snapshot** (= the *persisted projection* of WorldState).

**Fixed-point**:
Integer encoding of fractional quantities (1 tile = 256 units, `FP_SHIFT = 8`).
Sim math is integer-only for determinism.
_Avoid_: float position, decimal.

**simVersion**:
The behavior version stamped on a save; gates determinism-affecting changes and
is sticky on load (a save replays at the version it was written under). Distinct
from the save envelope's `version`.
_Avoid_: save version, schema version, format version.

**Sim/render boundary**:
The rule that `render/`, `input/`, and `platform/` **read** WorldState and
**enqueue commands** rather than mutating sim state. The one sanctioned exception:
the platform game loop drains `world.commandQueue` (a `splice`) before each tick.
Any other sim-state write from outside `src/sim/` is a hard block.
_Avoid_: separation of concerns (too generic).

## Entities & roles

**Colony**:
A single ant colony — the player's or the enemy/AI's — comprising its queen,
workers, food storage, and pheromone grids.
_Avoid_: team, faction; **nest** (nest = the dug-out physical area, not the colony itself).

**Queen**:
The single egg-laying ant per colony. Her death is that colony's loss condition.
_Avoid_: mother.

**Worker**:
Any **mature** non-queen ant (eggs and larvae are *brood*, tracked separately). A
worker takes on a **task** (`AntTask`: `Idle` / `Foraging` / `Digging` / `Fighting`
/ `Nursing`); "forager", "fighter", "nurse", "digger" name the *current task*, not
separate castes.
_Avoid_: drone, unit; do **not** treat forager/fighter/nurse/digger as distinct entity types.

**Forager**:
A worker on the `Foraging` task. Its `ForagingSubState` is `SearchingFood`,
`CarryingFood`, or `ReturningToNest` (three states — not a strict two-step).
_Avoid_: gatherer, harvester, scout.

**Fighter**:
A worker on the `Fighting` task.
_Avoid_: soldier, warrior.

**Nurse**:
A worker on the `Nursing` task, tending brood at the Nursery (auto-allocated, not
set by the player).
_Avoid_: caretaker.

**Digger**:
A worker on the `Digging` task: it claims a `Marked` tile (flipping it to
`BeingDug`) and excavates it to `Open`. Auto-dig assigns at most **one active
digger per colony**; if no worker is `Idle`, marked tiles wait rather than
preempting foragers or fighters.
_Avoid_: excavator, miner.

**Brood**:
Eggs and larvae collectively — tracked separately from (mature) workers. Lifecycle:
**egg** → **larva** → worker.
_Avoid_: babies, young; don't call eggs "larvae".

**Spider**:
The neutral predator. Not a colony — it threatens both colonies. Surface-only.
_Avoid_: monster, boss; **enemy** (enemy = the AI colony, not the spider).

## Structures & terrain

**Tile**:
One position in a terrain grid. Underground tiles (`UndergroundTileState`) progress
`Solid` → `Marked` (flagged to dig) → `BeingDug` → `Open`. Surface tiles
(`SurfaceTileState`) are `Grass` or `Dirt`; passability **features** (rocks, etc.)
are a separate overlay system, not tile states.
_Avoid_: cell, square, block.

**Zone**:
Which grid a coordinate lives in — `Surface` or `Underground`.
_Avoid_: layer, level.

**Chamber**:
A colony-placed underground space of a given `ChamberType` — `Queen`, `Nursery`,
or `FoodStorage` (player **and** AI place chambers via `PlaceChamber`). Note:
`nurseDeposit` is a Nursery-targeting **flow field**, not a chamber type.
_Avoid_: room.

**Entrance**:
A colony-designated surface→underground shaft (player **and** AI use
`DesignateEntrance`).
_Avoid_: hole, door.

**Tunnel**:
Connected `Open` underground tiles linking entrances and chambers.
_Avoid_: corridor, hallway, path.

**Pool** (entrance pool):
A colony's entrance-level food buffer (`colony.foodStored`, capped at
`BASE_FOOD_STORAGE_CAPACITY`) — distinct from per-chamber `FoodStorage`.
_Avoid_: stockpile, reserve.

## Foraging & pheromones

**Pheromone**:
A scalar field on a grid (`PheromoneType`). **FoodTrail** is the layer ants read to
bias foraging routes; **DangerTrail** is laid by the spider and decays, but is
**not** read by ant movement — it's a danger signal, not a routing input.
_Avoid_: trail (ambiguous on its own); **marker** (= the player's mark). **scent**
is a *different* mechanism (see below) — never a synonym for pheromone.

**Scent**:
Direct detection of nearby food — a distinct movement source from pheromone trails
(the `'scent'` source in ant routing / debug snapshots).
_Avoid_: using "scent" to mean pheromone.

**Food pile** (`FoodPile`):
A finite surface food source foragers harvest. When its pickups run out the pile is
**removed**; new piles spawn elsewhere over time (the same pile does not regenerate).
_Avoid_: food node, resource, deposit.

**Flow field**:
A BFS distance/direction field ants follow toward dig targets, entrances, or
chamber types (e.g. the `nurseDeposit` field that routes nurses to the Nursery).
_Avoid_: pathfinding grid, navmesh.

**Leash / search wave**:
The expanding radius bound on a `SearchingFood` forager's outward excursion.
_Avoid_: range, vision.

## Combat & threat

**Combat**:
HP / damage / cooldown resolution on contested tiles (ant vs ant, ant vs spider).
_Avoid_: battle; **fight** (fight = the task / behavior-ratio term, not the resolver).

**Spider behavior state** (`SpiderBehaviorState`):
The spider's state machine: `Patrolling`, `Hunting`, `Chasing`, `Striking`,
`Feeding`, `Rampaging`, `Retreating`.
_Avoid_: spider mode.

**Rampage**:
The spider's hungry surface hunt — it camps a colony entrance and eats ants.
(Stored food only influences *which* colony it targets; it doesn't consume stored food.)
_Avoid_: frenzy, attack.

**Reticle** (`scatterReticleTile`):
The spider's current target / scatter indicator — retained while `Hunting`,
`Striking`, and `Chasing`, not only just before a strike. **Telegraph** is
specifically the warning interval before the spider enters `Striking` (the strike
may still miss).
_Avoid_: conflating reticle (target indicator) with telegraph (pre-strike timing).

## Colony control (player → SimCommands)

**Mark** (`MarkDigTile`, `MarkFoodPile`, `MarkSpiderPriority`):
Flag a tile to dig, a food pile as priority, or the spider as a priority target.
(Other player commands: `CancelDigMark`, `SetBehaviorRatio`, `SetRallyPoint` /
`ClearRallyPoint`.)
_Avoid_: select, tag; **designate** (designate = entrances only).

**Designate** (`DesignateEntrance`):
Turn a surface tile into an entrance.
_Avoid_: mark, place.

**Place** (`PlaceChamber`):
Site a chamber for excavation.
_Avoid_: build, construct.

**Rally point** (`SetRallyPoint`):
A surface location fighters converge on.
_Avoid_: waypoint, muster, target.

**Behavior ratio** (`SetBehaviorRatio`):
The player's forage↔fight split for workers.
_Avoid_: allocation (**allocation** = the *computed* per-task worker counts the sim
derives from the ratio — not the same thing).

## AI & difficulty

**AI colony / enemy**:
The non-player colony, driven by the AI controller (a render-layer policy that
reads sim state and enqueues the same SimCommands a player would).
_Avoid_: bot, CPU.

**AI state** (`AIState`):
The enemy's strategic phase. Transitions: `Peacetime → WarFooting`; then
`WarFooting ↔ Probing` (a probe returns to WarFooting) and
`WarFooting → Invading → Recovery → Peacetime`.
_Avoid_: mode.

**Probe / invasion**:
The two AI operation **kinds** — `Probe` (a small raid) vs `Invasion` (a full
committed attack); while one runs, the colony is in the corresponding AI state
`Probing` / `Invading`.
_Avoid_: "attack" used alone (ambiguous); don't conflate the operation kind
(`Probe`/`Invasion`) with the AI state (`Probing`/`Invading`).

**Difficulty**:
The tier chosen at boot — `Easy` / `Normal` / `Hard` — which tunes AI rates,
spider hunger, and the egg interval.
_Avoid_: level, mode.

## Persistence

**Save / snapshot**:
The authoritative **persistent projection** of WorldState (transient fields like
telemetry `events` excluded). Authoritative on load — the snapshot is deserialized
directly, not re-derived from seed + input log.
_Avoid_: checkpoint.

**Input log / replay**:
The recorded SimCommand stream — **player and AI** — that reproduces a match
deterministically from its seed.
_Avoid_: history, journal.

**Autosave**:
The periodic save on a wall-clock timer (not a tick boundary).
_Avoid_: backup.
