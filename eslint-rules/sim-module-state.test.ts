// code/eslint-rules/sim-module-state.test.ts
// Executable contract for the subterrans/sim-module-state rule (issue #211).
// Drives ESLint's Linter over a comprehensive matrix so a broken implementation
// fails CI instead of silently passing. Each row is one declaration; FLAGGED rows
// must produce ≥1 violation, ALLOWED rows must produce 0.
//
// Wired into Vitest via `eslint-rules/**/*.test.ts` in vitest.config.ts — keep the
// rule + this test OUT of src/ so the tooling never enters the app bundle, the
// src/sim lint scope, or the sim-boundary checks.
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
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`parse error in snippet: ${fatal.message}\n${code}`);
  return messages.filter((m) => m.ruleId === 'subterrans/sim-module-state').length;
}

// MUST be flagged (≥1 violation).
const FLAGGED: ReadonlyArray<readonly [string, string]> = [
  // arrays — bare, exported, and behind mutating type assertions
  ['bare array literal', 'const A = [1, 2, 3];'],
  ['exported array literal', 'export const A = [1, 2, 3];'],
  ['array via `as number[]`', 'const A = [1, 2, 3] as number[];'],
  ['array via `satisfies` (no as const)', 'const A = [1, 2, 3] satisfies readonly number[];'],
  ['array with ReadonlyArray<> annotation', 'const A: ReadonlyArray<number> = [1, 2, 3];'],
  ['array `as const as number[]`', 'const A = [1, 2, 3] as const as number[];'],
  ['array `as unknown as const`', 'const A = [1, 2, 3] as unknown as const;'],
  ['array `as number[] as const`', 'const A = [1, 2, 3] as number[] as const;'],
  ['array via `.map()` chain', 'const A = [1, 2].map((x) => x);'],
  ['array via `(… as const).slice()`', 'const A = ([1, 2] as const).slice();'],
  // collection constructors — bare, asserted, chained, non-null, qualified
  ['new Map()', 'const M = new Map();'],
  ['new Map() as ReadonlyMap', 'const M = new Map() as ReadonlyMap<number, number>;'],
  ['new Int32Array()', 'const B = new Int32Array(8);'],
  ['typed array via `.fill()` chain', 'const D = new Int32Array(8).fill(-1);'],
  ['Array() via `.fill()` chain', 'const A = new Array(3).fill(0);'],
  ['new Map().set() chain', 'const M = new Map().set(1, 2);'],
  ['collection via non-null assertion', 'const M = new Map()!;'],
  ['collection via non-null + method chain', 'const M = new Map()!.set(1, 2);'],
  ['global-qualified ctor `new globalThis.Array()`', 'const A = new globalThis.Array();'],
  ['global-qualified ctor `new self.Map()`', 'const M = new self.Map();'],
  // reassignable bindings
  ['let scalar', 'let X = 0;'],
  ['exported let', 'export let Y = 0;'],
  ['let bound to typed array', 'let B = new Int32Array(0);'],
  ['module-scope var scalar', 'var X = 0;'],
  ['module-scope var typed array', 'var B = new Int32Array(8);'],
  // namespace bodies are persistent scope, just like the module top level
  ['namespace-body collection', 'namespace N { const A = new Map(); }'],
  ['namespace-body exported array', 'namespace N { export const A = [1, 2]; }'],
  ['namespace-body let', 'namespace N { let X = 0; }'],
];

// MUST NOT be flagged (exemptions, non-persistent scopes, documented gaps).
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  // genuine immutable-array exemptions
  ['array `as const`', 'const A = [1, 2, 3] as const;'],
  ['exported array `as const`', 'export const A = [1, 2, 3] as const;'],
  ['array `as const satisfies T`', 'const A = [1, 2, 3] as const satisfies readonly number[];'],
  // non-collection / non-array values
  ['const scalar', 'const N = 5;'],
  ['new RegExp (not a collection)', "const R = new RegExp('x');"],
  ['new Error (not a collection)', "const E = new Error('x');"],
  ['identifier alias (documented gap)', 'const A = otherArray;'],
  ['conditional expression (documented gap)', 'const A = cond ? [1] : [2];'],
  ['Object.freeze([...]) is immutable', 'const A = Object.freeze([1, 2]);'],
  // documented shape gaps
  ['plain object (documented gap)', 'const O = { a: 1 };'],
  ['factory call (documented gap)', 'const X = makeBuffer();'],
  ['Array.from factory (documented gap)', 'const A = Array.from(xs);'],
  ['non-collection ctor `.exec()` chain', "const R = new RegExp('x').exec('y');"],
  // destructuring — RHS not retained as one binding (documented gap)
  ['array destructuring', 'const [a, b] = [1, 2];'],
  ['object destructuring', 'const { a } = { a: 1 };'],
  // ambient — no runtime state
  ['ambient declare const', 'declare const A: number[];'],
  // non-persistent scopes (block/loop/function execute once / per-call, not cross-tick)
  ['top-level bare block', '{ const A = [1, 2]; }'],
  ['top-level if block', 'if (cond) { const A = new Map(); }'],
  ['top-level for-of body', 'for (const x of xs) { const A: number[] = []; }'],
  ['function-local array', 'function f() { const t: number[] = []; return t; }'],
  ['function-local let', 'function f() { let t = 0; return t; }'],
  ['arrow-body collection', 'const f = () => { const m = new Map(); return m; };'],
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
