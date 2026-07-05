// scripts/check-foraging-survival.ts
// 09 excursion-foraging memo — local acceptance harness.
//
// Runs 200 seeds × 2000 ticks of the deterministic no-command scenario and
// reports the memo's acceptance metrics:
//   - queen survival (both colonies) at tick 2000
//   - seeds that never deposited food at all
//   - first-deposit tick median / P90 / P95 per colony
//
// Baseline (memo, pre-change):
//   Player queen died 63/200; Enemy queen died 46/200
//   No-deposit seeds: 11/200 player, 8/200 enemy
//   Enemy first-deposit median 76 ticks, P90 673, P95 1098
//
// Acceptance targets:
//   - ≥95% queen survival both colonies
//   - No-deposit seeds near zero
//   - P95 first-deposit substantially below 1098
//
// Run: node --experimental-strip-types scripts/check-foraging-survival.ts
//   Optional args: --seeds=N --ticks=M

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
const { PLAYER_COLONY_ID, ENEMY_COLONY_ID } = await import('../src/sim/constants.js');
const { isAlive } = await import('../src/sim/ant/ant-store.js');

function parseArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) {
      const n = Number(a.slice(prefix.length));
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

const SEEDS = parseArg('seeds', 200);
const TICKS = parseArg('ticks', 2000);

interface SeedResult {
  seed: number;
  playerAlive: boolean;
  enemyAlive: boolean;
  playerFirstDeposit: number | null;
  enemyFirstDeposit: number | null;
  playerFoodStored: number;
  enemyFoodStored: number;
}

function runSeed(seed: number): SeedResult {
  const world = createScenario(seed);
  let playerFirst: number | null = null;
  let enemyFirst: number | null = null;
  let prevPlayer = world.colonies[PLAYER_COLONY_ID]!.foodStored;
  let prevEnemy = world.colonies[ENEMY_COLONY_ID]!.foodStored;

  for (let t = 0; t < TICKS; t++) {
    const cmds = world.commandQueue.splice(0);
    tick(world, cmds);
    const pf = world.colonies[PLAYER_COLONY_ID]!.foodStored;
    const ef = world.colonies[ENEMY_COLONY_ID]!.foodStored;
    if (playerFirst === null && pf > prevPlayer) playerFirst = t;
    if (enemyFirst === null && ef > prevEnemy) enemyFirst = t;
    prevPlayer = pf;
    prevEnemy = ef;
  }

  const playerColony = world.colonies[PLAYER_COLONY_ID]!;
  const enemyColony = world.colonies[ENEMY_COLONY_ID]!;
  return {
    seed,
    playerAlive: isAlive(world.ants, playerColony.queenEntityId),
    enemyAlive: isAlive(world.ants, enemyColony.queenEntityId),
    playerFirstDeposit: playerFirst,
    enemyFirstDeposit: enemyFirst,
    playerFoodStored: playerColony.foodStored,
    enemyFoodStored: enemyColony.foodStored,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const start = Date.now();
const results: SeedResult[] = [];
for (let s = 0; s < SEEDS; s++) {
  results.push(runSeed(s));
  if ((s + 1) % 25 === 0) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`  ${s + 1}/${SEEDS} seeds done (${elapsed}s)\n`);
  }
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

const playerAlive = results.filter((r) => r.playerAlive).length;
const enemyAlive = results.filter((r) => r.enemyAlive).length;
const playerNoDeposit = results.filter((r) => r.playerFirstDeposit === null).length;
const enemyNoDeposit = results.filter((r) => r.enemyFirstDeposit === null).length;

const playerFirsts = results
  .map((r) => r.playerFirstDeposit)
  .filter((x): x is number => x !== null)
  .sort((a, b) => a - b);
const enemyFirsts = results
  .map((r) => r.enemyFirstDeposit)
  .filter((x): x is number => x !== null)
  .sort((a, b) => a - b);

const playerMedian = median(playerFirsts);
const playerP90 = percentile(playerFirsts, 90);
const playerP95 = percentile(playerFirsts, 95);
const enemyMedian = median(enemyFirsts);
const enemyP90 = percentile(enemyFirsts, 90);
const enemyP95 = percentile(enemyFirsts, 95);

console.log('');
console.log(`== 09 excursion-foraging memo QC gate ==`);
console.log(`Seeds: ${SEEDS}  Ticks: ${TICKS}  Elapsed: ${elapsed}s`);
console.log('');
console.log('Queen survival @ tick ' + TICKS + ':');
console.log(
  `  Player: ${playerAlive}/${SEEDS} alive (${((playerAlive / SEEDS) * 100).toFixed(1)}%)`,
);
console.log(`  Enemy:  ${enemyAlive}/${SEEDS} alive (${((enemyAlive / SEEDS) * 100).toFixed(1)}%)`);
console.log('');
console.log('No-deposit seeds (never picked up food):');
console.log(`  Player: ${playerNoDeposit}/${SEEDS}`);
console.log(`  Enemy:  ${enemyNoDeposit}/${SEEDS}`);
console.log('');
console.log('First-deposit tick (successful seeds only):');
console.log(`  Player: median=${playerMedian}  P90=${playerP90}  P95=${playerP95}`);
console.log(`  Enemy:  median=${enemyMedian}  P90=${enemyP90}  P95=${enemyP95}`);
console.log('');
console.log('Baseline (memo, pre-change):');
console.log('  Player queen died 63/200; Enemy queen died 46/200');
console.log('  No-deposit: 11/200 player, 8/200 enemy');
console.log('  Enemy first-deposit median 76, P90 673, P95 1098');
console.log('');
console.log('Acceptance targets: ≥95% queen survival both colonies,');
console.log('                    no-deposit seeds near zero,');
console.log('                    P95 first-deposit substantially below 1098');

// #241 — turn the printed targets into real assertions with an exit code, so this
// stops being a "human reads the output" gate. `--report-only` prints the verdict
// but never exits non-zero (for exploratory / tuning runs).
const MIN_QUEEN_SURVIVAL_PCT = 95; // memo hard target, both colonies
const MAX_NO_DEPOSIT_FRACTION = 0.02; // "near zero" -> <=2% of seeds
const MAX_P95_FIRST_DEPOSIT = 800; // "substantially below" the 1098 baseline
const REPORT_ONLY = process.argv.slice(2).includes('--report-only');

const acceptanceChecks: ReadonlyArray<readonly [string, boolean, string]> = [
  [
    'Player queen survival',
    (playerAlive / SEEDS) * 100 >= MIN_QUEEN_SURVIVAL_PCT,
    `${((playerAlive / SEEDS) * 100).toFixed(1)}% (>=${MIN_QUEEN_SURVIVAL_PCT}%)`,
  ],
  [
    'Enemy queen survival',
    (enemyAlive / SEEDS) * 100 >= MIN_QUEEN_SURVIVAL_PCT,
    `${((enemyAlive / SEEDS) * 100).toFixed(1)}% (>=${MIN_QUEEN_SURVIVAL_PCT}%)`,
  ],
  [
    'Player no-deposit',
    playerNoDeposit / SEEDS <= MAX_NO_DEPOSIT_FRACTION,
    `${playerNoDeposit}/${SEEDS} (<=${(MAX_NO_DEPOSIT_FRACTION * 100).toFixed(0)}%)`,
  ],
  [
    'Enemy no-deposit',
    enemyNoDeposit / SEEDS <= MAX_NO_DEPOSIT_FRACTION,
    `${enemyNoDeposit}/${SEEDS} (<=${(MAX_NO_DEPOSIT_FRACTION * 100).toFixed(0)}%)`,
  ],
  [
    'Player P95 first-deposit',
    !Number.isNaN(playerP95) && playerP95 <= MAX_P95_FIRST_DEPOSIT,
    `${playerP95} (<=${MAX_P95_FIRST_DEPOSIT})`,
  ],
  [
    'Enemy P95 first-deposit',
    !Number.isNaN(enemyP95) && enemyP95 <= MAX_P95_FIRST_DEPOSIT,
    `${enemyP95} (<=${MAX_P95_FIRST_DEPOSIT})`,
  ],
];

console.log('');
console.log('Acceptance checks:');
for (const [name, pass, detail] of acceptanceChecks) {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
}
const failedChecks = acceptanceChecks.filter(([, pass]) => !pass);
if (failedChecks.length && !REPORT_ONLY) {
  console.error(`\n${failedChecks.length} acceptance check(s) FAILED.`);
  process.exit(1);
}
console.log(
  failedChecks.length
    ? `\n${failedChecks.length} failed (--report-only: not exiting non-zero).`
    : '\nAll acceptance checks passed.',
);
