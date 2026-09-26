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
Since **#299 (simVersion V40)** her tile never displaces a same-colony worker.
_Avoid_: mother.

**Worker**:
Any **mature** non-queen ant (eggs and larvae are *brood*, tracked separately). A
worker takes on a **task** (`AntTask`: `Idle` / `Foraging` / `Digging` / `Fighting`
/ `Nursing`); "forager", "fighter", "nurse", "digger" name the *current task*, not
separate castes.
_Avoid_: drone, unit; do **not** treat forager/fighter/nurse/digger as distinct entity types.

**Forager**:
A worker on the `Foraging` task. Its `ForagingSubState` is `SearchingFood`,
`CarryingFood`, or `ReturningToNest` (three states — not a strict two-step). Since
**#299 (simVersion V40)** a searching forager boxed in by its own recent-tiles memory
is released (one revisit) instead of pausing forever.
_Avoid_: gatherer, harvester, scout.

**Fighter**:
A worker on the `Fighting` task. Since **#299 (simVersion V40)** a colony below
`NURSE_MIN_WORKERS` living workers stands down fighters beyond its ratio's allocation
(one inside a foreign nest walks home as a fighter first).
_Avoid_: soldier, warrior.

**Sentry** (simVersion V43, #323):
A fighter with no orders — its colony has no rally point. It guards its colony's
nearest open entrance: it holds a post on the surface a few tiles from the entrance,
within sight of it, chases any enemy ant it sees near the entrance, and ducks down its
own shaft when the spider comes, climbing back out once the spider is well away
from the entrance (unless its colony has sent its fighters at the spider). Far from
the entrance, it walks home. With no orders it never goes down another colony's
entrance. From V47, when the colony has two or more fighters beyond what its ratio
asks for, sentries quietly holding their posts stand down and go back to work,
keeping one spare.
_Avoid_: **defender** for this; a rally on the colony's own entrance makes
fighters **tunnel defenders** instead.

**Tunnel defender** (simVersion V44, #325):
A fighter whose colony's rally point is on one of the colony's own open
entrances (unless the colony has sent its fighters at the spider). It goes down
that entrance and defends the nest from inside: it goes after any enemy ant in
the tunnels joined to that entrance, however deep, and otherwise waits at a post
in the tunnels just below the entrance. Moving the rally point off the colony's
own entrances, or clearing it, brings it back out.
_Avoid_: **guard**, **garrison**.

**Nurse**:
A worker on the `Nursing` task, tending brood at the Nursery (auto-allocated, not
set by the player). Since **#299 (simVersion V40)** a colony below
`NURSE_MIN_WORKERS` living workers assigns no nurses and releases the ones it has.
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

**Hunger / meal** (#288; workers and fighters from simVersion V51, #290):
Every ant that eats has a **hunger clock** — the tick of its last **meal**
(`ants.lastMealTick`; "ticks since meal" counts up) — and a **hunger profile** per
kind (`src/sim/hunger.ts`): how often a meal is due, how big it is, and how long
after its last meal a missed meal kills it (**starvation**). The queen and larvae
eat every tick from the colony's food. A worker (a **fighter** is a worker whose
task is `Fighting`, read at the moment of the meal) eats a meal from the colony's
food when it is **at home** — below ground in its own nest, or on the surface near
one of its own open entrances — or from the food it is carrying when away. The
colony feeds the queen first, then larvae, then workers: a worker's meal is skipped
if it would leave the colony's food below the queen's share
(`QUEEN_MEAL_RESERVE_FP`). A **hungry** fighter away from home and not fighting
walks home to eat, then goes back to its rally point or post. A starved ant leaves
no food behind. The spider keeps its own hunger clock and eats only its kills.
_Avoid_: **upkeep**, **rations** (except for eating from a carried load), **stamina**.

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
A colony's entrance-level food buffer, capped at `BASE_FOOD_STORAGE_CAPACITY` —
distinct from a FoodStorage chamber's **stock**. Since simVersion V50 (#290) both
are records in the **food store** (`world.food`, `src/sim/food/food-store.ts`): the
pool is a `Pool` record (`colony.poolSlot`), a chamber's stock a `Stock` record
(`chamber.foodSlot`), and surface **food piles** are `Pile` records. Read and
write them only through the food facade (`src/sim/food/food-api.ts`).
_Avoid_: stockpile, reserve.

## Foraging & pheromones

**Pheromone**:
A scalar field on a grid (`PheromoneType`). **FoodTrail** is the layer ants read to
bias foraging routes; **DangerTrail** is laid by the spider (and the V34 cross-colony
kill alarm) and decays. Since **A1 (simVersion V36)** DangerTrail is also a *routing*
input: SearchingFood foragers penalize a candidate step's FoodTrail by that cell's
DangerTrail (`sampleForagingDirection`) and softly steer wandering routes away from it,
gated so pre-V36 replays never consult it. (Lethal-proximity danger is handled
separately by the V34 flee behavior, not routing — and since **#297 (simVersion
V38)** that flee's homebound hold is bounded by the threat rather than by time: a
homebound forager is released once its own tile has decayed clear, or once it is within
`FLEE_HOMEBOUND_PUSH_THROUGH_TILES` of an own entrance that is open and not
spider-blockaded, so a camped door starves no colony.)
_Avoid_: trail (ambiguous on its own); **marker** (= the player's mark). **scent**
is a *different* mechanism (see below) — never a synonym for pheromone.

**Scent**:
Direct detection of nearby food — a distinct movement source from pheromone trails
(the `'scent'` source in ant routing / debug snapshots).
_Avoid_: using "scent" to mean pheromone.

**Food pile** (a `Pile` record in the food store):
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

**Colony alarm** / **all-clear** (`SetColonyAlarm`, `ColonyRecord.alarmActive`):
The player's recall-to-nest stance. While the alarm sounds, every SURFACE civilian
of that colony flees underground as though its own tile were dangerous and stays
sheltered; the all-clear ends it. Sheltering workers are skipped by allocation, so
an alarmed colony neither forages nor can recruit those workers as fighters.
_Avoid_: **kill alarm** — that is the unrelated V34 signal a cross-colony kill
deposits on the DangerTrail grid (`KILL_ALARM_DANGER_DEPOSIT`), which the sim
raises by itself and the player never touches. Say "colony alarm" for the stance
and "kill alarm" for the pheromone pulse; never bare "alarm" where both could read.

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
