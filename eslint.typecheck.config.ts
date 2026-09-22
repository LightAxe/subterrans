// code/eslint.typecheck.config.ts
// Type-aware ESLint layer (typescript-eslint `recommended-type-checked`).
//
// Kept SEPARATE from eslint.config.ts on purpose. The fast config is what
// `npm run lint` and the per-edit sim-boundary hook run; adding type-aware
// rules there would rebuild the TS program on every single edit (seconds of
// latency per save). This config builds the program once and is gated only in
// `npm run lint:types`, `npm run verify`, and CI — where latency is fine.
//
// Covers src/, scripts/, tests/ and bench/ (*.ts). projectService auto-discovers
// the per-directory scripts/tsconfig.json, tests/tsconfig.json and
// bench/tsconfig.json with no extra `project` wiring (#301, #308), and the
// added type-check cost is small.
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
import simModuleState from './eslint-rules/sim-module-state.js';

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
    plugins: {
      '@typescript-eslint': tseslint,
      subterrans: { rules: { 'sim-module-state': simModuleState } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      ...tseslint.configs['recommended-type-checked'].rules,
      // Mirror eslint.config.ts: `_`-prefixed identifiers are intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test files legitimately use `any` (JSON.parse round-trips, deliberately
    // malformed validation inputs, loose mocks/spies) and loose async (mock
    // handlers typed `async` to match a Promise-returning signature without
    // awaiting). Enforcing the `any`-flow and async-shape rules here would mean
    // contorting fixtures for no shipped-code benefit. The genuine bug-catchers
    // (no-floating-promises, no-misused-promises, await-thenable) stay ON
    // everywhere — only the low-value-in-tests rules are relaxed. The
    // Playwright specs get the same treatment (#308); tests/helpers/ and
    // tests/cross-engine/ are shared code and stay under the full rule set.
    files: ['src/**/*.test.ts', 'tests/**/*.spec.ts'],
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
