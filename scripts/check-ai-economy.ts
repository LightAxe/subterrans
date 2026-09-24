// scripts/check-ai-economy.ts
// Issue #297 — full-match AI-economy acceptance harness.
//
// The sibling gate `check-foraging-survival.ts` runs the *no-command* scenario
// (it never calls `runAIController`) over a 2000-tick horizon. That arm is blind
// to the failure this harness exists to catch: the rule-based enemy colony grows,
// over-broods, and starves its own queen somewhere around tick 5–12 k, so a
// passive player "wins" 61/100 seeds on Normal without issuing a single command.
//
// This harness runs the REAL matchup — `runAIController(world, ENEMY_COLONY_ID)`
// every tick against a passive player — out to MATCH_TIMEOUT_TICKS, and reports
// per seed and in aggregate:
//   - enemy queen alive at tick 12 000 and 24 000, and the tick she died
//   - peak enemy worker count
//   - highest AI state reached + the tick it first reached WarFooting / Invading
//   - opening completion tick (Queen + Nursery + FoodStorage all COMPLETED)
//   - enemy food-total trajectory (peak, tick of peak, first tick at zero)
//   - the same queen-survival number for the passive player, as a sanity arm
//     (the retune must not make a do-nothing player immortal)
//
// Acceptance targets, asserted with an exit code:
//   - enemy queen alive at tick 12 000 on >= 80% of seeds
//   - opening completes on >= 90% of seeds
//   - WarFooting (or later) reached on >= 70% of seeds
//   - homebound foragers frozen outside by the V34 flee hold on <= 4% of ticks
//
// The thresholds are calibrated on NORMAL, which is the default difficulty and
// the gate `npm run check:ai-economy` runs. They are applied unchanged to
// `--difficulty=Easy|Hard` runs, which are exploratory: Hard in particular runs
// a hungrier spider and a faster brood cadence and currently lands below the
// queen-survival threshold, so read a Hard FAIL as data, not as a regression.
//
// Run: node --experimental-strip-types scripts/check-ai-economy.ts
//   Optional args: --seeds=N --difficulty=Easy|Normal|Hard --ticks=M
//                  --trace=1,7,13   per-500-tick economy trace for those seeds
//                  --report-only    print the verdict but never exit non-zero
//
// Runtime: ~30 seeds × 24 000 ticks takes roughly 3–5 minutes on a dev laptop,
// which is why this is NOT wired into `npm run verify`. Use `npm run check:ai-economy`.

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('.js')) {
        const tsSpec = specifier.slice(0, -3) + '.ts';
        try { return await nextResolve(tsSpec, context); } catch (_) {}
      }
      return nextResolve(specifier, context);
    }
  `),
  pathToFileURL('./'),
);

const { createScenario } = await import('../src/sim/scenario.js');
const { tick } = await import('../src/sim/tick.js');
const { PLAYER_COLONY_ID, ENEMY_COLONY_ID, MATCH_TIMEOUT_TICKS } =
  await import('../src/sim/constants.js');
const { runAIController } = await import('../src/render/ai-controller.js');
const { colonyFoodTotal } = await import('../src/sim/colony/colony-system.js');
const { ChamberType, AntTask, PheromoneType } = await import('../src/sim/enums.js');
const { isAlive } = await import('../src/sim/ant/ant-store.js');
const { getAIStateForColony } = await import('../src/sim/ai-state.js');
const { pheromoneGridKey, phGet } = await import('../src/sim/pheromone/pheromone-store.js');
const { Zone } = await import('../src/sim/terrain.js');

import type { WorldState, AIState } from '../src/sim/types.js';
import type { ColonyRecord } from '../src/sim/colony/colony-store.js';

function parseNumArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) {
      const n = Number(a.slice(prefix.length));
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function parseStrArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return fallback;
}

const SEEDS = parseNumArg('seeds', 30);
const TICKS = parseNumArg('ticks', MATCH_TIMEOUT_TICKS);
const DIFFICULTY_ARG = parseStrArg('difficulty', 'Normal');
const REPORT_ONLY = process.argv.slice(2).includes('--report-only');
const TRACE_SEEDS = new Set(
  parseStrArg('trace', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n)),
);
const TRACE_INTERVAL = parseNumArg('trace-interval', 500);

if (!Number.isInteger(SEEDS) || SEEDS < 1) {
  console.error(`--seeds=${SEEDS} must be an integer >= 1.`);
  process.exit(2);
}
if (!Number.isInteger(TICKS) || TICKS < 1) {
  console.error(`--ticks=${TICKS} must be an integer >= 1.`);
  process.exit(2);
}
if (DIFFICULTY_ARG !== 'Easy' && DIFFICULTY_ARG !== 'Normal' && DIFFICULTY_ARG !== 'Hard') {
  console.error(`Unknown --difficulty=${DIFFICULTY_ARG}; expected Easy|Normal|Hard.`);
  process.exit(2);
}
const DIFFICULTY: 'Easy' | 'Normal' | 'Hard' = DIFFICULTY_ARG;

/** Ordering used to report the "highest" AI state a seed ever reached. */
const AI_STATE_RANK: Record<AIState, number> = {
  Peacetime: 0,
  WarFooting: 1,
  // Recovery is the post-operation LULL, not an escalation beyond WarFooting —
  // ranking it above Probing/Invading would report a wind-down as the high-water
  // mark. A colony can only enter it from Invading, so `invadingTick` is already
  // set and "highest reached" still prints Invading for those seeds.
  Recovery: 1,
  Probing: 2,
  Invading: 3,
};

const CHECKPOINT_12K = 12_000;
/** The match cap itself — derived so it cannot silently decouple from the sim. */
const CHECKPOINT_24K = MATCH_TIMEOUT_TICKS;

interface SeedResult {
  seed: number;
  enemyAliveAt12k: boolean | null;
  enemyAliveAt24k: boolean | null;
  enemyDeathTick: number | null;
  playerAliveAt12k: boolean | null;
  playerAliveAt24k: boolean | null;
  playerDeathTick: number | null;
  /** Why each queen died — 'Starvation' | 'Killed' | '-' (see queenDeathCause). */
  enemyDeathCause: string;
  playerDeathCause: string;
  peakEnemyWorkers: number;
  peakEnemyWorkersTick: number;
  highestState: AIState;
  warFootingTick: number | null;
  invadingTick: number | null;
  openingTick: number | null;
  foodPeak: number;
  foodPeakTick: number;
  foodFirstZeroTick: number | null;
  /** #297 signature: ticks (while the queen lived) with >=1 HOMEBOUND forager
   *  frozen by the V34 flee hold, and the measured window it is out of. */
  heldTicks: number;
  heldWindow: number;
  /** Most food (fp) held by those frozen foragers at once. */
  peakHeldFood: number;
}

/** Tick at which Queen + Nursery + FoodStorage are all COMPLETED for a colony. */
function openingComplete(world: WorldState, colonyId: number): boolean {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return false;
  let queen = false;
  let nursery = false;
  let storage = false;
  for (const ch of colony.chambers) {
    if (ch.chamberType === ChamberType.Queen) queen = true;
    else if (ch.chamberType === ChamberType.Nursery) nursery = true;
    else if (ch.chamberType === ChamberType.FoodStorage) storage = true;
  }
  return queen && nursery && storage;
}

interface ColonyCensus {
  workers: number;
  foragers: number;
  /** Foragers actually holding food (NOT merely homebound — an empty
   *  ReturningToNest forager carries nothing). */
  laden: number;
  fighters: number;
  diggers: number;
  nurses: number;
  /** Surface HOMEBOUND foragers frozen by the V34 flee hold (no safe entrance to
   *  come home to) — laden or empty; both are work the colony cannot get back. */
  heldCarriers: number;
  /** Food (fp) the laden ones among them are holding. */
  heldFood: number;
}

/**
 * Task census over ADULT workers only (`colony.workers[]`). Iterating `ants` by
 * colonyId instead would fold eggs and larvae in (brood are entities with
 * `task === Idle`) and overstate the worker count by the whole brood.
 */
function census(world: WorldState, colonyId: number): ColonyCensus {
  const { ants } = world;
  const out: ColonyCensus = {
    workers: 0,
    foragers: 0,
    laden: 0,
    fighters: 0,
    diggers: 0,
    nurses: 0,
    heldCarriers: 0,
    heldFood: 0,
  };
  const colony = world.colonies[colonyId];
  if (colony === undefined) return out;
  for (const id of colony.workers) {
    if (!isAlive(ants, id)) continue;
    out.workers += 1;
    switch (ants.task[id]) {
      case AntTask.Foraging:
        out.foragers += 1;
        if (ants.foodCarrying[id]! > 0) out.laden += 1;
        break;
      case AntTask.Fighting:
        out.fighters += 1;
        break;
      case AntTask.Digging:
        out.diggers += 1;
        break;
      case AntTask.Nursing:
        out.nurses += 1;
        break;
      default:
        break;
    }
    // #297 — a SURFACE forager with a positive flee phase is held in place: it
    // banks nothing and forages nothing until the hold lifts.
    if (
      ants.zone[id] === Zone.Surface &&
      ants.fleeShelterUntilTick[id]! > 0 &&
      ants.task[id] === AntTask.Foraging
    ) {
      out.heldCarriers += 1;
      out.heldFood += ants.foodCarrying[id]!;
    }
  }
  return out;
}

/**
 * The #297 signature in one sample: how many HOMEBOUND foragers the V34 flee hold
 * currently has frozen on the surface, and how much food they are holding.
 *
 * Counts every held surface forager, laden or empty, because that is exactly the
 * population the fix frees — an empty ReturningToNest forager frozen out here
 * never descends and never starts another excursion, so it is as lost to the
 * colony as a carrier is. `food` is meaningful only for the laden ones and is
 * reported separately.
 *
 * Writes into a caller-owned struct so the per-tick sample allocates nothing.
 */
interface FrozenSample {
  count: number;
  food: number;
}

function sampleFrozenHomebound(world: WorldState, colonyId: number, out: FrozenSample): void {
  out.count = 0;
  out.food = 0;
  const { ants } = world;
  const colony = world.colonies[colonyId];
  if (colony === undefined) return;
  for (const id of colony.workers) {
    if (!isAlive(ants, id)) continue;
    if (ants.zone[id] !== Zone.Surface) continue;
    if (ants.fleeShelterUntilTick[id]! <= 0) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;
    out.count += 1;
    out.food += ants.foodCarrying[id]!;
  }
}

/** DangerTrail intensity on the colony's most-dangerous open entrance tile. */
function entranceDanger(world: WorldState, colonyId: number): number {
  const grid =
    world.pheromoneGrids[pheromoneGridKey(colonyId, PheromoneType.DangerTrail, 'surface')];
  if (grid === undefined) return 0;
  const colony = world.colonies[colonyId];
  if (colony === undefined) return 0;
  let worst = 0;
  for (const e of colony.entrances) {
    if (!e.isOpen) continue; // a closed shaft is not a door the flee logic considers
    const d = phGet(grid, e.surfaceTileX, e.surfaceTileY);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * #297 headline metric: WHY a queen died. A match decided by `Starvation` on
 * both sides is the bug this harness exists to catch; a kill means the v3.0
 * combat loop actually fired.
 *
 * Read from `queenStarvationTimer` rather than the `queen_death` telemetry
 * event: the event carries no colonyId, and `world.events` is a capped ring
 * (PLAYTRACE_EVENT_CAP_PER_ROUND) that a full 24 000-tick match overflows, so
 * late queen deaths are simply missing from it. The timer is exact —
 * `tickFoodConsumption` only kills the queen after decrementing it to <= 0, and
 * any successful feed resets it to STARVATION_GRACE_TICKS — so a non-positive
 * timer at the death tick means starvation and anything else means she was
 * killed.
 */
function queenDeathCause(colony: ColonyRecord): string {
  return colony.queenStarvationTimer <= 0 ? 'Starvation' : 'Killed';
}

/** Total surface pile charges within `radius` Manhattan tiles of a colony entrance. */
function pileChargesNear(world: WorldState, colonyId: number, radius: number): number {
  const colony = world.colonies[colonyId];
  if (colony === undefined || colony.entrances.length === 0) return 0;
  let total = 0;
  for (const pile of world.foodPiles) {
    let best = Number.POSITIVE_INFINITY;
    for (const e of colony.entrances) {
      const d = Math.abs(pile.tileX - e.surfaceTileX) + Math.abs(pile.tileY - e.surfaceTileY);
      if (d < best) best = d;
    }
    if (best <= radius) total += pile.pickupsRemaining;
  }
  return total;
}

function runSeed(seed: number): SeedResult {
  const world = createScenario(seed, DIFFICULTY);
  const trace = TRACE_SEEDS.has(seed);

  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  const player = world.colonies[PLAYER_COLONY_ID]!;

  const res: SeedResult = {
    seed,
    enemyAliveAt12k: null,
    enemyAliveAt24k: null,
    enemyDeathTick: null,
    playerAliveAt12k: null,
    playerAliveAt24k: null,
    playerDeathTick: null,
    enemyDeathCause: '-',
    playerDeathCause: '-',
    peakEnemyWorkers: 0,
    peakEnemyWorkersTick: 0,
    highestState: 'Peacetime',
    warFootingTick: null,
    invadingTick: null,
    openingTick: null,
    foodPeak: 0,
    foodPeakTick: 0,
    foodFirstZeroTick: null,
    heldTicks: 0,
    heldWindow: 0,
    peakHeldFood: 0,
  };

  const frozenSample: FrozenSample = { count: 0, food: 0 };
  let prevEnemyFood = colonyFoodTotal(enemy);
  let depositedSinceTrace = 0;
  let consumedSinceTrace = 0;

  if (trace) {
    console.log(
      `\n--- trace seed ${seed} (${DIFFICULTY}) --- ` +
        `t / workers / foragers(laden) / diggers / fighters / brood(e+l) / food / ` +
        `dFood(+in/-out) / chambers / aiState / pileCharges<=40`,
    );
  }

  for (let t = 0; t < TICKS; t++) {
    runAIController(world, ENEMY_COLONY_ID);
    tick(world, world.commandQueue.splice(0));

    const enemyQueenAlive = isAlive(world.ants, enemy.queenEntityId);
    const playerQueenAlive = isAlive(world.ants, player.queenEntityId);
    if (!enemyQueenAlive && res.enemyDeathTick === null) {
      res.enemyDeathTick = world.tick;
      res.enemyDeathCause = queenDeathCause(enemy);
    }
    if (!playerQueenAlive && res.playerDeathTick === null) {
      res.playerDeathTick = world.tick;
      res.playerDeathCause = queenDeathCause(player);
    }

    if (enemyQueenAlive) {
      if (enemy.workerCount > res.peakEnemyWorkers) {
        res.peakEnemyWorkers = enemy.workerCount;
        res.peakEnemyWorkersTick = world.tick;
      }
    }

    // #297 signature, sampled EVERY tick (not just on trace ticks): homebound
    // foragers frozen on the surface by the V34 flee hold are work — and, for the
    // laden ones, food — the colony cannot get back.
    // Only counted while the queen is alive — after she dies the colony is over and
    // the number stops meaning anything.
    if (enemyQueenAlive) {
      res.heldWindow += 1;
      sampleFrozenHomebound(world, ENEMY_COLONY_ID, frozenSample);
      if (frozenSample.count > 0) res.heldTicks += 1;
      if (frozenSample.food > res.peakHeldFood) res.peakHeldFood = frozenSample.food;
    }

    const food = colonyFoodTotal(enemy);
    const delta = food - prevEnemyFood;
    if (delta > 0) depositedSinceTrace += delta;
    else consumedSinceTrace -= delta;
    prevEnemyFood = food;

    if (food > res.foodPeak) {
      res.foodPeak = food;
      res.foodPeakTick = world.tick;
    }
    if (food === 0 && res.foodFirstZeroTick === null && world.tick > 0) {
      res.foodFirstZeroTick = world.tick;
    }

    const aiRec = getAIStateForColony(world, ENEMY_COLONY_ID);
    if (aiRec !== null) {
      if (AI_STATE_RANK[aiRec.state] > AI_STATE_RANK[res.highestState]) {
        res.highestState = aiRec.state;
      }
      if (res.warFootingTick === null && aiRec.state !== 'Peacetime') {
        res.warFootingTick = world.tick;
      }
      if (res.invadingTick === null && aiRec.state === 'Invading') {
        res.invadingTick = world.tick;
      }
    }

    if (res.openingTick === null && openingComplete(world, ENEMY_COLONY_ID)) {
      res.openingTick = world.tick;
    }

    if (world.tick === CHECKPOINT_12K) {
      res.enemyAliveAt12k = enemyQueenAlive;
      res.playerAliveAt12k = playerQueenAlive;
    }
    if (world.tick === CHECKPOINT_24K) {
      res.enemyAliveAt24k = enemyQueenAlive;
      res.playerAliveAt24k = playerQueenAlive;
    }

    if (trace && world.tick % TRACE_INTERVAL === 0) {
      const c = census(world, ENEMY_COLONY_ID);
      console.log(
        `t=${String(world.tick).padStart(6)} ` +
          `w=${String(c.workers).padStart(3)} ` +
          `f=${String(c.foragers).padStart(3)}(${String(c.laden).padStart(2)}laden) ` +
          `d=${String(c.diggers).padStart(2)} ` +
          `x=${String(c.fighters).padStart(2)} ` +
          `brood=${String(enemy.eggCount + enemy.larvaeCount).padStart(3)}` +
          `(${enemy.eggCount}e+${enemy.larvaeCount}l) ` +
          `food=${String(food).padStart(5)} ` +
          `in=+${String(depositedSinceTrace).padStart(5)} out=-${String(consumedSinceTrace).padStart(5)} ` +
          `ch=${enemy.chambers.length} ` +
          `ai=${aiRec?.state ?? '?'} ` +
          `held=${c.heldCarriers}(${c.heldFood}fp) ` +
          `dngr@ent=${entranceDanger(world, ENEMY_COLONY_ID)} ` +
          `piles40=${pileChargesNear(world, ENEMY_COLONY_ID, 40)} ` +
          `allPiles=${world.foodPiles.length}` +
          (enemyQueenAlive ? '' : ' QUEEN-DEAD'),
      );
      depositedSinceTrace = 0;
      consumedSinceTrace = 0;
    }

    // Stop early once both queens are gone — nothing left to measure.
    if (!enemyQueenAlive && !playerQueenAlive) break;
  }

  // Seeds that ended before a checkpoint report the liveness at the end instead.
  if (res.enemyAliveAt12k === null && TICKS >= CHECKPOINT_12K) {
    res.enemyAliveAt12k = res.enemyDeathTick === null || res.enemyDeathTick > CHECKPOINT_12K;
  }
  if (res.enemyAliveAt24k === null && TICKS >= CHECKPOINT_24K) {
    res.enemyAliveAt24k = res.enemyDeathTick === null || res.enemyDeathTick > CHECKPOINT_24K;
  }
  if (res.playerAliveAt12k === null && TICKS >= CHECKPOINT_12K) {
    res.playerAliveAt12k = res.playerDeathTick === null || res.playerDeathTick > CHECKPOINT_12K;
  }
  if (res.playerAliveAt24k === null && TICKS >= CHECKPOINT_24K) {
    res.playerAliveAt24k = res.playerDeathTick === null || res.playerDeathTick > CHECKPOINT_24K;
  }

  return res;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Checkpoint liveness display: null = the run never reached that checkpoint. */
function aliveLabel(v: boolean | null): string {
  return v === null ? ' n/a ' : v ? 'alive' : ' DEAD';
}

/** "Starvation x12, InvasionKill x15, - x3" — compact cause histogram. */
function tally(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} x${n}`)
    .join(', ');
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

const start = Date.now();
const results: SeedResult[] = [];
for (let s = 0; s < SEEDS; s++) {
  results.push(runSeed(s));
  if ((s + 1) % 5 === 0) {
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`  ${s + 1}/${SEEDS} seeds done (${elapsedS}s)\n`);
  }
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log('');
console.log('== #297 AI-economy gate (rule-based enemy vs passive player) ==');
console.log(`Seeds: ${SEEDS}  Difficulty: ${DIFFICULTY}  Ticks: ${TICKS}  Elapsed: ${elapsed}s`);
console.log('');
console.log(
  'seed | enemyQ@12k @24k death cause | peakW | opening | aiState(first!=Peace) | invading | foodPeak@tick | food0 | playerQ death cause',
);
for (const r of results) {
  console.log(
    `${String(r.seed).padStart(4)} | ` +
      `${aliveLabel(r.enemyAliveAt12k)} ${aliveLabel(r.enemyAliveAt24k)} ` +
      `${String(r.enemyDeathTick ?? '-').padStart(6)} ${r.enemyDeathCause.padEnd(13)} | ` +
      `${String(r.peakEnemyWorkers).padStart(5)} | ` +
      `${String(r.openingTick ?? 'never').padStart(7)} | ` +
      `${r.highestState.padEnd(10)} ${String(r.warFootingTick ?? '-').padStart(6)} | ` +
      `${String(r.invadingTick ?? '-').padStart(8)} | ` +
      `${String(r.foodPeak).padStart(6)}@${String(r.foodPeakTick).padStart(6)} | ` +
      `${String(r.foodFirstZeroTick ?? '-').padStart(6)} | ` +
      `${String(r.playerDeathTick ?? '-').padStart(6)} ${r.playerDeathCause}`,
  );
}

const enemyAlive12k = results.filter((r) => r.enemyAliveAt12k === true).length;
const enemyAlive24k = results.filter((r) => r.enemyAliveAt24k === true).length;
const playerAlive12k = results.filter((r) => r.playerAliveAt12k === true).length;
const playerAlive24k = results.filter((r) => r.playerAliveAt24k === true).length;
const openingDone = results.filter((r) => r.openingTick !== null).length;
const warFooting = results.filter((r) => r.highestState !== 'Peacetime').length;
const invaded = results.filter((r) => r.invadingTick !== null).length;

const deathTicks = results
  .map((r) => r.enemyDeathTick)
  .filter((x): x is number => x !== null)
  .sort((a, b) => a - b);
const openingTicks = results
  .map((r) => r.openingTick)
  .filter((x): x is number => x !== null)
  .sort((a, b) => a - b);
const warTicks = results
  .map((r) => r.warFootingTick)
  .filter((x): x is number => x !== null)
  .sort((a, b) => a - b);
const peakWorkers = results.map((r) => r.peakEnemyWorkers).sort((a, b) => a - b);
// #297 signature as a share of each seed's measured window, so it is comparable
// across seeds that ended at different ticks. Kept as RAW percentages: rounding
// each seed before taking the median lets a true median just over the threshold
// round down and pass (e.g. 4.4% -> 4%), which is precisely the failure the
// threshold exists to catch (CodeRabbit). Rounding happens only when printing.
const heldShares = results
  .map((r) => (r.heldWindow === 0 ? 0 : (r.heldTicks * 100) / r.heldWindow))
  .sort((a, b) => a - b);
const heldShareMedian = median(heldShares);
const heldShareMax = heldShares[heldShares.length - 1];
/** One decimal, trailing ".0" trimmed — display only; never fed back to a check. */
const fmtShare = (v: number | undefined): string =>
  v === undefined || Number.isNaN(v) ? '-' : `${Number(v.toFixed(1))}`;

console.log('');
console.log('Aggregate:');
console.log(
  `  Enemy queen alive @12k: ${enemyAlive12k}/${SEEDS} (${pct(enemyAlive12k, SEEDS)})  ` +
    `@24k: ${enemyAlive24k}/${SEEDS} (${pct(enemyAlive24k, SEEDS)})`,
);
console.log(
  `  Player queen alive @12k: ${playerAlive12k}/${SEEDS} (${pct(playerAlive12k, SEEDS)})  ` +
    `@24k: ${playerAlive24k}/${SEEDS} (${pct(playerAlive24k, SEEDS)})`,
);
// #327 — the harness plays on past game over (it never reads tick()'s
// GameOutcome), so an AI queen that starves AFTER the passive player's queen has
// already died is counted like one that lost a live match. Split them: only a
// death while the player queen still lived happened in a real match.
const enemyDeathsLive = results.filter(
  (r) =>
    r.enemyDeathTick !== null &&
    (r.playerDeathTick === null || r.enemyDeathTick <= r.playerDeathTick),
).length;
const enemyDeathsAfterGameOver = results.filter(
  (r) =>
    r.enemyDeathTick !== null && r.playerDeathTick !== null && r.enemyDeathTick > r.playerDeathTick,
).length;
console.log(
  `  Enemy queen deaths while the match was live: ${enemyDeathsLive}/${SEEDS}  ` +
    `after the player queen had died: ${enemyDeathsAfterGameOver}/${SEEDS}`,
);
console.log(
  `  Enemy queen death tick: median=${median(deathTicks)} ` +
    `min=${deathTicks[0] ?? '-'} max=${deathTicks[deathTicks.length - 1] ?? '-'} (n=${deathTicks.length})`,
);
console.log(
  `  Opening complete: ${openingDone}/${SEEDS} (${pct(openingDone, SEEDS)})  median tick=${median(openingTicks)}`,
);
console.log(
  `  WarFooting or later: ${warFooting}/${SEEDS} (${pct(warFooting, SEEDS)})  median tick=${median(warTicks)}`,
);
console.log(`  Invading reached: ${invaded}/${SEEDS} (${pct(invaded, SEEDS)})`);
console.log(
  `  Frozen-forager share (ticks with >=1 homebound forager held / ticks queen alive): ` +
    `median=${fmtShare(heldShareMedian)}%  max=${fmtShare(heldShareMax)}%  ` +
    `peak food frozen outside: ${Math.max(0, ...results.map((r) => r.peakHeldFood))} fp`,
);
console.log(`  Enemy queen death causes: ${tally(results.map((r) => r.enemyDeathCause))}`);
console.log(`  Player queen death causes: ${tally(results.map((r) => r.playerDeathCause))}`);
console.log(
  `  Peak enemy workers: median=${median(peakWorkers)} min=${peakWorkers[0]} max=${peakWorkers[peakWorkers.length - 1]}`,
);

// ---------------------------------------------------------------------------
// Acceptance assertions (#297) — Normal-difficulty targets.
// ---------------------------------------------------------------------------
const MIN_ENEMY_QUEEN_ALIVE_12K_PCT = 80;
const MIN_OPENING_COMPLETE_PCT = 90;
const MIN_WARFOOTING_PCT = 70;
/**
 * #297 direct signature, calibrated against BOTH populations with this exact
 * metric (share of the queen-alive window with >=1 frozen homebound forager,
 * median over 30 Normal seeds):
 *
 *   main (cde6aa4, the bug)  median  9.5%   max 15%
 *   fixed                    median  0%     max  1%
 *
 * (Those two rows were measured under the earlier ROUNDED share; the raw-share
 * switch below moves them only in the decimals — the fixed median reads 0.2%
 * rather than 0% — so 4 still sits well between the populations.)
 *
 * 4% sits between them with room for seed noise. An earlier draft used 10%, which
 * main PASSES — that number came from a different computation (share of a fixed
 * 12 000-tick window rather than of the queen-alive window, which is shorter on
 * exactly the seeds where the bug bites, and hence 19-34%). Quoting it against
 * this metric would have shipped a check that cannot fail on its own bug.
 */
const MAX_FROZEN_FORAGER_SHARE_PCT = 4;

/** null = abstain (the run could not reach the checkpoint), not a failure. */
type Check = readonly [string, boolean | null, string];

const checks: ReadonlyArray<Check> = [
  [
    'Enemy queen alive @12k',
    // A run shorter than the checkpoint cannot answer this. Abstaining beats
    // reporting 0.0% for a queen that was alive the whole (short) run.
    TICKS < CHECKPOINT_12K ? null : (enemyAlive12k / SEEDS) * 100 >= MIN_ENEMY_QUEEN_ALIVE_12K_PCT,
    TICKS < CHECKPOINT_12K
      ? `n/a — --ticks=${TICKS} never reaches tick ${CHECKPOINT_12K}`
      : `${pct(enemyAlive12k, SEEDS)} (>=${MIN_ENEMY_QUEEN_ALIVE_12K_PCT}%)`,
  ],
  [
    'Opening completes',
    (openingDone / SEEDS) * 100 >= MIN_OPENING_COMPLETE_PCT,
    `${pct(openingDone, SEEDS)} (>=${MIN_OPENING_COMPLETE_PCT}%)`,
  ],
  [
    'WarFooting reached',
    (warFooting / SEEDS) * 100 >= MIN_WARFOOTING_PCT,
    `${pct(warFooting, SEEDS)} (>=${MIN_WARFOOTING_PCT}%)`,
  ],
  [
    'Frozen-forager share (median)',
    heldShareMedian <= MAX_FROZEN_FORAGER_SHARE_PCT,
    `${fmtShare(heldShareMedian)}% (<=${MAX_FROZEN_FORAGER_SHARE_PCT}%)`,
  ],
];

console.log('');
console.log('Acceptance checks:');
for (const [name, pass, detail] of checks) {
  console.log(`  [${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
}
const failed = checks.filter(([, pass]) => pass === false);
const skipped = checks.filter(([, pass]) => pass === null);
// An ABSTAIN is not a pass. A run that could not reach a checkpoint has not
// established the thing the gate exists to establish, so it must not print a
// green verdict or exit 0 — otherwise `--ticks=400` looks like a clean gate.
if ((failed.length > 0 || skipped.length > 0) && !REPORT_ONLY) {
  if (failed.length > 0) console.error(`\n${failed.length} acceptance check(s) FAILED.`);
  if (skipped.length > 0) {
    console.error(
      `\n${skipped.length} acceptance check(s) INCONCLUSIVE — this run could not ` +
        `evaluate them. Re-run with a longer --ticks, or pass --report-only.`,
    );
  }
  process.exit(1);
}
if (failed.length > 0 || skipped.length > 0) {
  console.log(
    `\n${failed.length} failed, ${skipped.length} inconclusive ` +
      `(--report-only: not exiting non-zero).`,
  );
} else {
  console.log('\nAll acceptance checks passed.');
}
