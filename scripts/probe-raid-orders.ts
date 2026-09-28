// scripts/probe-raid-orders.ts
// #352 — scripted-player probe: does each raid order do what it says in a real
// match?
//
// Per seed, both colonies are driven by the rule-based AI controller (as
// `check:ai-economy --both-ai` does) up to tick --t0, so the player colony has an
// economy, FoodStorage chambers and fighters. There the script takes the player
// over: the player's AI stops, its stores are filled to capacity (so Loot, which
// minds the room at home, and Deny, which does not, part ways), its ratio goes
// fight-heavy (SetBehaviorRatio 3:7), and it rallies on the enemy's entrance
// nearest its own with ONE raid order (SetRallyPoint + raidType). The world at
// --t0 is copied once per order, so all five start from the same state. The enemy
// AI keeps playing. Over the next --window ticks it measures:
//   - stolen   food the player's fighters took (fp; foodRaidedFp)
//   - lostE    food the enemy lost to raids (fp; foodLostToRaidsFp — a Spoil
//              destroys, so lostE > stolen)
//   - trips    completed hauls (deposits, or a Deny drop by the player's door)
//   - dropped  food in the piles that appeared within a tile of the player's open
//              entrances during the window (a Deny drop; a pile's size at birth)
//   - doorFp   food in piles within a tile of the player's open entrances at the end
//   - inNest   fighter-ticks the player's fighters spent below ground in the enemy
//              nest (a Blockade stays out)
//   - ring     mean player fighters on the surface within BLOCKADE_RADIUS_TILES of
//              the target entrance
//   - kills    enemy ants the player's ants killed
//   - queen    the enemy queen's HP at the end ('dead@tick' if she died)
//
// Run: node --experimental-strip-types scripts/probe-raid-orders.ts
//   Optional args: --seeds=N (default 12) --seed-start=S (1) --t0=T (8000)
//                  --window=W (4000) --min-workers=M (12: skip a seed whose
//                  player colony is smaller than this at t0 — too weak to raid)
// Not a gate: it prints numbers for a PR body.

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
const { copyWorldState, createWorldState } = await import('../src/sim/types.js');
const { GameOutcome } = await import('../src/sim/game-over.js');
const { pushCommand } = await import('../src/sim/commands.js');
const {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  BLOCKADE_RADIUS_TILES,
} = await import('../src/sim/constants.js');
const { runAIController } = await import('../src/render/ai-controller.js');
const { createDefaultAIStateRecord, getAIStateForColony } = await import('../src/sim/ai-state.js');
const { forEachPile } = await import('../src/sim/food/food-api.js');
const { setChamberStockForTest, setPoolFoodForTest } =
  await import('../src/sim/food/food-test-utils.js');
const { AntTask, ChamberType, RaidType } = await import('../src/sim/enums.js');
const { Zone } = await import('../src/sim/terrain.js');
const { FP_SHIFT } = await import('../src/sim/fixed.js');

import type { WorldState } from '../src/sim/types.js';

function numArg(name: string, fallback: number): number {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) {
      const n = Number(a.slice(name.length + 3));
      if (!Number.isInteger(n) || n < 0) {
        console.error(`--${name} needs a non-negative integer`);
        process.exit(2);
      }
      return n;
    }
  }
  return fallback;
}

const SEEDS = numArg('seeds', 12);
const SEED_START = numArg('seed-start', 1);
const T0 = numArg('t0', 8000);
const WINDOW = numArg('window', 4000);
const MIN_WORKERS = numArg('min-workers', 12);

const ORDERS = [
  ['Loot', RaidType.Loot],
  ['Deny', RaidType.Deny],
  ['Spoil', RaidType.Spoil],
  ['Blockade', RaidType.Blockade],
  ['Assault', RaidType.Assault],
] as const;

interface Row {
  fighters: number;
  meanFighters: number;
  dropped: number;
  stolen: number;
  lostE: number;
  trips: number;
  doorFp: number;
  inNest: number;
  ring: number;
  kills: number;
  queen: string;
  queenHp: number;
}

/** Play both colonies by the AI to tick T0. Null if either queen died first. */
function warmUp(seed: number): WorldState | null {
  const world = createScenario(seed, 'Normal');
  if (getAIStateForColony(world, PLAYER_COLONY_ID) === null) {
    world.aiState.push(createDefaultAIStateRecord(PLAYER_COLONY_ID));
  }
  for (let t = 0; t < T0; t++) {
    runAIController(world, ENEMY_COLONY_ID);
    runAIController(world, PLAYER_COLONY_ID);
    if (tick(world, world.commandQueue.splice(0)) !== GameOutcome.None) return null;
  }
  return world;
}

function playerFighters(world: WorldState): number {
  let n = 0;
  for (const id of world.colonies[PLAYER_COLONY_ID]!.workers) {
    if (world.ants.alive[id] === 1 && world.ants.task[id] === AntTask.Fighting) n++;
  }
  return n;
}

function runOrder(start: WorldState, type: number): Row {
  const world = createWorldState(0);
  copyWorldState(start, world);
  const player = world.colonies[PLAYER_COLONY_ID]!;
  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  // Take the player over: no AI record (its state machine must not touch the rally).
  world.aiState = world.aiState.filter((r) => r.colonyId !== PLAYER_COLONY_ID);
  setPoolFoodForTest(world, player, BASE_FOOD_STORAGE_CAPACITY);
  for (const ch of player.chambers) {
    if (ch.chamberType === ChamberType.FoodStorage) {
      setChamberStockForTest(world, player, ch, FOOD_CHAMBER_CAPACITY);
    }
  }
  const home = player.entrances.find((e) => e.isOpen) ?? player.entrances[0]!;
  let door = enemy.entrances.find((e) => e.isOpen)!;
  for (const e of enemy.entrances) {
    if (!e.isOpen) continue;
    const d =
      Math.abs(e.surfaceTileX - home.surfaceTileX) + Math.abs(e.surfaceTileY - home.surfaceTileY);
    const b =
      Math.abs(door.surfaceTileX - home.surfaceTileX) +
      Math.abs(door.surfaceTileY - home.surfaceTileY);
    if (d < b) door = e;
  }
  const t = world.tick;
  pushCommand(
    world,
    {
      type: 'SetBehaviorRatio',
      colonyId: PLAYER_COLONY_ID,
      ratio: { forage: 3, fight: 7 },
      issuedAtTick: t,
    },
    'player',
  );
  pushCommand(
    world,
    {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: door.surfaceTileX,
      tileY: door.surfaceTileY,
      raidType: type as (typeof RaidType)[keyof typeof RaidType],
      issuedAtTick: t,
    },
    'player',
  );
  const stolen0 = player.foodRaidedFp;
  const lost0 = enemy.foodLostToRaidsFp;
  const trips0 = player.raidTrips;
  const kills0 = player.killCount;
  const fighters = playerFighters(world);
  let inNest = 0;
  let ringSum = 0;
  let fighterSum = 0;
  let dropped = 0;
  let queen = '-';
  const a = world.ants;
  // Piles by the player's doors: what they held at t0 is not a drop. A pile's
  // initial size only grows by a top-up, so each scan adds its growth since the
  // last (a pile new since t0 adds all of it) — a drop onto an existing pile counts.
  const lastInitial = new Map<number, number>();
  const scanDoorPiles = (): void => {
    forEachPile(world, (p) => {
      for (const e of player.entrances) {
        if (
          e.isOpen &&
          Math.abs(p.x - e.surfaceTileX) <= 1 &&
          Math.abs(p.y - e.surfaceTileY) <= 1
        ) {
          const before = lastInitial.get(p.foodId);
          if (world.tick > t) dropped += p.initialFp - (before ?? 0);
          lastInitial.set(p.foodId, p.initialFp);
          return;
        }
      }
    });
  };
  scanDoorPiles();
  // Ticks actually run: an order that ends the match stops early, and its means
  // are over the ticks it ran, not the whole window.
  let ran = 0;
  for (let k = 0; k < WINDOW; k++) {
    ran++;
    runAIController(world, ENEMY_COLONY_ID);
    const outcome = tick(world, world.commandQueue.splice(0));
    scanDoorPiles();
    for (const id of player.workers) {
      if (a.alive[id] !== 1 || a.task[id] !== AntTask.Fighting) continue;
      fighterSum++;
      if (a.zone[id] === Zone.Underground && a.currentGridColonyId[id] === ENEMY_COLONY_ID) {
        inNest++;
      } else if (a.zone[id] === Zone.Surface) {
        const dx = (a.posX[id]! >> FP_SHIFT) - door.surfaceTileX;
        const dy = (a.posY[id]! >> FP_SHIFT) - door.surfaceTileY;
        if (Math.abs(dx) + Math.abs(dy) <= BLOCKADE_RADIUS_TILES) ringSum++;
      }
    }
    if (a.alive[enemy.queenEntityId] !== 1 && queen === '-') queen = `dead@${world.tick}`;
    if (outcome !== GameOutcome.None) break;
  }
  let doorFp = 0;
  forEachPile(world, (p) => {
    for (const e of player.entrances) {
      if (e.isOpen && Math.abs(p.x - e.surfaceTileX) <= 1 && Math.abs(p.y - e.surfaceTileY) <= 1) {
        doorFp += p.amountFp;
        break;
      }
    }
  });
  return {
    fighters,
    meanFighters: Math.round((fighterSum / ran) * 10) / 10,
    dropped,
    stolen: player.foodRaidedFp - stolen0,
    lostE: enemy.foodLostToRaidsFp - lost0,
    trips: player.raidTrips - trips0,
    doorFp,
    inNest,
    ring: Math.round((ringSum / ran) * 10) / 10,
    kills: player.killCount - kills0,
    queen,
    queenHp: a.alive[enemy.queenEntityId] === 1 ? a.hp[enemy.queenEntityId]! : 0,
  };
}

const rows = new Map<string, Row[]>(ORDERS.map(([n]) => [n, []]));
let skipped = 0;
for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
  const start = warmUp(seed);
  if (start === null) {
    skipped++;
    console.log(`seed ${seed}: a queen died before tick ${T0}; skipped`);
    continue;
  }
  const workers = start.colonies[PLAYER_COLONY_ID]!.workers.length;
  if (workers < MIN_WORKERS) {
    skipped++;
    console.log(
      `seed ${seed}: the player has ${workers} workers at t0 (< ${MIN_WORKERS}); skipped`,
    );
    continue;
  }
  const line: string[] = [];
  for (const [name, type] of ORDERS) {
    const r = runOrder(start, type);
    rows.get(name)!.push(r);
    line.push(
      `${name}: fighters=${r.meanFighters} stolen=${r.stolen} lostE=${r.lostE} trips=${r.trips} dropped=${r.dropped} doorFp=${r.doorFp} inNest=${r.inNest} ring=${r.ring} kills=${r.kills} queen=${r.queen === '-' ? r.queenHp : r.queen}`,
    );
  }
  console.log(
    `seed ${seed} (workers@t0=${workers}, fighters@t0=${rows.get('Loot')!.at(-1)!.fighters})\n  ${line.join('\n  ')}`,
  );
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((p, q) => p - q);
  return s.length === 0 ? 0 : s[(s.length - 1) >> 1]!;
};
const sum = (xs: number[]): number => xs.reduce((p, q) => p + q, 0);
console.log(
  `\n== #352 raid-order probe: ${SEEDS - skipped} seeds (from ${SEED_START}), both-AI to t0=${T0}, then the player's order for ${WINDOW} ticks; player stores filled at t0 ==`,
);
console.log(
  'order    | mean fighters | stolen fp (sum / median) | enemy lost fp (sum / median) | trips | dropped by door fp | door-pile fp @end | in-enemy-nest fighter-ticks | ring (mean fighters) | kills | enemy queens killed',
);
for (const [name] of ORDERS) {
  const rs = rows.get(name)!;
  const pick = (f: (r: Row) => number): number[] => rs.map(f);
  console.log(
    `${name.padEnd(8)} | ${median(pick((r) => r.meanFighters))} | ${sum(pick((r) => r.stolen))} / ${median(pick((r) => r.stolen))} | ${sum(pick((r) => r.lostE))} / ${median(pick((r) => r.lostE))} | ${sum(pick((r) => r.trips))} | ${sum(pick((r) => r.dropped))} | ${sum(pick((r) => r.doorFp))} | ${sum(pick((r) => r.inNest))} | ${median(pick((r) => r.ring))} | ${sum(pick((r) => r.kills))} | ${rs.filter((r) => r.queen !== '-').length}/${rs.length}`,
  );
}
