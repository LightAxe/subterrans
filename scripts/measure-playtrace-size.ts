// scripts/measure-playtrace-size.ts
// Issue #295 — how big is a playtrace envelope, really?
//
// `includeSnapshot` defaulted to false until #295 flipped it (2026-09-20), so
// playtest reports arrived with a seed and a sentence. The open question that
// blocked the flip was size: the one snapshot we had was 7 KB gzipped for a
// 1,196-tick round, while a real round can run to the 24,000-tick match timeout,
// and both `antTrace` and `inputLog` grow with duration. This harness produced
// the numbers the decision was made on; keep it runnable so a future change to
// the snapshot shape can be re-measured the same way.
//
// This harness answers that by running a real matchup headlessly — by default
// the same `runAIController(world, ENEMY_COLONY_ID)`-against-a-passive-player
// scenario `check-ai-economy.ts` uses, or, with --both-ai, the same controller
// driving BOTH colonies (see below) — and, at each checkpoint tick, building the four
// payloads `submitPlaytrace`'s downgrade chain would produce and gzipping each
// one through the SAME `gzipString` the browser uses (CompressionStream, not
// node:zlib), so the byte counts are the ones that would actually go on the
// wire:
//
//   1. full            — snapshot + antTrace + inputLog + events + summary
//   2. -antTrace       — downgrade stage 2
//   3. -antTrace/-inputLog — downgrade stage 3
//   4. survey-only     — downgrade stage 4 (what every report carries today)
//
// Each is reported against PLAYTRACE_MAX_GZIPPED_BYTES (the 5 MB client cap,
// mirrored server-side by the playtrace Lambda).
//
// It also reports the drain tick of every sim-origin self-emitted command,
// which is the input #296's regression test needed to pick a scenario.
//
// NOT wired into `npm run verify` — a 24,000-tick match takes minutes. Run it
// by hand when the size question comes up again:
//
//   npm run measure:playtrace-size
//   node --experimental-strip-types scripts/measure-playtrace-size.ts --seeds=3
//
// Optional args: --seeds=N  --difficulty=Easy|Normal|Hard  --checkpoints=6000,12000,24000
//                --both-ai   drive BOTH colonies with runAIController instead of
//                            leaving the player passive. The passive arm
//                            under-represents a real session (a do-nothing
//                            player's colony stays small and issues no
//                            commands), so this is the upper-bound arm: two
//                            growing colonies, twice the ants in the world
//                            snapshot and antTrace, and a player inputLog.

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

// playtrace-upload.ts reads the build-time `__APP_VERSION__` define inside
// buildPlaytraceEnvelope. Vite injects it in the app build; outside Vite the
// bare identifier resolves to the global, so seed it before the import.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-measure';

const { createScenario } = await import('../src/sim/scenario.js');
const { tick } = await import('../src/sim/tick.js');
const { PLAYER_COLONY_ID, ENEMY_COLONY_ID, MATCH_TIMEOUT_TICKS } =
  await import('../src/sim/constants.js');
const { runAIController } = await import('../src/render/ai-controller.js');
const { buildDebugSnapshot } = await import('../src/platform/debug-snapshot.js');
const { buildPlaytraceSummary } = await import('../src/render/summary-builder.js');
const { buildPlaytraceEnvelope, gzipString, PLAYTRACE_MAX_GZIPPED_BYTES } =
  await import('../src/render/playtrace-upload.js');
const { GameOutcome } = await import('../src/sim/game-over.js');
const { outcomeToWire } = await import('../src/render/playtrace-upload.js');
const { isAlive } = await import('../src/sim/ant/ant-store.js');
const { stampDrainTick } = await import('../src/sim/commands.js');

import type { WorldState } from '../src/sim/types.js';
import type { GameOutcome as GameOutcomeValue } from '../src/sim/game-over.js';
import type { SimCommand } from '../src/sim/commands.js';
import type { PlaytraceSubmissionInput } from '../src/render/playtrace-upload.js';

/** Exit 2 with a message. A measurement harness that silently substitutes a
 *  default for a typo'd flag reports numbers for a run nobody asked for, which
 *  is worse than not running at all — these figures get quoted as authoritative
 *  (see PLAYTRACE_INCLUDE_SNAPSHOT_DEFAULT's docstring). */
function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/** Parse `--name=<number>`. A PRESENT-but-unparseable value is fatal; only an
 *  absent flag falls back. */
function parseNumArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith(prefix)) continue;
    const raw = a.slice(prefix.length);
    const n = Number(raw);
    // Number('') is 0 and Number(' ') is 0, so reject blank explicitly.
    if (raw.trim() === '' || !Number.isFinite(n)) {
      bail(`--${name}=${raw} is not a number.`);
    }
    return n;
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

const BOTH_AI = process.argv.slice(2).includes('--both-ai');
const SEEDS = parseNumArg('seeds', 3);
const DIFFICULTY = parseStrArg('difficulty', 'Normal') as 'Easy' | 'Normal' | 'Hard';
// EVERY token must be a positive integer tick. Dropping the bad ones (the old
// `.filter`) turned `--checkpoints=6000,abc` into a silent single-checkpoint
// run, and `--checkpoints=abc` into the default three.
const CHECKPOINT_TOKENS = parseStrArg('checkpoints', `6000,12000,${MATCH_TIMEOUT_TICKS}`)
  .split(',')
  .map((tok) => tok.trim());
const CHECKPOINTS = CHECKPOINT_TOKENS.map((tok) => {
  const n = Number(tok);
  if (tok === '' || !Number.isInteger(n) || n <= 0) {
    bail(`--checkpoints: "${tok}" is not a positive integer tick.`);
  }
  return n;
}).sort((a, b) => a - b);

if (!Number.isInteger(SEEDS) || SEEDS < 1) {
  bail(`--seeds=${SEEDS} must be an integer >= 1.`);
}
if (DIFFICULTY !== 'Easy' && DIFFICULTY !== 'Normal' && DIFFICULTY !== 'Hard') {
  bail(`Unknown --difficulty=${DIFFICULTY}; expected Easy|Normal|Hard.`);
}
if (CHECKPOINTS.length === 0) {
  bail('--checkpoints must list at least one positive integer tick.');
}

interface StageSizes {
  full: number;
  noAntTrace: number;
  noAntTraceNoInputLog: number;
  surveyOnly: number;
}

interface Checkpoint extends StageSizes {
  seed: number;
  tick: number;
  liveAnts: number;
  inputLogLength: number;
  eventCount: number;
  /** True when this row is the round's actual end (a terminal GameOutcome),
   *  which is the only tick a real submission is ever built at. */
  atRoundEnd: boolean;
}

/** The outcomes a real submission can carry. `GameOutcome.None` is not one of
 *  them — `outcomeToWire` throws on it, because the survey only opens on a
 *  terminal outcome — so a mid-round checkpoint has to borrow a stand-in. */
type TerminalOutcome = Exclude<GameOutcomeValue, typeof GameOutcome.None>;

/** Stand-in for the checkpoint rows, which are snapshots of a round still in
 *  progress and so have no outcome of their own. Defeat is the common real
 *  case; the choice is cosmetic here — `outcome` appears in the envelope as one
 *  short string and moves the gzipped size by a byte or two — but it must be a
 *  terminal value or the envelope build throws. Terminal rows use the outcome
 *  `tick()` actually returned. */
const CHECKPOINT_PLACEHOLDER_OUTCOME: TerminalOutcome = GameOutcome.Defeat;

function liveAntCount(world: WorldState): number {
  let n = 0;
  for (let id = 0; id < world.nextEntityId; id++) if (isAlive(world.ants, id)) n++;
  return n;
}

/**
 * Build and gzip the four payloads submitPlaytrace's downgrade chain would try,
 * in the same order and with the same content. Mirrors buildPayloadWithDowngrade
 * rather than calling it, because that function short-circuits as soon as a
 * stage fits — here every stage is wanted regardless.
 */
async function measure(
  world: WorldState,
  seed: number,
  inputLog: SimCommand[],
  outcome: TerminalOutcome,
): Promise<StageSizes> {
  const wireOutcome = outcomeToWire(outcome);
  const input: PlaytraceSubmissionInput = {
    endpoint: '/api/playtrace',
    sessionId: '00000000-0000-4000-8000-000000000000',
    outcome,
    quitFromPauseMenu: false,
    includeSnapshot: true,
    world,
    seed,
    inputLog,
    survey: { rating: 3, freeText: '', brokenFlag: false },
    resumedFromSave: false,
  };
  const events = world.events.slice();
  const summary = buildPlaytraceSummary(world, false, wireOutcome);
  const snap = buildDebugSnapshot(world, seed, inputLog);
  const full = buildPlaytraceEnvelope(input, snap, events, summary);
  const { events: _ev, summary: _sm, ...surveyOnlyBase } = full;

  const sizeOf = async (e: unknown): Promise<number> => (await gzipString(JSON.stringify(e))).size;
  return {
    full: await sizeOf(full),
    noAntTrace: await sizeOf({ ...full, snapshot: { ...snap, antTrace: [] } }),
    noAntTraceNoInputLog: await sizeOf({
      ...full,
      snapshot: { ...snap, antTrace: [], inputLog: [] },
    }),
    surveyOnly: await sizeOf({ ...surveyOnlyBase, snapshot: null }),
  };
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function pct(n: number): string {
  return `${((n / PLAYTRACE_MAX_GZIPPED_BYTES) * 100).toFixed(1)}%`;
}

const maxTick = CHECKPOINTS[CHECKPOINTS.length - 1]!;
console.log(
  `measure-playtrace-size: ${SEEDS} seed(s), difficulty=${DIFFICULTY}, ` +
    `checkpoints=${CHECKPOINTS.join(',')}, cap=${fmtBytes(PLAYTRACE_MAX_GZIPPED_BYTES)} gzipped, ` +
    `player=${BOTH_AI ? 'AI-driven (upper bound)' : 'passive (lower bound)'}`,
);
console.log('');

const rows: Checkpoint[] = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const world = createScenario(seed, DIFFICULTY);
  const inputLog: SimCommand[] = [];
  const simOriginDrains: { drainTick: number; issuedAtTick: number; type: string }[] = [];
  const checkpointSet = new Set(CHECKPOINTS);
  let roundEndTick: number | null = null;
  let roundEndOutcome: GameOutcomeValue = GameOutcome.None;

  const record = async (atRoundEnd: boolean, outcome: TerminalOutcome): Promise<void> => {
    const sizes = await measure(world, seed, inputLog, outcome);
    rows.push({
      seed,
      tick: world.tick,
      liveAnts: liveAntCount(world),
      inputLogLength: inputLog.length,
      eventCount: world.events.length,
      atRoundEnd,
      ...sizes,
    });
    process.stdout.write(
      `  seed ${seed} @ ${world.tick}: measured${atRoundEnd ? ' (round end)' : ''}\n`,
    );
  };

  for (let t = 0; t < maxTick; t++) {
    runAIController(world, ENEMY_COLONY_ID);
    // --both-ai: drive the player colony with the same controller so the
    // snapshot carries two growing colonies and a non-trivial player inputLog.
    // Without it the player is passive, which is the same "AI vs do-nothing
    // player" arm check-ai-economy.ts runs — a LOWER bound on payload size.
    if (BOTH_AI) runAIController(world, PLAYER_COLONY_ID);
    const drainTick = world.tick;
    const cmds = world.commandQueue.splice(0);
    // #296 — stamp exactly as createGameLoop does, so the measured inputLog has
    // the same shape as one a real session would upload. Without this the bytes
    // reported here would be of a payload the game no longer produces.
    stampDrainTick(cmds, drainTick);
    for (const c of cmds) {
      inputLog.push(c);
      if (c.origin === 'sim') {
        simOriginDrains.push({ drainTick, issuedAtTick: c.issuedAtTick, type: c.type });
      }
    }
    const outcome = tick(world, cmds);
    if (checkpointSet.has(world.tick) && outcome === GameOutcome.None) {
      await record(false, CHECKPOINT_PLACEHOLDER_OUTCOME);
    }
    // Stop at the terminal outcome. Ticking past game-over would keep measuring
    // a world whose colonies have collapsed — a SMALLER antTrace than the round
    // that actually ended — and the survey only ever fires here, so this is the
    // one tick a real submission is built at.
    if (outcome !== GameOutcome.None) {
      // A tick that is BOTH a checkpoint and the round's end is recorded once,
      // here, with the real outcome — the checkpoint branch above deliberately
      // skips it so the row is not written twice with a placeholder.
      await record(true, outcome);
      roundEndTick = world.tick;
      roundEndOutcome = outcome;
      break;
    }
  }

  if (roundEndTick !== null) {
    console.log(
      `  seed ${seed}: round ended at tick ${roundEndTick} ` +
        `(${outcomeToWire(roundEndOutcome as TerminalOutcome)}) — later checkpoints skipped`,
    );
  }
  if (simOriginDrains.length === 0) {
    console.log(`  seed ${seed}: no sim-origin self-emits before tick ${world.tick}`);
  } else {
    const late = simOriginDrains.filter((d) => d.drainTick > d.issuedAtTick).length;
    console.log(
      `  seed ${seed}: ${simOriginDrains.length} sim-origin self-emit(s), ` +
        `${late} drained later than issuedAtTick — ` +
        simOriginDrains
          .slice(0, 6)
          .map((d) => `${d.type}@issued=${d.issuedAtTick}/drained=${d.drainTick}`)
          .join(', '),
    );
  }
}

console.log('');
const header = [
  'seed'.padStart(4),
  'tick'.padStart(6),
  'ants'.padStart(5),
  'cmds'.padStart(5),
  'events'.padStart(6),
  'full'.padStart(10),
  '-antTrace'.padStart(10),
  '-both'.padStart(10),
  'survey'.padStart(9),
].join('  ');
console.log(header);
console.log('-'.repeat(header.length));
for (const r of rows) {
  console.log(
    [
      String(r.seed).padStart(4),
      String(r.tick).padStart(6),
      String(r.liveAnts).padStart(5),
      String(r.inputLogLength).padStart(5),
      String(r.eventCount).padStart(6),
      fmtBytes(r.full).padStart(10),
      fmtBytes(r.noAntTrace).padStart(10),
      fmtBytes(r.noAntTraceNoInputLog).padStart(10),
      fmtBytes(r.surveyOnly).padStart(9),
      r.atRoundEnd ? '  <- round end' : '',
    ].join('  '),
  );
}

console.log('');
if (rows.length === 0) {
  console.error('No checkpoints were reached — every round ended before the first one.');
  process.exit(1);
}
const worstFull = rows.reduce((a, b) => (b.full > a.full ? b : a), rows[0]!);
console.log(
  `Largest full envelope: ${fmtBytes(worstFull.full)} (${pct(worstFull.full)} of the ${fmtBytes(
    PLAYTRACE_MAX_GZIPPED_BYTES,
  )} cap) — seed ${worstFull.seed} @ tick ${worstFull.tick}.`,
);
const overCap = rows.filter((r) => r.full > PLAYTRACE_MAX_GZIPPED_BYTES);
console.log(
  overCap.length === 0
    ? 'Every measured full envelope fits the cap — the downgrade chain never fires.'
    : `${overCap.length}/${rows.length} full envelopes exceed the cap and would downgrade.`,
);
