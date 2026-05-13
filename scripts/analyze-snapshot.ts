// scripts/analyze-snapshot.ts
// Post-mortem analyzer for downloaded debug snapshots.
//
// Run: node --experimental-transform-types scripts/analyze-snapshot.ts <snapshot.json>
//
// What it does, in order:
//   1. Loads the JSON debug snapshot envelope.
//   2. Replays from seed: createScenario(seed) → tick() through the captured
//      inputLog up to snapshot.tick, then byte-compares serialized state.
//      A divergence here is a SCEN-06 regression. During replay, every
//      SAMPLE_INTERVAL_TICKS the analyzer snapshots each live ant's
//      (zone, tileX, tileY, task, subTask) into a sliding window.
//   3. Reports tile-occupancy clusters (≥THRESHOLD ants on one tile).
//   4. Reports underground ants standing on non-Open tiles (stuck-in-dirt).
//   5. Reports stationary ants (most-visited tile dominates the window) and
//      oscillating ants (≤3 unique tiles across the whole window) using the
//      motion history collected during replay.
//
// --transform-types (not --strip-types) because src/platform/save.ts uses
// constructor parameter properties (`constructor(public expected: number)`)
// which strip-types rejects. The .js→.ts resolve hook below mirrors
// scripts/run-sim.ts so the loader can find sim sources during dynamic import.

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

register(
  'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('.js')) {
        const tsSpec = specifier.slice(0, -3) + '.ts';
        try { return await nextResolve(tsSpec, context); } catch (_) {}
      }
      return nextResolve(specifier, context);
    }
  `),
  pathToFileURL('./')
);

const { createScenario }                       = await import('../src/sim/scenario.js');
const { tick }                                 = await import('../src/sim/tick.js');
const { Zone, UndergroundTileState, ugGet }    = await import('../src/sim/terrain.js');
const { FP_SHIFT }                             = await import('../src/sim/fixed.js');
const { AntTask, ForagingSubState }            = await import('../src/sim/enums.js');
const { serializeWorldState, deserializeWorldState } = await import('../src/platform/save.js');

const ANT_TASK_NAME: Record<number, string> = {
  [AntTask.Idle]:     'Idle',
  [AntTask.Foraging]: 'Foraging',
  [AntTask.Digging]:  'Digging',
  [AntTask.Fighting]: 'Fighting',
  [AntTask.Nursing]:  'Nursing',
};
const FORAGING_SUB_NAME: Record<number, string> = {
  [ForagingSubState.SearchingFood]:   'SearchingFood',
  [ForagingSubState.CarryingFood]:    'CarryingFood',
  [ForagingSubState.ReturningToNest]: 'ReturningToNest',
};
function describeTask(task: number, subTask: number): string {
  const t = ANT_TASK_NAME[task] ?? `task=${task}`;
  if (task === AntTask.Foraging) {
    const s = FORAGING_SUB_NAME[subTask] ?? `sub=${subTask}`;
    return `${t}/${s}`;
  }
  return t;
}

const CLUSTER_THRESHOLD = 5;

// Motion-history sampling — 20 ticks = 1 sim second; 30 samples = 30 sim sec.
const SAMPLE_INTERVAL_TICKS    = 20;
const ANALYSIS_WINDOW_SAMPLES  = 30;
// Stationary classification: ≥90% of samples on the same tile.
const STATIONARY_FRACTION      = 0.9;
// Oscillation classification: ant visits ≤3 unique tiles across the window
// AND fails the stationary test (i.e., genuinely cycles between a few tiles).
const OSCILLATION_MAX_UNIQUE   = 3;

const argPath = process.argv[2];
if (!argPath) {
  console.error('Usage: node --experimental-transform-types scripts/analyze-snapshot.ts <snapshot.json>');
  process.exit(2);
}

const snapPath = resolve(process.cwd(), argPath);

// Minimal envelope validation — surface a clear error on a missing file,
// malformed JSON, or wrong-shape envelope instead of a cryptic stack trace
// mid-replay.
function bail(msg: string): never { console.error(`Invalid snapshot: ${msg}`); process.exit(3); }
let rawJson: string;
try {
  rawJson = readFileSync(snapPath, 'utf-8');
} catch (e) {
  bail(`could not read "${snapPath}": ${(e as Error).message}`);
}
let parsed: unknown;
try {
  parsed = JSON.parse(rawJson);
} catch (e) {
  bail(`not valid JSON (${(e as Error).message})`);
}
const debug = parsed as {
  version: number;
  seed: number;
  tick: number;
  inputLog: { issuedAtTick: number }[];
  snapshot: Parameters<typeof deserializeWorldState>[0];
};
if (typeof debug.seed !== 'number')             bail('missing or non-numeric "seed"');
if (typeof debug.tick !== 'number' || debug.tick < 0) bail('missing or invalid "tick"');
if (!Array.isArray(debug.inputLog))             bail('missing or non-array "inputLog"');
if (!debug.snapshot || typeof debug.snapshot !== 'object') bail('missing "snapshot"');

console.log(`Snapshot: ${snapPath}`);
console.log(`  seed=${debug.seed}  tick=${debug.tick}  inputLog=${debug.inputLog.length} cmds  version=${debug.version}`);
console.log('');

// --- 1. Replay-from-seed byte-equality check (SCEN-06) -----------------------

console.log(`Replaying from seed for ${debug.tick} ticks...`);
const replayStart = Date.now();
const replay = createScenario(debug.seed);

const byTick: typeof debug.inputLog[] = [];
for (let i = 0; i < debug.inputLog.length; i++) {
  const cmd = debug.inputLog[i];
  if (!cmd || typeof cmd !== 'object') bail(`inputLog[${i}] is not an object`);
  const t = (cmd as { issuedAtTick: unknown }).issuedAtTick;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) {
    bail(`inputLog[${i}].issuedAtTick is missing or invalid (got ${String(t)})`);
  }
  (byTick[t] ??= []).push(cmd as { issuedAtTick: number });
}

interface Sample {
  zone: number;
  tileX: number;
  tileY: number;
  task: number;
  subTask: number;
  colonyId: number;
  gridColonyId: number;
}

// Per-ant sliding window of the last ANALYSIS_WINDOW_SAMPLES samples,
// indexed by entity id. Built up during replay so analysis sees the
// motion leading INTO the captured snapshot tick, not after.
const history = new Map<number, Sample[]>();

function sampleAnts(): void {
  const a = replay.ants;
  for (let id = 0; id < replay.nextEntityId; id++) {
    if (a.alive[id] !== 1) continue;
    let arr = history.get(id);
    if (!arr) { arr = []; history.set(id, arr); }
    arr.push({
      zone: a.zone[id]!,
      tileX: a.posX[id]! >> FP_SHIFT,
      tileY: a.posY[id]! >> FP_SHIFT,
      task: a.task[id]!,
      subTask: a.subTask[id]!,
      colonyId: a.colonyId[id]!,
      gridColonyId: a.currentGridColonyId[id]!,
    });
    if (arr.length > ANALYSIS_WINDOW_SAMPLES) arr.shift();
  }
}

for (let t = 0; t < debug.tick; t++) {
  // Cast: SimCommand union vs the loose object type we read from JSON.
  // Replay determinism is the contract being checked; if commands are
  // malformed the tick will throw and the analyzer surfaces that.
  tick(replay, (byTick[t] ?? []) as Parameters<typeof tick>[1]);
  if ((t + 1) % SAMPLE_INTERVAL_TICKS === 0) sampleAnts();
}

const replayElapsedMs = Date.now() - replayStart;
const replayJson  = JSON.stringify(serializeWorldState(replay));
const capturedJson = JSON.stringify(debug.snapshot);
const replayMatches = replayJson === capturedJson;

console.log(`  replayed ${debug.tick} ticks in ${(replayElapsedMs / 1000).toFixed(1)}s`);
console.log(`  replay vs captured byte-equality: ${replayMatches ? 'PASS' : 'FAIL'}`);
if (!replayMatches) {
  console.log(`  WARNING: SCEN-06 determinism regression — replayed state differs from captured.`);
  console.log(`  (or a benign serializer key-order change between snapshot capture and this build)`);
  console.log(`  Cluster / stuck-in-dirt reports below use the CAPTURED snapshot (trustworthy).`);
  console.log(`  Motion-history reports use the REPLAYED trajectory and may not reflect the`);
  console.log(`  captured ants' real motion when replay has diverged — treat with caution.`);
}
console.log('');

// --- 2. Analysis is run against the CAPTURED snapshot ------------------------

const world = deserializeWorldState(debug.snapshot);
const ants  = world.ants;

let liveCount = 0;
for (let id = 0; id < world.nextEntityId; id++) {
  if (ants.alive[id] === 1) liveCount++;
}
console.log(`Live ants: ${liveCount}`);
console.log('');

// --- 3. Tile-occupancy clusters ---------------------------------------------

interface ClusterCell {
  zone: number;
  colonyId: number;
  tileX: number;
  tileY: number;
  ids: number[];
}

const cells = new Map<string, ClusterCell>();
for (let id = 0; id < world.nextEntityId; id++) {
  if (ants.alive[id] !== 1) continue;
  const zone = ants.zone[id]!;
  const colonyId = zone === Zone.Underground
    ? (ants.currentGridColonyId[id]! >= 0 ? ants.currentGridColonyId[id]! : ants.colonyId[id]!)
    : ants.colonyId[id]!;
  const tileX = ants.posX[id]! >> FP_SHIFT;
  const tileY = ants.posY[id]! >> FP_SHIFT;
  const key = `${zone}:${colonyId}:${tileX},${tileY}`;
  let cell = cells.get(key);
  if (!cell) {
    cell = { zone, colonyId, tileX, tileY, ids: [] };
    cells.set(key, cell);
  }
  cell.ids.push(id);
}

const clusters = [...cells.values()]
  .filter((c) => c.ids.length >= CLUSTER_THRESHOLD)
  .sort((a, b) => b.ids.length - a.ids.length);

console.log(`Tile-occupancy clusters (≥${CLUSTER_THRESHOLD} ants on one tile): ${clusters.length}`);
for (const c of clusters) {
  const zoneLabel = c.zone === Zone.Underground ? 'underground' : 'surface    ';
  const sample = c.ids.slice(0, 6).join(', ');
  const more = c.ids.length > 6 ? ` …+${c.ids.length - 6}` : '';
  console.log(`  ${zoneLabel}  colony ${c.colonyId}  (${c.tileX.toString().padStart(3)}, ${c.tileY.toString().padStart(3)})  ${c.ids.length} ants  [${sample}${more}]`);
}
console.log('');

// --- 4. Stuck-in-dirt: underground ants on non-Open tiles -------------------

interface StuckInDirt {
  antId: number;
  colonyId: number;
  gridColonyId: number;
  tileX: number;
  tileY: number;
  tileState: number;
}

const stuckLabel: Record<number, string> = {
  [UndergroundTileState.Solid]:    'solid',
  [UndergroundTileState.Marked]:   'marked-for-dig',
  [UndergroundTileState.BeingDug]: 'being-dug',
  [UndergroundTileState.Open]:     'open',
};

const stuck: StuckInDirt[] = [];
for (let id = 0; id < world.nextEntityId; id++) {
  if (ants.alive[id] !== 1) continue;
  if (ants.zone[id] !== Zone.Underground) continue;
  const gridColonyId = ants.currentGridColonyId[id]! >= 0
    ? ants.currentGridColonyId[id]!
    : ants.colonyId[id]!;
  const grid = world.undergroundGrids[gridColonyId];
  if (!grid) continue;
  const tileX = ants.posX[id]! >> FP_SHIFT;
  const tileY = ants.posY[id]! >> FP_SHIFT;
  if (tileX < 0 || tileY < 0 || tileX >= grid.width || tileY >= grid.height) continue;
  const state = ugGet(grid, tileX, tileY);
  if (state === UndergroundTileState.Open) continue;
  stuck.push({
    antId: id,
    colonyId: ants.colonyId[id]!,
    gridColonyId,
    tileX,
    tileY,
    tileState: state,
  });
}

console.log(`Underground ants on non-Open tiles (stuck-in-dirt candidates): ${stuck.length}`);
const byClass = new Map<string, StuckInDirt[]>();
for (const s of stuck) {
  const k = stuckLabel[s.tileState] ?? `state-${s.tileState}`;
  (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(s);
}
for (const [cls, rows] of byClass) {
  console.log(`  ${cls} (${rows.length}):`);
  for (const r of rows.slice(0, 10)) {
    const grid = r.gridColonyId !== r.colonyId ? `  [in foreign grid ${r.gridColonyId}]` : '';
    console.log(`    ant ${r.antId}  colony ${r.colonyId}  (${r.tileX}, ${r.tileY})${grid}`);
  }
  if (rows.length > 10) console.log(`    …+${rows.length - 10} more`);
}

console.log('');

// --- 5. Motion-history analysis: stationary + oscillation -------------------
//
// Operates on the per-ant sliding window built during replay. Skips ants
// whose history is shorter than the full window (recently spawned or just
// resurrected) — they can't be confidently classified yet.
//
// Classification rules (mutually exclusive):
//   - Stationary: top tile in the window has ≥STATIONARY_FRACTION of samples.
//                 Captures both "literally not moving" and "twitches occasionally
//                 but mostly parked."
//   - Oscillation: window has ≤OSCILLATION_MAX_UNIQUE unique tiles AND failed
//                  the stationary test. Length-2 (A,B,A,B) and length-3
//                  (A,B,C,A,B,C) cycles both fall under this.

interface Classification {
  antId: number;
  kind: 'stationary' | 'oscillation';
  tiles: { zone: number; tileX: number; tileY: number; count: number }[];
  colonyId: number;
  gridColonyId: number;
  task: number;
  subTask: number;
}

function classifyHistory(antId: number, samples: Sample[]): Classification | null {
  if (samples.length < ANALYSIS_WINDOW_SAMPLES) return null;
  const counts = new Map<string, { zone: number; tileX: number; tileY: number; count: number }>();
  for (const s of samples) {
    const k = `${s.zone}:${s.tileX},${s.tileY}`;
    const e = counts.get(k);
    if (e) e.count++;
    else counts.set(k, { zone: s.zone, tileX: s.tileX, tileY: s.tileY, count: 1 });
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  const last = samples[samples.length - 1]!;
  const top = sorted[0]!;
  if (top.count >= STATIONARY_FRACTION * samples.length) {
    return {
      antId,
      kind: 'stationary',
      tiles: [top],
      colonyId: last.colonyId,
      gridColonyId: last.gridColonyId,
      task: last.task,
      subTask: last.subTask,
    };
  }
  if (counts.size <= OSCILLATION_MAX_UNIQUE) {
    return {
      antId,
      kind: 'oscillation',
      tiles: sorted,
      colonyId: last.colonyId,
      gridColonyId: last.gridColonyId,
      task: last.task,
      subTask: last.subTask,
    };
  }
  return null;
}

// Queens never move by design — collect their entity ids so they don't
// pollute the stationary report. (buildDebugSnapshot also skips them in
// the antTrace it emits for the same reason.)
const queenIds = new Set<number>();
for (const colony of Object.values(world.colonies)) {
  if (colony.queenEntityId >= 0) queenIds.add(colony.queenEntityId);
}

const stationary: Classification[] = [];
const oscillating: Classification[] = [];
for (const [antId, samples] of history) {
  // Only classify ants that are still alive in the captured snapshot —
  // skipping ants that died during the window's tail produces a tidier
  // report focused on actionable stuck/oscillating cases.
  if (ants.alive[antId] !== 1) continue;
  if (queenIds.has(antId)) continue;
  const c = classifyHistory(antId, samples);
  if (!c) continue;
  if (c.kind === 'stationary') stationary.push(c);
  else oscillating.push(c);
}

const WINDOW_TICKS = ANALYSIS_WINDOW_SAMPLES * SAMPLE_INTERVAL_TICKS;
const WINDOW_START = Math.max(0, debug.tick - WINDOW_TICKS);
console.log(
  `Motion-history analysis (sampled every ${SAMPLE_INTERVAL_TICKS} ticks, ` +
  `window = ${ANALYSIS_WINDOW_SAMPLES} samples = ${WINDOW_TICKS} ticks; ` +
  `covers ticks ${WINDOW_START}-${debug.tick}):`,
);
if (!replayMatches) {
  console.log(
    `  (replay diverged — motion below reflects the replayed trajectory, ` +
    `which may differ from the captured ants' real motion)`,
  );
}

// Group stationary ants by (zone, tile, colony) so 75 ants on the same tile
// surface as one line, not 75. Each group also tracks the majority
// (task, subTask) of its members so brood/nurses are visually distinct
// from forager/digger pile-ups.
interface StationaryGroup {
  zone: number;
  tileX: number;
  tileY: number;
  colonyId: number;
  ids: number[];
  taskCounts: Map<string, number>;
}
const stationaryGroups = new Map<string, StationaryGroup>();
for (const c of stationary) {
  const t = c.tiles[0]!;
  const k = `${t.zone}:${c.colonyId}:${t.tileX},${t.tileY}`;
  let g = stationaryGroups.get(k);
  if (!g) {
    g = { zone: t.zone, tileX: t.tileX, tileY: t.tileY, colonyId: c.colonyId, ids: [], taskCounts: new Map() };
    stationaryGroups.set(k, g);
  }
  g.ids.push(c.antId);
  const tk = describeTask(c.task, c.subTask);
  g.taskCounts.set(tk, (g.taskCounts.get(tk) ?? 0) + 1);
}
function dominantTask(counts: Map<string, number>): string {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '?';
  if (entries.length === 1) return entries[0]![0];
  const total = entries.reduce((s, e) => s + e[1], 0);
  const top = entries[0]!;
  if (top[1] === total) return top[0];
  return `${top[0]} (${top[1]}/${total}, +${entries.length - 1} others)`;
}
const stationarySorted = [...stationaryGroups.values()].sort((a, b) => b.ids.length - a.ids.length);

console.log(`  Stationary (${stationary.length} ants, ${stationarySorted.length} tiles):`);
for (const g of stationarySorted.slice(0, 15)) {
  const zoneLabel = g.zone === Zone.Underground ? 'underground' : 'surface    ';
  const sample = g.ids.slice(0, 6).join(', ');
  const more = g.ids.length > 6 ? ` …+${g.ids.length - 6}` : '';
  console.log(`    ${zoneLabel}  colony ${g.colonyId}  (${g.tileX.toString().padStart(3)}, ${g.tileY.toString().padStart(3)})  ${g.ids.length} ants  ${dominantTask(g.taskCounts)}  [${sample}${more}]`);
}
if (stationarySorted.length > 15) console.log(`    …+${stationarySorted.length - 15} more tiles`);

// Group oscillators by their tile-set so ants pinging the same (A↔B) eddy
// collapse to one report line. Each group also reports its dominant task.
interface OscGroup {
  zone: number;
  colonyId: number;
  tileSetKey: string;
  tiles: { tileX: number; tileY: number }[];
  ids: number[];
  taskCounts: Map<string, number>;
}
const oscGroups = new Map<string, OscGroup>();
for (const c of oscillating) {
  const t0 = c.tiles[0]!;
  // Canonical key: sort tiles by (tileX, tileY) so A↔B and B↔A collapse.
  const sortedTiles = [...c.tiles].sort((a, b) => (a.tileX - b.tileX) || (a.tileY - b.tileY));
  const tileSetKey = sortedTiles.map((tt) => `${tt.tileX},${tt.tileY}`).join('|');
  const k = `${t0.zone}:${c.colonyId}:${tileSetKey}`;
  let g = oscGroups.get(k);
  if (!g) {
    g = {
      zone: t0.zone,
      colonyId: c.colonyId,
      tileSetKey,
      tiles: sortedTiles.map((tt) => ({ tileX: tt.tileX, tileY: tt.tileY })),
      ids: [],
      taskCounts: new Map(),
    };
    oscGroups.set(k, g);
  }
  g.ids.push(c.antId);
  const tk = describeTask(c.task, c.subTask);
  g.taskCounts.set(tk, (g.taskCounts.get(tk) ?? 0) + 1);
}
const oscSorted = [...oscGroups.values()].sort((a, b) => b.ids.length - a.ids.length);

console.log(`  Oscillating (${oscillating.length} ants, ${oscSorted.length} eddies):`);
for (const g of oscSorted.slice(0, 15)) {
  const zoneLabel = g.zone === Zone.Underground ? 'underground' : 'surface    ';
  const cycle = g.tiles.map((tt) => `(${tt.tileX},${tt.tileY})`).join(' ↔ ');
  const sample = g.ids.slice(0, 6).join(', ');
  const more = g.ids.length > 6 ? ` …+${g.ids.length - 6}` : '';
  console.log(`    ${zoneLabel}  colony ${g.colonyId}  ${cycle}  length-${g.tiles.length}  ${g.ids.length} ants  ${dominantTask(g.taskCounts)}  [${sample}${more}]`);
}
if (oscSorted.length > 15) console.log(`    …+${oscSorted.length - 15} more eddies`);

console.log('');
console.log('Done.');

// Exit 1 on replay mismatch so CI / scripts can detect a determinism
// regression without parsing stdout. All other paths exit 0.
if (!replayMatches) process.exit(1);
