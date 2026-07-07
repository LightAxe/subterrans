// code/eslint.config.ts
// ESLint 10 flat config with per-directory overrides for the Subterrans sim/render boundary.
// Source: RESEARCH.md Pattern 1, lines 180–316 — verified against ESLint 10 + @typescript-eslint 8 docs.
//
// Three config objects, applied in order:
//   1. baseConfig         — baseline TS rules for all src/**/*.ts AND bench/**/*.ts
//   2. simSafetyConfig    — PRD §6 Rule Sets 1 & 2: Phaser ban, wall-clock ban, float+division ban (src/sim/** only)
//   3. nonSimMutationGuard — FNDN-07 tripwire: catches obvious direct writes to WorldState fields
//                            from src/render/, src/input/, src/platform/
//
// NOTE: The nonSimMutationGuard is a TRIPWIRE — it catches shallow top-level field assignments.
// Nested writes (world.ants.alive[id] = 0) are NOT caught here; they are caught by
// scripts/check-sim-boundary.sh (the grep backstop). See RESEARCH.md Pattern 1c for details.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import simModuleState from './eslint-rules/sim-module-state.js';

/** Rules applied to ALL TypeScript source files */
const baseConfig = {
  files: ['src/**/*.ts', 'bench/**/*.ts'],
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    // Baseline TS rules (non-type-checked — no project overhead)
    ...tseslint.configs.recommended.rules,
    // Allow _-prefixed identifiers to signal intentionally unused args/vars.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
  },
};

/** FNDN-02 — ban float literals and division (both return IEEE 754 doubles).
 *  Extracted (#241) so the src/sim test-file override can re-apply EXACTLY these
 *  without the dynamic-import ban: flat config REPLACES a rule's whole options
 *  array for a matching file, it does not merge. */
const simFloatDivisionSelectors = [
  {
    // Matches any numeric literal whose source text signals floating-point intent:
    //   - decimal point anywhere after leading digits: 3.14, 1.5, 0.5, 1.0, .5, 1.e5
    //   - scientific notation: 1e3, 1e-3, 2E10, 1.5e2
    // The ^\d* anchor spares string literals (raw starts with ") and hex/binary/octal
    // literals (raw starts with 0x, 0b, 0o — the non-digit char after 0 breaks the match).
    selector: 'Literal[raw=/^\\d*(\\.|\\d[eE])/]',
    message:
      'Float literal (decimal or scientific notation) in src/sim/ — convert to fixed-point integer (multiply by FP_ONE).',
  },
  {
    // JS integer division still returns IEEE 754 double.
    // fpDiv() in src/sim/fixed.ts needs one `// eslint-disable-next-line` on its own line.
    selector: "BinaryExpression[operator='/']",
    message: 'Division in src/sim/ returns a float — use fpDiv() instead.',
  },
];

/** #230 — ban raw `<x>.commandQueue.push(...)`: every producer must route through
 *  pushCommand(world, cmd) (src/sim/commands.ts), the single provenance chokepoint.
 *  Added to BOTH no-restricted-syntax arrays (simSafetyConfig for src/sim, and
 *  nonSimMutationGuard for render/input/platform) since it applies across layers.
 *  The chokepoint itself carries an inline disable; the game-loop `.splice` drain is
 *  not matched (`.splice`, not `.push`); non-sim test files re-drop it below. */
const commandQueuePushBanSelector = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='push']" +
    "[callee.object.type='MemberExpression'][callee.object.property.name='commandQueue']",
  message:
    'Route through pushCommand(world, cmd) (src/sim/commands.ts) — the #230 provenance chokepoint. Raw world.commandQueue.push bypasses it.',
};

/** FNDN-07 tripwire selectors — direct writes/updates to WorldState sim-state fields
 *  from a non-sim layer. Extracted so the non-sim TEST override (#230) can keep the
 *  tripwire active (test fixtures that write world.tick carry their own inline
 *  disables) while dropping ONLY the commandQueue-push ban. */
const nonSimWriteTripwireSelectors = [
  {
    // Tripwire: catches `world.tick = ...`, `world.rngState = ...`, whole-field replacement.
    selector:
      "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(tick|rngState|nextEntityId|ants|colonies|pheromoneGrids|surface|undergroundGrids|pendingChambers)$/]",
    message:
      'FNDN-07 tripwire: direct write to WorldState sim-state field from non-sim layer. Push a SimCommand onto world.commandQueue instead (PRD §5). [Nested writes like world.colonies[id].x are not caught by lint — see grep guard.]',
  },
  {
    // Tripwire: catches `world.tick++`, `--world.nextEntityId`, etc.
    selector:
      "UpdateExpression[argument.type='MemberExpression'][argument.property.name=/^(tick|rngState|nextEntityId|ants|colonies|pheromoneGrids|surface|undergroundGrids|pendingChambers)$/]",
    message:
      'FNDN-07 tripwire: UpdateExpression on WorldState sim-state field from non-sim layer. Mutations happen inside tick(); use a SimCommand.',
  },
];

/** Sim-layer-specific safety rules — mirrors PRD §6 Rule Sets 1 & 2 verbatim.
 *  Applied ONLY to src/sim/**\/*.ts.
 */
const simSafetyConfig = {
  files: ['src/sim/**/*.ts'],
  rules: {
    // FNDN-04 (PRD Rule Set 1) — Phaser + cross-layer import bans
    // patterns (glob form) required — string `paths` form only matches exact strings (RESEARCH.md Pitfall 2).
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['phaser', 'phaser/*'],
            message: 'Phaser is banned in src/sim/. The sim layer must be pure TypeScript.',
          },

          // Relative paths — any-depth globbing (src/sim/systems/ai/foo.ts → ../../../render/...)
          {
            group: ['**/render', '**/render/**'],
            message: 'src/sim/ cannot import from render/ at any path depth.',
          },
          {
            group: ['**/input', '**/input/**'],
            message: 'src/sim/ cannot import from input/ at any path depth.',
          },
          {
            group: ['**/platform', '**/platform/**'],
            message: 'src/sim/ cannot import from platform/ at any path depth.',
          },

          // Alias paths (@/ prefix configured in tsconfig.json)
          {
            group: ['@/render', '@/render/**'],
            message: 'src/sim/ cannot import from src/render/ (even via alias).',
          },
          {
            group: ['@/input', '@/input/**'],
            message: 'src/sim/ cannot import from src/input/ (even via alias).',
          },
          {
            group: ['@/platform', '@/platform/**'],
            message: 'src/sim/ cannot import from src/platform/ (even via alias).',
          },
        ],
      },
    ],

    // FNDN-05 (PRD Rule Set 2) — wall-clock, async, browser globals, network bans
    'no-restricted-properties': [
      'error',
      { object: 'Math', property: 'random', message: 'Use the seeded Rng instance.' },
      { object: 'Math', property: 'sqrt', message: 'Use integer approximations or lookup tables.' },
      { object: 'Math', property: 'sin', message: 'Use a fixed-point lookup table.' },
      { object: 'Math', property: 'cos', message: 'Use a fixed-point lookup table.' },
      {
        object: 'Math',
        property: 'atan2',
        message: 'Use a fixed-point angle helper / lookup table.',
      },
    ],
    'no-restricted-globals': [
      'error',
      {
        name: 'Date',
        message: 'Wall-clock time is banned in src/sim/. Time = tickCount * MS_PER_TICK.',
      },
      { name: 'performance', message: 'Wall-clock time is banned in src/sim/.' },
      { name: 'setTimeout', message: 'Async scheduling is banned in src/sim/.' },
      { name: 'setInterval', message: 'Async scheduling is banned in src/sim/.' },
      { name: 'window', message: 'Browser globals are banned in src/sim/.' },
      { name: 'document', message: 'Browser globals are banned in src/sim/.' },
      { name: 'navigator', message: 'Browser globals are banned in src/sim/.' },
      { name: 'localStorage', message: 'Browser storage is banned in src/sim/.' },
      { name: 'requestAnimationFrame', message: 'Frame scheduling is banned in src/sim/.' },
      { name: 'cancelAnimationFrame', message: 'Frame scheduling is banned in src/sim/.' },
      { name: 'fetch', message: 'Network access is banned in src/sim/.' },
      { name: 'XMLHttpRequest', message: 'Network access is banned in src/sim/.' },
    ],

    // FNDN-02 — ban float literals and division (shared selectors above); and
    // #241 — ban dynamic import() in src/sim/ (static no-restricted-imports can't
    // see `await import(...)`, so a sim file could dynamically pull in Phaser and
    // nothing would catch it). Test files re-drop the ImportExpression ban below.
    'no-restricted-syntax': [
      'error',
      ...simFloatDivisionSelectors,
      commandQueuePushBanSelector, // #230
      {
        selector: 'ImportExpression',
        message:
          'Dynamic import() is banned in src/sim/ — it bypasses the static sim-boundary import check. Use a static import.',
      },
    ],
  },
};

/** Non-sim layers: tripwire for obvious writes to WorldState sim-state fields.
 *  FNDN-07 staging-seam enforcement — platform/render/input must use world.commandQueue.
 *  Platform IS included here because the accumulator must only READ sim-state fields
 *  (e.g., world.tick) and PUSH/DRAIN commandQueue.
 *
 *  SCOPE HONESTY — WHAT THIS RULE CATCHES vs MISSES:
 *  Catches (shallow, top-level assignments where the LAST property-name matches a banned field):
 *    world.tick = 0                         ✓ caught
 *    worldState.rngState = 123              ✓ caught
 *    world.colonies = {}                    ✓ caught (whole-field replacement)
 *    world.tick++  /  --world.nextEntityId  ✓ caught (UpdateExpression selector)
 *  MISSES (nested / computed writes):
 *    world.colonies[id].foodStored = 100    ✗ LAST property is `foodStored`, not in regex
 *    world.ants.posX[eid] = 50             ✗ LAST property is computed index
 *    const w = world; w.tick = 1           ✗ aliased variable defeats selector
 *  → The real backstop for nested writes is scripts/check-sim-boundary.sh (Pattern 1c).
 *
 *  NOTE: `commandQueue` is intentionally ABSENT from the regex below.
 *  Staging-seam writes (world.commandQueue.push(...), world.commandQueue = [])
 *  are the CORRECT write pattern from non-sim layers and MUST pass.
 */
const nonSimMutationGuard = {
  files: ['src/render/**/*.ts', 'src/input/**/*.ts', 'src/platform/**/*.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      ...nonSimWriteTripwireSelectors,
      commandQueuePushBanSelector, // #230 — raw push bypasses the provenance chokepoint
    ],
  },
};

/** Determinism guard (issue #211) — module-level mutable state in src/sim must be
 *  `as const` (immutable arrays) or carry an explicit `subterrans/sim-module-state`
 *  disable with a sim-scratch/sim-cache/sim-memo reason. The rule + its test live in
 *  eslint-rules/ (outside src/) so the tooling stays out of the app bundle and this
 *  very lint scope. Test files are exempt — their throwaway fixtures aren't sim state. */
const simModuleStateConfig = {
  files: ['src/sim/**/*.ts'],
  ignores: ['src/sim/**/*.test.ts'],
  plugins: { subterrans: { rules: { 'sim-module-state': simModuleState } } },
  rules: { 'subterrans/sim-module-state': 'error' },
};

/** #241 — src/sim test files legitimately use dynamic `await import()` (e.g.
 *  determinism.test.ts, tick.test.ts load platform/sim modules at runtime), so the
 *  ImportExpression ban is dropped for them. The float/division bans are RE-APPLIED
 *  (flat config replaces the whole no-restricted-syntax array, so they must be
 *  restated or test files would silently lose them). Must be LAST so it wins. */
const simTestImportOverride = {
  files: ['src/sim/**/*.test.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...simFloatDivisionSelectors],
  },
};

/** #230 — non-sim TEST files (render/input/platform) build command queues directly
 *  as fixtures, so drop ONLY the commandQueue-push ban for them while KEEPING the
 *  FNDN-07 write tripwire (some fixtures write world.tick with their own inline
 *  disables, which would go unused if the whole rule were turned off). Sim test files
 *  are handled by simTestImportOverride above. Must come after nonSimMutationGuard. */
const nonSimTestCommandQueueOverride = {
  files: ['src/render/**/*.test.ts', 'src/input/**/*.test.ts', 'src/platform/**/*.test.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...nonSimWriteTripwireSelectors],
  },
};

export default [
  baseConfig,
  simSafetyConfig,
  nonSimMutationGuard,
  simModuleStateConfig,
  simTestImportOverride,
  nonSimTestCommandQueueOverride,
];
