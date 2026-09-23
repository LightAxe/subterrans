// code/eslint.typecheck.config.ts
// Type-aware ESLint layer (typescript-eslint `recommended-type-checked`).
//
// Kept SEPARATE from eslint.config.ts on purpose. The fast config is what
// `npm run lint` and the per-edit sim-boundary hook run; adding type-aware
// rules there would rebuild the TS program on every single edit (seconds of
// latency per save). This config builds the program once and is gated only in
// `npm run lint:types`, `npm run verify`, and CI — where latency is fine.
//
// Covers src/, scripts/, tests/, bench/ and, since #314, the root tooling configs
// plus eslint-rules/ (*.ts). projectService auto-discovers
// the per-directory scripts/tsconfig.json, tests/tsconfig.json and
// bench/tsconfig.json with no extra `project` wiring (#301, #308), and the
// added type-check cost is small. The root tooling configs and eslint-rules/
// (#314) are the one place auto-discovery cannot work — the nearest
// tsconfig.json is the root one, which includes only src/ — so that config
// object below names tsconfig.tooling.json explicitly via `project`.
//
// Scope note: this config intentionally does NOT re-enable the sim-safety
// rules (Phaser/wall-clock/float bans, mutation guard, sim-module-state) —
// eslint.config.ts owns those and owns disable-directive usage reporting. We
// turn reportUnusedDisableDirectives off here so the sim-rule disable comments
// (e.g. `// eslint-disable-line no-restricted-syntax`) aren't falsely flagged as
// unused. The `subterrans` plugin IS registered below (rule left off) so that
// `subterrans/sim-module-state` disable directives resolve to a known rule
// instead of erroring as "Definition for rule … was not found".
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import simModuleState from './eslint-rules/sim-module-state.ts';

/** `tseslint.configs` is an index signature, so under `noUncheckedIndexedAccess`
 *  a preset lookup is `T | undefined`. Fail loudly rather than spread `undefined`
 *  (which would silently drop every type-aware rule). */
function presetRules(name: string): NonNullable<(typeof tseslint.configs)[string]['rules']> {
  const preset = tseslint.configs[name];
  if (preset === undefined || preset.rules === undefined) {
    throw new Error(`eslint.typecheck.config.ts: @typescript-eslint preset "${name}" not found`);
  }
  return preset.rules;
}

const plugins = {
  '@typescript-eslint': tseslint,
  subterrans: { rules: { 'sim-module-state': simModuleState } },
};

const rules = {
  ...presetRules('recommended-type-checked'),
  // Mirror eslint.config.ts: `_`-prefixed identifiers are intentionally unused.
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
};

export default [
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', 'bench/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins,
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules,
  },
  {
    // #314 — root tooling configs (`*.ts` matches root-level files only) and
    // eslint-rules/: the custom rule module itself (#317, since it became .ts) and
    // its contract tests. Same rule set; the TS program is the
    // dedicated tsconfig.tooling.json (also what `npm run typecheck:tooling` runs).
    files: ['*.ts', 'eslint-rules/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.tooling.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins,
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules,
  },
  {
    // Test files legitimately use `any` (JSON.parse round-trips, deliberately
    // malformed validation inputs, loose mocks/spies) and loose async (mock
    // handlers typed `async` to match a Promise-returning signature without
    // awaiting). Enforcing the `any`-flow and async-shape rules here would mean
    // contorting fixtures for no shipped-code benefit. The genuine bug-catchers
    // (no-floating-promises, no-misused-promises, await-thenable) stay ON
    // everywhere — only the low-value-in-tests rules are relaxed. The
    // Playwright specs (#308) and the eslint-rules/ contract tests (#314) get the
    // same treatment; tests/helpers/ and tests/cross-engine/ are shared code and
    // stay under the full rule set.
    files: ['src/**/*.test.ts', 'tests/**/*.spec.ts', 'eslint-rules/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
];
