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
The entire serializable state of one match. The single source of truth the sim
reads and writes.
_Avoid_: game state, world model, snapshot (snapshot = a *saved* WorldState).

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
**enqueue commands** but never mutate it. A direct sim-state write from outside
`src/sim/` is a hard block.
_Avoid_: separation of concerns (too generic).

## Entities & roles

**Colony**:
One ant faction — the player's or the enemy/AI's — with a queen, workers, food
storage, and pheromone grids.
_Avoid_: team, faction; **nest** (nest = the dug-out physical area, not the faction).

**Queen**:
The single egg-laying ant per colony. Her death is that colony's loss condition.
_Avoid_: mother.

**Worker**:
Any non-queen ant. A worker takes on a **task** (forage / fight / dig / nurse) —
"forager", "fighter", "nurse" name the *current task*, not separate castes.
_Avoid_: drone, unit; do **not** treat forager/fighter/nurse as distinct entity types.

**Forager**:
A worker on the food-gathering task (`SearchingFood` → `CarryingFood`).
_Avoid_: gatherer, harvester, scout.

**Fighter**:
A worker on the combat task.
_Avoid_: soldier, warrior.

**Nurse**:
A worker tending brood at the Nursery (auto-allocated, not set by the player).
_Avoid_: caretaker.

**Brood**:
Eggs and larvae collectively. Lifecycle: **egg** → **larva** → worker.
_Avoid_: babies, young; don't call eggs "larvae".

**Spider**:
The neutral predator. Not a colony — it threatens both colonies. Surface-only.
_Avoid_: monster, boss; **enemy** (enemy = the AI colony, not the spider).

## Structures & terrain

**Tile**:
One grid cell. Underground tiles are `Solid`, `Marked` (to dig), or `Open` (dug).
_Avoid_: cell, square, block.

**Chamber**:
A player-placed underground room of a type: `Queen`, `FoodStorage`, `Nursery`,
or `NurseDeposit`.
_Avoid_: room.

**Entrance**:
A player-designated surface→underground shaft connecting the surface to tunnels.
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
A scalar field on a grid that biases ant routing. Two types: **FoodTrail** and
**DangerTrail** (the spider lays DangerTrail).
_Avoid_: scent, trail (ambiguous on its own); **marker** (marker = the player's mark).

**Flow field**:
A BFS distance/direction field ants follow toward dig targets, entrances, or
chamber types.
_Avoid_: pathfinding grid, navmesh.

**Leash / search wave**:
The expanding radius bound on a `SearchingFood` forager's outward excursion.
_Avoid_: range, vision.

## Combat & threat

**Combat**:
HP / damage / cooldown resolution on contested tiles (ant vs ant, ant vs spider).
_Avoid_: battle; **fight** (fight = the task / behavior-ratio term, not the resolver).

**Rampage**:
The spider's hungry surface hunt for ants/food.
_Avoid_: frenzy, attack.

**Reticle / telegraph**:
The spider's on-screen hunt warning shown before it strikes.
_Avoid_: warning, marker.

## Colony control (player → SimCommands)

**Mark** (`MarkDigTile`, `MarkFoodPile`):
Flag a tile to dig, or flag a food pile as priority.
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

**Behavior ratio**:
The player's forage↔fight split for workers.
_Avoid_: allocation (**allocation** = the *computed* per-task worker counts the sim
derives from the ratio — not the same thing).

## AI & difficulty

**AI colony / enemy**:
The non-player colony, driven by the AI controller (a render-layer policy that
reads sim state and enqueues the same SimCommands a player would).
_Avoid_: bot, CPU.

**AI state**:
The enemy's strategic phase: `Peacetime` → `WarFooting` → `Probing` → `Invading`
→ `Recovery`.
_Avoid_: mode.

**Probe / invasion**:
A small AI raid (`Probe`) versus a full committed attack (`Invasion`).
_Avoid_: "attack" used alone (ambiguous between the two).

**Difficulty**:
The tier chosen at boot — `Easy` / `Normal` / `Hard` — which tunes AI rates,
spider hunger, and the egg interval.
_Avoid_: level, mode.

## Persistence

**Save / snapshot**:
The serialized WorldState. The snapshot is authoritative on load (load does not
re-derive from seed + input log).
_Avoid_: checkpoint.

**Input log / replay**:
The recorded SimCommand stream — **player and AI** — that reproduces a match
deterministically from its seed.
_Avoid_: history, journal.

**Autosave**:
The periodic save on a wall-clock timer (not a tick boundary).
_Avoid_: backup.
