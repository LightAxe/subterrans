// code/eslint-rules/guard-scripts.test.ts
// Executable contract for the three architecture guard SCRIPTS (issue #241).
// check-sim-boundary.sh / check-asset-paths.sh / check-ant-cycles.mjs are the
// grep/parse backstops that only ever report "clean" — a regex regression would
// silently turn a red gate green with no visible symptom. This drives each guard
// against known-bad fixtures (must fail) and the real tree (must pass).
//
// All three scripts resolve their roots relative to CWD (they grep `src/render`,
// `src/`, or read `src/sim/ant`), so we invoke each with `cwd` set to a seeded
// tmp fixture for FAIL cases and to REPO_ROOT for the PASS case — NO script edits.
//
// Wired into Vitest via `eslint-rules/**/*.test.ts` in vitest.config.ts — same
// home as sim-module-state.test.ts, keeping tooling tests out of src/.
//
// NOTE: check-sim-boundary.sh guards render/input/platform *mutation* shapes plus
// the #211 disable hygiene in src/sim — NOT sim imports (those are eslint's
// no-restricted-imports). The fixtures below target what it actually checks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)); // eslint-rules/ -> repo root
const script = (p: string) => join(REPO_ROOT, 'scripts', p);

/** Run a guard; return its exit code (0 = clean/pass, non-zero = violation found). */
function exitCode(cmd: string, args: string[], cwd: string): number {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

let fx: string;
beforeEach(() => {
  fx = mkdtempSync(join(tmpdir(), 'guard-fixture-'));
  for (const d of ['src/render', 'src/input', 'src/platform', 'src/sim', 'src/sim/ant']) {
    mkdirSync(join(fx, d), { recursive: true });
  }
});
afterEach(() => rmSync(fx, { recursive: true, force: true }));

const write = (rel: string, body: string) => writeFileSync(join(fx, rel), body);

describe('check-sim-boundary.sh (#241 contract)', () => {
  it('passes on the real tree', () => {
    expect(exitCode('bash', [script('check-sim-boundary.sh')], REPO_ROOT)).toBe(0);
  });

  it('fails on a nested WorldState mutation from a non-sim layer', () => {
    // FNDN-07: nested write the eslint tripwire misses; the ERE `…=[^=>]` matches `= 0`.
    write('src/render/bad.ts', 'export function f(world: any) {\n  world.tick = 0;\n}\n');
    expect(exitCode('bash', [script('check-sim-boundary.sh')], fx)).not.toBe(0);
  });

  it('fails on a reason-less sim-module-state disable (#211 hygiene)', () => {
    write(
      'src/sim/bad.ts',
      '// eslint-disable-next-line subterrans/sim-module-state\nexport const cache = new Map();\n',
    );
    expect(exitCode('bash', [script('check-sim-boundary.sh')], fx)).not.toBe(0);
  });

  it('passes a disable that carries a sim-scratch reason', () => {
    write(
      'src/sim/ok.ts',
      '// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch: reset per tick\nexport const scratch = new Map();\n',
    );
    // no mutation, no bare disable -> all four stages clean
    expect(exitCode('bash', [script('check-sim-boundary.sh')], fx)).toBe(0);
  });
});

describe('check-asset-paths.sh (#241 contract)', () => {
  it('passes on the real tree', () => {
    expect(exitCode('bash', [script('check-asset-paths.sh')], REPO_ROOT)).toBe(0);
  });

  it('fails on a root-absolute asset path literal', () => {
    write('src/foo.ts', "export const u = '/assets/foo.svg';\n");
    expect(exitCode('bash', [script('check-asset-paths.sh')], fx)).not.toBe(0);
  });

  it('passes a BASE_URL-prefixed asset path', () => {
    write('src/foo.ts', 'export const u = `${import.meta.env.BASE_URL}assets/foo.svg`;\n');
    expect(exitCode('bash', [script('check-asset-paths.sh')], fx)).toBe(0);
  });
});

describe('check-ant-cycles.mjs (#241 contract)', () => {
  const node = process.execPath;

  it('passes on the real ant/ tree', () => {
    expect(exitCode(node, [script('check-ant-cycles.mjs')], REPO_ROOT)).toBe(0);
  });

  it('fails on an import cycle among ant sub-modules', () => {
    write('src/sim/ant/a.ts', "import './b.js';\nexport const a = 1;\n");
    write('src/sim/ant/b.ts', "import './a.js';\nexport const b = 1;\n");
    expect(exitCode(node, [script('check-ant-cycles.mjs')], fx)).not.toBe(0);
  });

  it('fails when a sub-module imports the barrel', () => {
    write('src/sim/ant/ant-system.ts', 'export const b = 1;\n');
    write('src/sim/ant/leaf.ts', "import './ant-system.js';\nexport const l = 1;\n");
    expect(exitCode(node, [script('check-ant-cycles.mjs')], fx)).not.toBe(0);
  });
});
