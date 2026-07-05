// code/eslint-rules/sim-dynamic-import.test.ts
// Executable contract for the #241 dynamic-import ban in eslint.config.ts.
// no-restricted-imports only sees STATIC import declarations, so a sim file could
// `await import('../platform/save.js')` (or Phaser) and lint clean. The config now
// bans ImportExpression in src/sim/** while a LAST override re-applies only the
// float/division selectors to src/sim test files (they legitimately await import()).
//
// Loads the REAL config and drives Linter#verify by filename (flat `files` matching
// honors the passed filename), so a regression in the selector wiring fails here.
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import config from '../eslint.config.ts';

const linter = new Linter({ configType: 'flat' });

/** Count no-restricted-syntax violations for `code` linted AS `filename`. */
function nrs(code: string, filename: string): number {
  return linter
    .verify(code, config as never, { filename })
    .filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

const DYN = 'export async function f() {\n  await import("../platform/save.js");\n}\n';

describe('#241 dynamic-import ban wiring', () => {
  it('flags dynamic import() in a sim source file', () => {
    expect(nrs(DYN, 'src/sim/foo.ts')).toBeGreaterThan(0);
  });

  it('allows a static import in a sim source file', () => {
    expect(nrs('import { x } from "./y.js";\nexport const z = x;\n', 'src/sim/foo.ts')).toBe(0);
  });

  it('exempts sim test files from the dynamic-import ban', () => {
    expect(nrs(DYN, 'src/sim/foo.test.ts')).toBe(0);
  });

  it('STILL flags a float literal in a sim test file (override re-applied float/division)', () => {
    // Proves the test-file override did not silently drop the FNDN-02 bans.
    expect(nrs('export const x = 1.5;\n', 'src/sim/foo.test.ts')).toBeGreaterThan(0);
  });

  it('does NOT flag a type-position import (TSImportType ≠ ImportExpression)', () => {
    const code = 'export function f(a: import("./y.js").T): void {\n  void a;\n}\n';
    expect(nrs(code, 'src/sim/foo.ts')).toBe(0);
  });
});
