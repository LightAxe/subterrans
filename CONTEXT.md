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
Since **#376 (simVersion V67)** a match has no time limit: it goes on until a queen
dies (or, rarely, a stalemate: no food on the map and both colonies starving). Before
V67 a match with both queens alive at tick 24 000 (20 minutes) ended there, won by
the colony with more workers (a draw on equal counts).
Since **#299 (simVersion V40)** her tile never displaces a same-colony worker.
_Avoid_: mother.

**Worker**:
Any **mature** non-queen ant (eggs and larvae are *brood*, tracked separately). A
worker takes on a **task** (`AntTask`: `Idle` / `Foraging` / `Digging` / `Fighting`
/ `Nursing`); "forager", "fighter", "nurse", "digger" name the *current task*, not
separate castes. An `Idle` worker on the surface **mills** near its colony's entrance;
since **#343 (simVersion V55)** one walking back from beyond home range routes round
obstacles on the colony's surface entrance flow field (it keeps its straight-line step
while any of its colony's open entrances is camped).
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
A fighter with no orders — its colony has no rally point (from V64, #372, also a
fighter outside an AI probe's cohort: see **Probe / invasion**). It guards its colony's
nearest open entrance: it holds a post on the surface a few tiles from the entrance,
within sight of it, chases any enemy ant it sees near the entrance, and ducks down its
own shaft when the spider comes, climbing back out once the spider is well away
from the entrance (unless its colony has sent its fighters at the spider). Far from
the entrance, it walks home. With no orders it never goes down another colony's
entrance. From V47, when the colony has two or more fighters beyond what its ratio
asks for, sentries quietly holding their posts stand down and go back to work,
keeping one spare. From V64 (#372), while its nest is **breached** it defends it
(**automatic defence**, below), and surplus sentries do not stand down.
_Avoid_: **defender** for this; a rally on the colony's own entrance makes
fighters **tunnel defenders** instead.

**Automatic defence / breached entrance** (simVersion V64, #372):
While an enemy ant is below ground in a colony's nest, in the part one of its open
entrances' shafts reaches, the nest is **breached**. The **breached entrance** is
the first open entrance of the part of the nest the intruders are in (so it does not
move as they wander); if intruders are in unconnected parts, the part already holding
the most of the colony's fighters below (the defenders stay with their fight), then
the one nearest an intruder, then the lower entranceId. Every fighter
of the colony with **no orders** — its sentries, at any entrance — then defends the
breached entrance exactly as a **tunnel defender** of it would: it walks there (not
stopping for enemies on the surface or taking cover from the spider, nor going down
any other shaft, as a tunnel defender does not), goes down and hunts the intruders. (One cut off below in a part
the breached shaft does not reach climbs out and walks round, and, having no orders,
still waits below while the spider is near its door, as a sentry does.) Fighters with orders
(a rally, a raid, a probe's cohort, the spider order) keep them. Once no intruder is
left the defenders are sentries again and go back to their posts. The same for
every colony (CLNY-08), the player's and the AI's alike.
_Avoid_: **alarm** (the colony alarm is the player's recall stance), **garrison**.

**Tunnel defender** (simVersion V44, #325):
A fighter whose colony's rally point is on one of the colony's own open
entrances (unless the colony has sent its fighters at the spider). It goes down
that entrance and defends the nest from inside: it goes after any enemy ant in
the tunnels joined to that entrance, however deep, and otherwise waits at a post
in the tunnels just below the entrance. Moving the rally point off the colony's
own entrances, or clearing it, brings it back out. Since **#357 (simVersion V57)**
one walking across the surface to that entrance routes round obstacles, by a field
leading to that entrance itself (not the nearest open one: a tunnel defender may go
down only the entrance it defends). Since **#371 (simVersion V62)** tunnel
defenders after invaders spread over them — each goes for the nearest invader by
path whose tile no nestmate already holds the duel on (the #364 rule invaders use;
in its own nest only a fighter, or an ant that combat would pair first, counts) —
instead of stacking on the nearest one; and the rule-based AI defends a **raid**
(an enemy fighter in its nest, or two or more on the surface near its entrances):
it rallies on the threatened entrance while raiders are inside or it is not
stronger at home, otherwise it sallies at the nearest raider, and clears the rally
when they are gone. A raid holds the AI's probes and invasions — with no enemy
inside, for 60 s at most, so fighters parked by the door cannot stop it attacking.
_Avoid_: **guard**, **garrison**.

**Nurse**:
A worker on the `Nursing` task, tending brood at the Nursery (auto-allocated, not
set by the player). Since **#299 (simVersion V40)** a colony below
`NURSE_MIN_WORKERS` living workers assigns no nurses and releases the ones it has.
Since **#343 (simVersion V55)** a nurse walking to its nest across the surface routes
round obstacles on the colony's surface entrance flow field instead of stepping straight
at the entrance.
_Avoid_: caretaker.

**Digger**:
A worker on the `Digging` task: it claims a `Marked` tile (flipping it to
`BeingDug`) and excavates it to `Open`. Auto-dig assigns at most **one active
digger per colony**; if no worker is `Idle`, marked tiles wait rather than
preempting foragers or fighters. A digger on the surface walks to the nearest of
its colony's entrances, closed (designated, not yet dug through) ones included;
since **#358 (simVersion V57)** it routes round obstacles on the way, to the entrance
nearest by path.
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
walks home to eat, then goes back to its rally point or post. Since **#363
(simVersion V58)** a **starving** one — within 600 ticks of starvation
(`FIGHTER_STARVING_TICKS`; not the hunger profile's lethal `'starving'` state) —
walks home from a fight too, when home can feed it. Since **#375 (simVersion
V66)** the **queen** starves by losing health: while she cannot eat she loses 1 HP
every 10 ticks and dies of starvation at 0 HP, so a full-HP queen lasts the same
300 ticks and a wounded one less. A meal stops the loss, and while she is fed she
slowly **regenerates** lost HP — combat wounds too — up to full, so a short hunger
burst heals back but a long famine still kills.
The HUD's queen bar is her HP. Larvae, workers and fighters still die outright at
their starvation tick. A starved ant leaves
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
`nurseDeposit` is a Nursery-targeting **flow field**, not a chamber type. Since
**#374 (simVersion V63)** the rule-based AI digs its Queen chamber at least a third
of the way down the underground grid while its first FoodStorage (the larder) stays
by the entrance, so a raid meets the food before the queen; a player places their own.
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

**Food store / stock** (#290):
The **food store** is where every unit of food lives (`world.food`): one record
per colony's entrance **pool**, per FoodStorage chamber and per surface **food
pile** (piles belong to no colony). A FoodStorage chamber's **stock** is the food held in that chamber; a
colony's food total is its pool plus its stocks. Food is only ever in the store or
in an ant's carried load.
_Avoid_: **food store** for the FoodStorage chamber itself (that is a chamber; its
contents are its stock); inventory, bank. **Larder** is player-facing caption copy
for an enemy's FoodStorage chambers ("raid the larder"), not a code term.

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
Since **#395 (simVersion V69)** map generation gives every colony food of its own
near home: piles holding at least `FOOD_FAIRNESS_MIN_PICKUPS` (40) pickups between
them within `FOOD_FAIRNESS_RADIUS_TILES` (25) tiles, by surface path, of one of its
open entrances. A pile within that range is a colony's own when no other colony's
open entrance is as near it. A colony short of that has a pile moved into that range:
the nearest pile of at least 40 pickups that is no colony's own, preferring one nearer
it than any other colony (its own side of the map) — same pile, same size, so the
map's pile count and food total do not change; only if there is no such pile is a new
one made. Piles that spawn during play are placed as before.
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
One pair fights per tile per tick: the lowest-id ant of each colony on it. A tile
is **saturated** for a fighter when its colony already holds the fight there
(another of its ants stands on it; on the fighter's own tile, one with a lower
id). Since **#364 (simVersion V59)** an invader goes after the nearest enemy (by
tunnel) whose tile is not saturated, instead of queuing behind a duel its colony
already holds, and such a duel no longer stops a raider looting.
_Avoid_: battle; **fight** (fight = the task / behavior-ratio term, not the resolver).

**Raid / looting / hauling** (simVersion V52; V53 no loot with full stores, #290):
Fighters **steal food** from an enemy's FoodStorage chambers. A **raid** is
automatic: a colony's fighters rallied on an enemy entrance go down it, and below
ground each one **loots** (`FightingSubState.Looting`) when nothing hostile — an
enemy worker or the queen, not brood — is within a few tiles of it by tunnel and a
FoodStorage chamber there holds food it can reach. It takes one load from the
chamber's **stock** and **hauls** it (`Hauling`): out of the enemy nest, home
across the surface, down its own entrance, into its own FoodStorage chamber (or
pool), then back to its rally point. A hostile in reach is fought first; once the
chambers are empty the fighters go for the queen. From V53 a fighter loots only if
its **own** colony has room for the loot: it starts only when the space its stores
can still take in (the pool's headroom plus the free space of each FoodStorage
chamber that still accepts deposits; a nearly full chamber takes none), after the
loads its colony's raiders already carry or are going for, holds one more load,
and a looter stops once there is nowhere at all to put food. Otherwise it hunts
instead; a hauler already carrying still brings its load home. The entrance
**pool** is never raided. A hauler that dies drops its load (on the surface as a food pile; in the
enemy nest into that colony's pool). Every "may this fighter loot?" rule lives in
one predicate (`fighterMayLoot`, `src/sim/ant/ant-raid.ts`). The player sees raids through **captions** (being
raided, raiding, a haul home), a **carried-food** crumb on every laden ant, and the
raiding / hauling counts in the ant-activity panel. Since **#352 (simVersion V60)**
what a raid does is its **raid type** (below); the rule above is **Loot**.
_Avoid_: **raid** for an AI `Probe` (a probe is a small attack, below); **plunder**,
**pillage**, **steal order**.

**Raid type / raid order** (`RaidType`, simVersion V60, #352):
What a colony's fighters do at an enemy entrance its rally is on — stored on the
colony with its rally, chosen from the **raid menu** (right-click or long-press an
enemy entrance); a plain tap rallies with **Loot**. One raid at a time: a new rally
replaces the old one, and clearing it resets the type. **Loot** steals while its own
stores have room; **Deny** steals regardless, leaving what its stores cannot hold as
a food pile beside its own entrance; **Spoil** destroys the enemy's stored food where
it lies; **Blockade** (below) never goes in; **Assault** ignores food and goes for
the queen. Loot, Deny and Spoil go for the queen too once there is nothing left to
take (Loot with full stores keeps hunting while the enemy still has food). On the
way to her they fight only what they meet on their tile or what attacks them. While a
friend already holds the queen's tile, a raider going for her takes on a free enemy
worker in sight, if there is one, else it queues for the queen.
The AI always raids with Loot.
_Avoid_: **raid mode**, **stance** (stance = the colony alarm), **attack type**.

**Blockade** (raid type, simVersion V60, #352):
Fighters that hold a ring of posts on the surface round an enemy entrance instead of
going down it, and attack every enemy ant — fighters included — that comes within a
few tiles of it; one that leaves is let go and they return to their posts.
_Avoid_: **siege**, **camp** (camp = the spider's rampage on an entrance).

**Spider behavior state** (`SpiderBehaviorState`):
The spider's state machine: `Patrolling`, `Hunting`, `Chasing`, `Striking`,
`Feeding`, `Rampaging`, `Retreating`.
_Avoid_: spider mode.

**Rampage**:
The spider's hungry surface hunt — it camps a colony entrance and eats ants.
(Stored food only influences *which* colony it targets; it doesn't consume stored food.)
A rampage gives up after `SPIDER_RAMPAGE_MAX_TICKS` without a kill (it **times out**).
Since **#337 (simVersion V54)** a timed-out spider moves on: its next rampage camps the
next open entrance by `entranceId` (across both colonies, wrapping), and it keeps
**rotating** that way until it kills an ant. If the entrance it left is the only open one
in the world, it may camp it again only `SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS` later, and
patrols and hunts meanwhile. So a colony sheltering underground gets a window to come out.
The spider is **on a rampage** (`spiderOnRampage`, the window the rampage caption
covers) from the moment it grows hungry until it eats (or dies). That can span several
camps: the `Rampaging` state, its timeout and its rotation above each count one camp at
one entrance, and between camps (or when an ant comes near) it chases, hunts or
patrols, still hungry, until it has eaten.
_Avoid_: frenzy, attack.

**Rampage shelter** (simVersion V68, #377):
While the spider is on a rampage and **threatens** a colony — it is camping, or on its
way to camp, one of the colony's entrances, or it is within its hunt-search radius (12
tiles) of one of them, whatever it is doing — that colony's **Idle** workers on the
surface go in and shelter at the shaft top until the threat is over; a colony it is not
threatening keeps its idle reserve out, as before (foragers keep working; fighters,
nurses and diggers are untouched). Each heads for the nearest of its colony's open
entrances by path that reads no real danger and whose way there keeps out of the
spider's reach (it is not within its chase radius of the way, door included — judged
conservatively); with none, it holds where it stands until one opens up (keeping its
scatter step within the scatter radius of the hunt reticle). Once the spider is within
chase range of it, every way is within its reach, so it runs for the nearest such
entrance whose next step in lands no nearer the spider than it stands (re-chosen every
tick), and holds if there is none: its steps never end nearer the spider (a diagonal may
dip one tile nearer for a tick), and a friend jostling a holder off its tile moves it
only to a tile no nearer the spider. With the spider on its own tile it runs whatever
its door reads. An idle worker coming up the shaft is held below too. They stay
recruitable: the behaviour ratio still turns them into fighters, nurses, diggers or
foragers. Once the spider eats, dies or moves off, the first poke-out whose exit reads
no real danger lets them out. While the colony alarm sounds, the alarm governs its
civilians as before.
_Avoid_: **alarm** (the colony alarm is the player's stance), **flee** (the dash to an
entrance from danger on the ant's own tile).

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
A surface location fighters converge on — every fighter of the colony, except that
an AI probe's rally applies only to the probe's cohort (V64, #372). A rally on an enemy's open entrance sends
them into that nest, where they fight and **raid** (see **Raid**); since V60 it
carries a **raid type**. Clearing the rally
**recalls** them; since **#346 (simVersion V55)** a recalled invader walks out of the
enemy nest by the wall-aware route to the first open entrance it can reach, so a bend
in the tunnel no longer pins it.
_Avoid_: waypoint, muster, target.

**Behavior ratio** (`SetBehaviorRatio`):
The player's forage↔fight split for workers.
_Avoid_: allocation (**allocation** = the *computed* per-task worker counts the sim
derives from the ratio — not the same thing).

**Colony alarm** / **all-clear** (`SetColonyAlarm`, `ColonyRecord.alarmActive`):
The player's recall-to-nest stance. While the alarm sounds, every SURFACE civilian
of that colony flees underground as though its own tile were dangerous and stays
sheltered; the all-clear ends it. An alarmed colony puts no worker to foraging,
digging or nursing. Up to V64 it recruited no fighters either; from **V65** (#373)
the **behavior ratio** always wins: Idle workers, sheltering ones included, are still
recruited as fighters when the ratio asks for them (as are empty foragers the alarm
holds below), and the alarm governs only the civilians left.
_Avoid_: **kill alarm** — that is the unrelated V34 signal a cross-colony kill
deposits on the DangerTrail grid (`KILL_ALARM_DANGER_DEPOSIT`), which the sim
raises by itself and the player never touches. Say "colony alarm" for the stance
and "kill alarm" for the pheromone pulse; never bare "alarm" where both could read.

**Shelter retreat** (simVersion V65, #373):
While an enemy ant is below ground in a colony's nest, its **shelterers** (workers
holding underground on the flee timer — at the shaft top under the colony alarm or
after a flee) walk by tunnel path to the chamber farthest from the invaders, one per
connected part of the nest, unless they already stand farther from them. The way
there never runs through or beside an invader; where it would, they hold. While they
retreat they keep sheltering; once the nest is clear, any shelterer below the
shaft-top row stops sheltering where it stands. A shelterer left at the shaft top
keeps the ordinary poke-out. Workers not sheltering and the queen do not move for
it. With no intruder inside, shelterers wait at the shaft top as before.
_Avoid_: **flee** (that is the surface dash to an entrance), **evacuate**.

## AI & difficulty

**AI colony / enemy**:
The non-player colony, driven by the AI controller (a render-layer policy that
reads sim state and enqueues the same SimCommands a player would).
_Avoid_: bot, CPU.

**AI state** (`AIState`):
The enemy's strategic phase. Transitions: `Peacetime → WarFooting`; then
`WarFooting ↔ Probing` (a probe returns to WarFooting) and
`WarFooting → Invading → Recovery → Peacetime`.
An AI colony sizes itself against, probes and invades its **opponent** — the player,
for the enemy (the only AI in play). When the controller also drives the player
colony (`check:ai-economy --both-ai`), that colony's opponent is the enemy; since
**#347 (simVersion V56)** its Peacetime→WarFooting frontage check reads the enemy's
workers too (up to V55 it compared its workers with its own).
_Avoid_: mode.

**Probe / invasion**:
The two AI operation **kinds** — `Probe` (a small attack) vs `Invasion` (a full
committed attack); while one runs, the colony is in the corresponding AI state
`Probing` / `Invading`. A probe rallies its fighters on a surface food pile (the
player's marked pile, or one near a player entrance); an invasion rallies them on
the player's entrance, so from V52 only an invasion **raids** the player's
FoodStorage chambers (see **Raid**). The AI records the fighters it sends (the
operation's **cohort**); from V64 (#372) a probe's rally applies only to its cohort
(up to V63 every fighter of the colony answered it), while an invasion's rally is
every fighter's order.
_Avoid_: "attack" used alone (ambiguous); don't conflate the operation kind
(`Probe`/`Invasion`) with the AI state (`Probing`/`Invading`).

**Gathering (enemy army)** (#372, render-only):
At least `GATHER_MIN_FIGHTERS` fighters of other colonies on the surface (moving
or not) within `GATHER_RADIUS_TILES` of one of the viewing colony's open entrances,
not counting any within `GATHER_HOME_RADIUS_TILES` of their own open entrances; a
fighter near two entrances counts for both. Read from world state in
`src/render/enemy-gathering.ts`, not from the AI state, so any opponent's army
counts. The minimap rings a gathering. The **gathering warning** caption names the
entrance (by compass direction from the middle of the colony's open entrances) once
the gathering has held `GATHER_DWELL_TICKS` with no **invasion** under way (fewer
than `INVASION_NEST_MIN_FIGHTERS` enemy fighters in the colony's tunnels). It fires
once per gathering (an invasion that starts first also uses it up) and re-arms only
after at most `GATHER_REARM_MAX_FIGHTERS` are near any entrance and no invasion is
under way, continuously for `GATHER_REARM_QUIET_TICKS`.
_Avoid_: "staging" for the render concept (the AI's probe rally is the cause, not
the definition).

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
deterministically from its seed, difficulty and `simVersion` (since #395, V69, the
world is generated at that version: map generation is version-gated too).
_Avoid_: history, journal.

**Autosave**:
The periodic save on a wall-clock timer (not a tick boundary).
_Avoid_: backup.
