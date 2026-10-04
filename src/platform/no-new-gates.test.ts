// no-new-gates.test.ts — #408: no new simVersion gates before 1.0.
//
// DELETE THIS FILE AT 1.0, when gates come back (ARCHITECTURE.md Principle 7,
// "Re-enabling simVersion gates (post-1.0)", turn-on checklist item (c)).
//
// Pre-1.0 policy (AGENTS.md "simVersion and saves"): a sim behaviour change is not
// gated behind `simVersion`. It bumps LATEST_SIM_VERSION and sets
// MIN_ACCEPTED_SIM_VERSION to the same value. #408 reaped every old gate, and this
// guard keeps new ones out mechanically. It parses every non-test .ts file under
// src/, scripts/ and bench/ with the TypeScript compiler API (syntax only, no type
// checker) and fails on two kinds of reference.
//
//   1. 'registry name': a version-registry constant, `SIM_VERSION_V<n>` with or
//      without a `_<SUFFIX>` (the shape version-policy.test.ts enumerates). An
//      identifier counts, wherever it sits: an import, a use, a re-export,
//      `types.SIM_VERSION_V99_FOO`. So does a string literal that is exactly such a
//      name. Allowed only in three spots:
//        - src/sim/types.ts, in its top-level `const` declarations: the registry
//          entries and the LATEST line. A use inside a function there is a gate;
//        - src/platform/save.ts, in its import from '../sim/types.js' (not renamed);
//        - the MIN_ACCEPTED_SIM_VERSION declaration in save.ts, which a bump moves.
//   2. 'simVersion comparison': a relational comparison (<, <=, >, >=) where
//      either operand contains, anywhere inside it, a name that holds a
//      simVersion. That name is `simVersion` or a camelCase `…SimVersion`
//      (`validatedSimVersion`), as an identifier, a property (`world.simVersion`,
//      `w?.simVersion`) or a literal element key (`w['simVersion']`). So
//      `world.simVersion >= 72`, `(w.simVersion ?? 0) >= 72`,
//      `Number(w.simVersion) >= 72` and `w.simVersion! >= 72` all count. Allowed
//      only in the window check, snapshotWindowMessage in
//      src/platform/snapshot-window.ts. save.ts validateSimVersion compares a value
//      named `raw`, which does not match.
//
// A version bump touches only the registry and the MIN line, so it never trips this
// guard. Comments are not code (the AST skips them), and a template such as
// `SIM_VERSION_V${n}` is not a registry name. Only *.test.ts files are skipped:
// tests may pin and compare versions. Test helpers that are not *.test.ts (e.g.
// food-test-utils.ts) are scanned like any other file.
//
// Known limits (syntactic analysis cannot close them; review covers them):
//   - a version compared under another name (`const v = world.simVersion; v >= 72`);
//   - a `switch` on simVersion, or an equality test (`=== 72`);
//   - a version read only inside a nested function in the operand
//     (`(() => w.simVersion)() >= 72`);
//   - a registry name built at run time ('SIM_VERSION_V' + n).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // repo root (code/)
const SCAN_DIRS = ['src', 'scripts', 'bench'];

/** A version-registry constant's name: SIM_VERSION_V<n>, optionally _<SUFFIX>. */
const REGISTRY_NAME = /^SIM_VERSION_V\d+(?:_\w*)?$/;
/** A name that holds a simVersion: `simVersion`, or camelCase ending in `SimVersion`. */
const SIM_VERSION_NAME = /^(?:simVersion|[a-z][A-Za-z0-9]*SimVersion)$/;
const RELATIONAL: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

type Kind = 'registry name' | 'simVersion comparison';

/** The allowances, by name; the tightness test checks each one is still used. */
const ALLOW = {
  registry: 'src/sim/types.ts top-level const declarations (the registry)',
  minImport: "src/platform/save.ts import from '../sim/types.js'",
  minDecl: 'src/platform/save.ts MIN_ACCEPTED_SIM_VERSION declaration',
  windowCheck: 'src/platform/snapshot-window.ts snapshotWindowMessage',
} as const;
type Allowance = (typeof ALLOW)[keyof typeof ALLOW];

interface Ref {
  file: string;
  line: number;
  kind: Kind;
  text: string;
  allowedBy: Allowance | null;
}

/**
 * True when `e` contains, anywhere inside it, a name that holds a simVersion: an
 * identifier (a property name is one too) or a literal element key. Searching the
 * whole operand, not just its top, also catches a wrapped read such as
 * `(w.simVersion ?? 0)`, `Number(w.simVersion)` or `w.simVersion!`. The search does
 * not enter a nested function (a comparison inside one is visited on its own) or a
 * type (`(s as { simVersion?: unknown; tick: number }).tick > 3` reads no version).
 */
function mentionsSimVersion(e: ts.Node): boolean {
  if (ts.isIdentifier(e)) return SIM_VERSION_NAME.test(e.text);
  if (
    ts.isElementAccessExpression(e) &&
    (ts.isStringLiteral(e.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(e.argumentExpression)) &&
    SIM_VERSION_NAME.test(e.argumentExpression.text)
  ) {
    return true;
  }
  return (
    ts.forEachChild(e, (c) =>
      !ts.isFunctionLike(c) && !ts.isTypeNode(c) && mentionsSimVersion(c) ? true : undefined,
    ) === true
  );
}

/** True when `node` sits in a top-level `const`/`let` statement, outside any function. */
function inTopLevelDeclaration(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassLike(p)) return false;
    if (ts.isVariableStatement(p)) return ts.isSourceFile(p.parent);
  }
  return false;
}

/** The name of the innermost named function or method around `node`, or '<module>'. */
function enclosingFunctionName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name !== undefined) {
      return p.name.getText();
    }
    if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent)
    ) {
      return p.parent.name.getText();
    }
  }
  return '<module>';
}

function allowedBy(file: string, kind: Kind, node: ts.Node): Allowance | null {
  if (file === 'src/sim/types.ts') {
    return kind === 'registry name' && inTopLevelDeclaration(node) ? ALLOW.registry : null;
  }
  if (file === 'src/platform/save.ts' && kind === 'registry name') {
    // A renamed import (`SIM_VERSION_V99_FOO as G`) would let G be compared unseen.
    if (ts.isImportSpecifier(node.parent) && node.parent.propertyName !== undefined) return null;
    for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
      if (
        ts.isImportDeclaration(p) &&
        ts.isStringLiteral(p.moduleSpecifier) &&
        p.moduleSpecifier.text === '../sim/types.js'
      ) {
        return ALLOW.minImport;
      }
      if (
        ts.isVariableDeclaration(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'MIN_ACCEPTED_SIM_VERSION'
      ) {
        return ALLOW.minDecl;
      }
    }
    return null;
  }
  if (
    file === 'src/platform/snapshot-window.ts' &&
    kind === 'simVersion comparison' &&
    enclosingFunctionName(node) === 'snapshotWindowMessage'
  ) {
    return ALLOW.windowCheck;
  }
  return null;
}

/** Every registry-name reference and simVersion comparison in one file's source. */
function findGateRefs(file: string, source: string): Ref[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: Ref[] = [];
  const hit = (node: ts.Node, kind: Kind): void => {
    refs.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      text: node.getText(sf).split('\n')[0]!.slice(0, 100),
      allowedBy: allowedBy(file, kind, node),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && REGISTRY_NAME.test(node.text)) {
      hit(node, 'registry name');
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      REGISTRY_NAME.test(node.text)
    ) {
      hit(node, 'registry name');
    } else if (
      ts.isBinaryExpression(node) &&
      RELATIONAL.has(node.operatorToken.kind) &&
      (mentionsSimVersion(node.left) || mentionsSimVersion(node.right))
    ) {
      hit(node, 'simVersion comparison');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

let treeRefs: Ref[] | null = null;
/** Every reference in the scanned tree (parsed once, on first use). */
function scanTree(): Ref[] {
  if (treeRefs === null) {
    const files = SCAN_DIRS.flatMap((d) => listTsFiles(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(100); // the walk found the tree
    treeRefs = files.flatMap((f) =>
      findGateRefs(relative(ROOT, f).split('\\').join('/'), readFileSync(f, 'utf8')),
    );
  }
  return treeRefs;
}

const fmt = (r: Ref): string => `${r.file}:${r.line} ${r.kind}: ${r.text}`;

describe('#408 no new simVersion gates before 1.0 (delete at 1.0)', () => {
  it('no SIM_VERSION_V* reference or simVersion comparison outside the registry, the MIN line and the window check', () => {
    const violations = scanTree()
      .filter((r) => r.allowedBy === null)
      .map(fmt);
    expect(
      violations,
      'Pre-1.0 there are no simVersion gates (AGENTS.md "simVersion and saves"): bump ' +
        'LATEST_SIM_VERSION and set MIN_ACCEPTED_SIM_VERSION to the same value instead',
    ).toEqual([]);
  });

  it('every allowance is still needed (keeps the list tight)', () => {
    const used = new Set(scanTree().map((r) => r.allowedBy));
    for (const a of Object.values(ALLOW)) expect(used.has(a), a).toBe(true);
  });

  it('MIN_ACCEPTED_SIM_VERSION is declared from the registry (the MIN line the guard allows)', () => {
    const min = scanTree().filter((r) => r.allowedBy === ALLOW.minDecl);
    expect(min.map((r) => r.kind)).toEqual(['registry name']);
  });
});

describe('#408 no-new-gates detector (self-test)', () => {
  /** The unallowed references in a snippet, as `kind: text`. */
  const flagged = (file: string, source: string): string[] =>
    findGateRefs(file, source)
      .filter((r) => r.allowedBy === null)
      .map((r) => `${r.kind}: ${r.text}`);

  it('catches a gate on a registry constant: the import, the use and the comparison', () => {
    expect(
      flagged(
        'src/sim/foo.ts',
        "import { SIM_VERSION_V99_FOO } from './types.js';\n" +
          'export function f(world) { if (world.simVersion >= SIM_VERSION_V99_FOO) return 1; }',
      ),
    ).toEqual([
      'registry name: SIM_VERSION_V99_FOO',
      'simVersion comparison: world.simVersion >= SIM_VERSION_V99_FOO',
      'registry name: SIM_VERSION_V99_FOO',
    ]);
  });

  it('catches every spelling of a registry name', () => {
    const cases: readonly string[] = [
      "import { SIM_VERSION_V99_FOO as V } from '../sim/types.js';",
      "import * as t from '../sim/types.js'; const v = t.SIM_VERSION_V99_FOO;",
      "const v = Reflect.get(t, 'SIM_VERSION_V99_FOO');",
      'const v = t[`SIM_VERSION_V3`];',
      'export { SIM_VERSION_V99_FOO } from "../sim/types.js";',
      'const v = SIM_VERSION_V99_foo;', // any suffix, as version-policy.test.ts reads it
    ];
    for (const src of cases) {
      expect(flagged('src/render/foo.ts', src).length, src).toBeGreaterThan(0);
    }
  });

  it('catches a simVersion comparison spelled with a number, either side, any receiver', () => {
    const cases: readonly string[] = [
      'if (world.simVersion >= 72) f();',
      'if (72 <= world.simVersion) f();',
      'if (w?.simVersion < 72) f();',
      "if (w['simVersion'] > 3) f();",
      'if ((world.simVersion as number) >= 72) f();',
      'if (world.simVersion! >= 72) f();',
      'if ((world.simVersion ?? 0) >= 72) f();',
      'if (Number(world.simVersion) >= 72) f();',
      'if (+world.simVersion >= 72) f();',
      'if ((world.simVersion | 0) >= 72) f();',
      'function createScenario(seed, d, simVersion) { if (simVersion >= 72) g(); }',
      'if (validatedSimVersion < 60) f();',
    ];
    for (const src of cases) {
      expect(flagged('scripts/foo.ts', src), src).toEqual([
        expect.stringMatching(/^simVersion comparison: /),
      ]);
    }
  });

  it('ignores comments, templates, other names, assignments and equality', () => {
    const src =
      '// a gate on SIM_VERSION_V99_FOO would fail here\n' +
      '/* world.simVersion >= SIM_VERSION_V3 */\n' +
      'const p = `SIM_VERSION_V${n}[^0-9]`;\n' +
      "const q = 'LATEST_SIM_VERSION = (SIM_VERSION_V)?';\n" +
      'world.simVersion = LATEST_SIM_VERSION;\n' +
      'if (world.simVersion === LATEST_SIM_VERSION) f();\n' +
      'if (world.tick >= 72 && raw < MIN_ACCEPTED_SIM_VERSION) f();\n' +
      'const r = PIN_SIM_VERSION > 3;\n' +
      // A version read inside a nested function or named in a type is not the operand.
      'if (list.findIndex((t) => t.simVersion === v) >= 0) f();\n' +
      'if ((s as { simVersion?: unknown; tick: number }).tick > 3) f();';
    expect(flagged('src/sim/foo.ts', src)).toEqual([]);
  });

  it("allows types.ts's top-level declarations, and in save.ts only the types.js import and the MIN declaration", () => {
    const registry =
      'export const SIM_VERSION_V99_FOO = 72 as const;\n' +
      'export const LATEST_SIM_VERSION = SIM_VERSION_V99_FOO;\n';
    expect(flagged('src/sim/types.ts', registry)).toEqual([]);
    // types.ts holds real code (createWorldState, copyWorldState): a gate there is a gate.
    expect(
      flagged(
        'src/sim/types.ts',
        registry +
          'export function createWorldState(world) { if (world.simVersion >= SIM_VERSION_V99_FOO) f(); }\n' +
          'export const g = () => SIM_VERSION_V99_FOO;\n' +
          'if (world.simVersion >= 72) f();',
      ),
    ).toEqual([
      'simVersion comparison: world.simVersion >= SIM_VERSION_V99_FOO',
      'registry name: SIM_VERSION_V99_FOO',
      'registry name: SIM_VERSION_V99_FOO',
      'simVersion comparison: world.simVersion >= 72',
    ]);
    const save =
      "import { LATEST_SIM_VERSION, SIM_VERSION_V99_FOO } from '../sim/types.js';\n" +
      'export const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO;\n';
    expect(flagged('src/platform/save.ts', save)).toEqual([]);
    // A use anywhere else in save.ts is a gate, and so is an import from elsewhere.
    expect(
      flagged(
        'src/platform/save.ts',
        save + 'function v(s) { return s.simVersion >= SIM_VERSION_V99_FOO; }',
      ),
    ).toEqual([
      'simVersion comparison: s.simVersion >= SIM_VERSION_V99_FOO',
      'registry name: SIM_VERSION_V99_FOO',
    ]);
    expect(
      flagged('src/platform/save.ts', "import { SIM_VERSION_V99_FOO } from './other.js';"),
    ).toEqual(['registry name: SIM_VERSION_V99_FOO']);
    // A renamed import would hide the comparison behind a name the guard does not know.
    expect(
      flagged(
        'src/platform/save.ts',
        "import { SIM_VERSION_V99_FOO as G } from '../sim/types.js';\n" +
          'function v(x) { return x >= G; }',
      ),
    ).toEqual(['registry name: SIM_VERSION_V99_FOO']);
  });

  it('allows a simVersion comparison only in snapshot-window.ts snapshotWindowMessage', () => {
    const fn = (name: string): string =>
      `export function ${name}(simVersion, min) { if (simVersion < min) return 'old'; return null; }`;
    expect(flagged('src/platform/snapshot-window.ts', fn('snapshotWindowMessage'))).toEqual([]);
    expect(flagged('src/platform/snapshot-window.ts', fn('other'))).toEqual([
      'simVersion comparison: simVersion < min',
    ]);
    expect(flagged('src/platform/other.ts', fn('snapshotWindowMessage'))).toEqual([
      'simVersion comparison: simVersion < min',
    ]);
  });
});
