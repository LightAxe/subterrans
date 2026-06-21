// code/eslint-rules/sim-module-state.test.ts
// Executable contract for the subterrans/sim-module-state rule (issue #211).
// Drives ESLint's Linter over every row of PLAN.md's 5a matrix so a broken
// implementation (e.g. missing `export const`, or treating `as number[]` like
// `as const`) fails CI instead of silently passing.
//
// Wired into Vitest via `eslint-rules/**/*.test.ts` in vitest.config.ts — keep
// the rule + this test OUT of src/ so the tooling never enters the app bundle,
// the src/sim lint scope, or the sim-boundary checks.
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import rule from './sim-module-state.js';

const linter = new Linter({ configType: 'flat' });

/** Lint one snippet with only this rule enabled; return its violation count. */
function violations(code: string): number {
  const messages = linter.verify(code, {
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { subterrans: { rules: { 'sim-module-state': rule } } },
    rules: { 'subterrans/sim-module-state': 'error' },
  });
  // A parser fatal would yield 0 rule violations and falsely "pass" a FLAGGED row.
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`parse error in snippet: ${fatal.message}\n${code}`);
  return messages.filter((m) => m.ruleId === 'subterrans/sim-module-state').length;
}

// Every row that MUST be flagged (5a matrix).
const FLAGGED: ReadonlyArray<readonly [string, string]> = [
  ['bare array literal', 'const A = [1, 2, 3];'],
  ['exported array literal', 'export const A = [1, 2, 3];'],
  ['array via `as number[]` assertion', 'const A = [1, 2, 3] as number[];'],
  ['array via `satisfies`', 'const A = [1, 2, 3] satisfies readonly number[];'],
  ['array with ReadonlyArray<> annotation', 'const A: ReadonlyArray<number> = [1, 2, 3];'],
  ['new Map()', 'const M = new Map();'],
  ['new Map() as ReadonlyMap', 'const M = new Map() as ReadonlyMap<number, number>;'],
  ['new Int32Array()', 'const B = new Int32Array(8);'],
  ['let scalar', 'let X = 0;'],
  ['exported let', 'export let Y = 0;'],
  ['let bound to typed array', 'let B = new Int32Array(0);'],
  [
    'array `as const as number[]` (outer assertion mutable)',
    'const A = [1, 2, 3] as const as number[];',
  ],
  ['array `as unknown as const`', 'const A = [1, 2, 3] as unknown as const;'],
  ['array `as number[] as const`', 'const A = [1, 2, 3] as number[] as const;'],
];

// Every row that MUST NOT be flagged (exemptions + documented gaps).
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ['array `as const`', 'const A = [1, 2, 3] as const;'],
  ['exported array `as const`', 'export const A = [1, 2, 3] as const;'],
  ['const scalar', 'const N = 5;'],
  ['new RegExp (not a collection)', "const R = new RegExp('x');"],
  ['new Error (not a collection)', "const E = new Error('x');"],
  ['plain object (documented gap)', 'const O = { a: 1 };'],
  ['namespace-scoped let (documented gap)', 'namespace N { let X = 0; }'],
  ['qualified ctor new globalThis.Array() (documented gap)', 'const M = new globalThis.Array();'],
  ['function-local array', 'function f() { const t: number[] = []; return t; }'],
  ['function-local let', 'function f() { let t = 0; return t; }'],
];

describe('subterrans/sim-module-state', () => {
  for (const [name, code] of FLAGGED) {
    it(`flags: ${name}`, () => {
      expect(violations(code)).toBeGreaterThan(0);
    });
  }
  for (const [name, code] of ALLOWED) {
    it(`allows: ${name}`, () => {
      expect(violations(code)).toBe(0);
    });
  }
});
