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
// checker) and fails on three kinds of reference.
//
//   1. 'registry name': a version-registry constant, `SIM_VERSION_V<n>` with or
//      without a `_<SUFFIX>` (the shape version-policy.test.ts enumerates). An
//      identifier counts, wherever it sits: an import, a use, a re-export,
//      `types.SIM_VERSION_V99_FOO`. So does a string literal that is exactly such a
//      name. Allowed only in four exact spots, each in a top-level `const`:
//        - src/sim/types.ts, a registry entry's own declared name
//          (`export const SIM_VERSION_V72_FOO = 72 as const`);
//        - src/sim/types.ts, the LATEST line's whole right-hand side
//          (`export const LATEST_SIM_VERSION = SIM_VERSION_V72_FOO`);
//        - src/platform/save.ts, the MIN line's whole right-hand side
//          (`export const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V72_FOO`);
//        - src/platform/save.ts, its import from '../sim/types.js' (not renamed).
//      Anywhere else it is a gate: inside a function, deeper in an initializer
//      (`export const USE_FOO = LATEST_SIM_VERSION >= SIM_VERSION_V73_FOO`), in
//      another top-level const (`const FOO_SINCE = SIM_VERSION_V73_FOO`), a type
//      or an export list.
//   2. 'simVersion comparison': a relational comparison (<, <=, >, >=) where
//      either operand contains, anywhere inside it, a name that holds a
//      simVersion. That name is `simVersion` or a camelCase `…SimVersion`
//      (`validatedSimVersion`), or a SCREAMING_CASE constant with a `SIM_VERSION`
//      segment (LATEST_SIM_VERSION, MIN_ACCEPTED_SIM_VERSION, any registry name,
//      PIN_SIM_VERSION), as an identifier, a property (`world.simVersion`,
//      `w?.simVersion`, `t.LATEST_SIM_VERSION`) or a literal element key
//      (`w['simVersion']`), private ones (`this.#simVersion`) included. So
//      `world.simVersion >= 72`, `(w.simVersion ?? 0) >= 72`,
//      `Number(w.simVersion) >= 72`, `w.simVersion! >= 72` and the build-wide flag
//      `LATEST_SIM_VERSION >= 73` all count. Allowed only in the two window checks:
//        - snapshotWindowMessage in src/platform/snapshot-window.ts;
//        - validateSimVersion in src/platform/save.ts (`raw > LATEST_SIM_VERSION`,
//          `raw < MIN_ACCEPTED_SIM_VERSION`).
//   3. 'version rename': an import, export or destructuring that renames such a
//      name (`import { LATEST_SIM_VERSION as L }`, `export { LATEST_SIM_VERSION as
//      CURRENT }`, `const { simVersion: v } = world`), which would hide every later
//      comparison from rule 2. Never allowed. (A renamed registry name is already
//      a 'registry name' reference, so it is not reported twice.)
//
// A version bump touches only the registry and the MIN line, so it never trips this
// guard. Comments are not code (the AST skips them), and a template such as
// `SIM_VERSION_V${n}` is not a registry name. Only *.test.ts files are skipped:
// tests may pin and compare versions. Test helpers that are not *.test.ts (e.g.
// food-test-utils.ts) are scanned like any other file.
//
// Known limits (syntactic analysis cannot close them; review covers them):
//   - a version copied to another name and compared under it
//     (`const v = world.simVersion; v >= 72`, `const l = LATEST_SIM_VERSION`);
//   - a test that is not a relational comparison: a `switch` on simVersion, an
//     equality test (`=== 72`), a lookup (`[72, 73].includes(v)`, `table[v]`), or
//     truthiness of arithmetic (`if (w.simVersion - 72)`);
//   - a version read only inside a nested function in the operand
//     (`(() => w.simVersion)() >= 72`);
//   - a name built at run time ('SIM_VERSION_V' + n, w['sim' + 'Version']).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // repo root (code/)
const SCAN_DIRS = ['src', 'scripts', 'bench'];

/** A version-registry constant's name: SIM_VERSION_V<n>, optionally _<SUFFIX>. */
const REGISTRY_NAME = /^SIM_VERSION_V\d+(?:_\w*)?$/;
/**
 * A name that holds a simVersion: `simVersion`, camelCase ending in `SimVersion`, or
 * a SCREAMING_CASE constant with a `SIM_VERSION` segment (LATEST_SIM_VERSION,
 * MIN_ACCEPTED_SIM_VERSION, SIM_VERSION_V72_FOO).
 */
const SIM_VERSION_NAME =
  /^(?:simVersion|[a-z][A-Za-z0-9]*SimVersion|(?:[A-Z0-9]+_)*SIM_VERSION(?:_\w*)?)$/;
const RELATIONAL: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

type Kind = 'registry name' | 'simVersion comparison' | 'version rename';

/** The allowances, by name; the tightness test checks each one is still used. */
const ALLOW = {
  registry: "src/sim/types.ts registry entries' names and the LATEST line",
  minImport: "src/platform/save.ts import from '../sim/types.js'",
  minDecl: 'src/platform/save.ts MIN_ACCEPTED_SIM_VERSION line',
  windowCheck: 'src/platform/snapshot-window.ts snapshotWindowMessage',
  loadCheck: 'src/platform/save.ts validateSimVersion',
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
  if (ts.isPrivateIdentifier(e)) return SIM_VERSION_NAME.test(e.text.slice(1)); // #simVersion
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

/**
 * True when `node` renames a name that holds a simVersion: an import or export
 * specifier (`LATEST_SIM_VERSION as L`) or a destructuring element
 * (`{ simVersion: v }`). A registry name is left to rule 1, which flags it wherever
 * it sits.
 */
function renamesVersionName(node: ts.Node): boolean {
  if (!ts.isImportSpecifier(node) && !ts.isExportSpecifier(node) && !ts.isBindingElement(node)) {
    return false;
  }
  const from = node.propertyName;
  if (
    from === undefined ||
    !(ts.isIdentifier(from) || ts.isStringLiteral(from) || ts.isNoSubstitutionTemplateLiteral(from))
  ) {
    return false;
  }
  return SIM_VERSION_NAME.test(from.text) && !REGISTRY_NAME.test(from.text);
}

/**
 * Where `node` sits in a top-level `const` declaration: as its declared name, or as
 * its whole initializer (`const <name> = <node>;`), with the declared name. Null
 * anywhere else: deeper inside an initializer, in a function, a `let`, a
 * destructuring pattern, a type or an export list.
 */
function topLevelConstSlot(node: ts.Node): { slot: 'name' | 'initializer'; name: string } | null {
  const decl = node.parent;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
  const list = decl.parent;
  if (
    !ts.isVariableDeclarationList(list) ||
    (list.flags & ts.NodeFlags.BlockScoped) !== Number(ts.NodeFlags.Const) ||
    !ts.isVariableStatement(list.parent) ||
    !ts.isSourceFile(list.parent.parent)
  ) {
    return null;
  }
  if (decl.name === node) return { slot: 'name', name: decl.name.text };
  if (decl.initializer === node && ts.isIdentifier(node)) {
    return { slot: 'initializer', name: decl.name.text };
  }
  return null;
}

/** True when `node` is the whole right-hand side of the top-level `const <name> = …`. */
const isWholeInitializerOf = (node: ts.Node, name: string): boolean => {
  const at = topLevelConstSlot(node);
  return at !== null && at.slot === 'initializer' && at.name === name;
};

/**
 * The name of the top-level function declaration that holds `node`, or '<module>'.
 * Top level only: a nested function or a method that merely shares a window check's
 * name is not that check.
 */
function topLevelFunctionName(node: ts.Node): string {
  let stmt: ts.Node = node;
  while (stmt.parent !== undefined && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
  return ts.isFunctionDeclaration(stmt) && stmt.name !== undefined ? stmt.name.text : '<module>';
}

function allowedBy(file: string, kind: Kind, node: ts.Node): Allowance | null {
  if (kind === 'version rename') return null;
  if (file === 'src/sim/types.ts') {
    // Only a registry entry's own name and the LATEST line's right-hand side. Any
    // other spot, a top-level const included (`USE_FOO = LATEST >= SIM_VERSION_V73`),
    // could hold a flag that code branches on.
    if (kind !== 'registry name') return null;
    return topLevelConstSlot(node)?.slot === 'name' ||
      isWholeInitializerOf(node, 'LATEST_SIM_VERSION')
      ? ALLOW.registry
      : null;
  }
  if (file === 'src/platform/save.ts') {
    if (kind === 'simVersion comparison') {
      return topLevelFunctionName(node) === 'validateSimVersion' ? ALLOW.loadCheck : null;
    }
    // A named import, not renamed: `SIM_VERSION_V99_FOO as G` would let G be
    // compared unseen.
    const spec = node.parent;
    if (ts.isImportSpecifier(spec) && spec.propertyName === undefined) {
      const from = spec.parent.parent.parent.moduleSpecifier;
      return ts.isStringLiteral(from) && from.text === '../sim/types.js' ? ALLOW.minImport : null;
    }
    return isWholeInitializerOf(node, 'MIN_ACCEPTED_SIM_VERSION') ? ALLOW.minDecl : null;
  }
  if (
    file === 'src/platform/snapshot-window.ts' &&
    kind === 'simVersion comparison' &&
    topLevelFunctionName(node) === 'snapshotWindowMessage'
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
    } else if (renamesVersionName(node)) {
      hit(node, 'version rename');
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
  it('no SIM_VERSION_V* reference, simVersion comparison or version rename outside the registry, the MIN line and the window checks', () => {
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
      'class C { #simVersion = 0; f() { if (this.#simVersion >= 72) g(); } }',
    ];
    for (const src of cases) {
      expect(flagged('scripts/foo.ts', src), src).toEqual([
        expect.stringMatching(/^simVersion comparison: /),
      ]);
    }
  });

  it('catches a comparison against LATEST, MIN or any SIM_VERSION constant: a build-wide flag', () => {
    const cases: readonly string[] = [
      'if (LATEST_SIM_VERSION >= 73) f();',
      'export const USE_FOO = 73 <= LATEST_SIM_VERSION;',
      'if (raw < MIN_ACCEPTED_SIM_VERSION) f();',
      'if (t.LATEST_SIM_VERSION > 72) f();',
      "if (t['MIN_ACCEPTED_SIM_VERSION'] > 72) f();",
      'if ((LATEST_SIM_VERSION as number) >= 73) f();',
      'const r = PIN_SIM_VERSION > 3;',
      'if (LEGACY_SIM_VERSION < x) f();',
    ];
    for (const src of cases) {
      expect(flagged('src/sim/foo.ts', src), src).toEqual([
        expect.stringMatching(/^simVersion comparison: /),
      ]);
    }
  });

  it('catches a rename of a version name, which would hide every later comparison', () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        "import { LATEST_SIM_VERSION as L } from './types.js'; if (L >= 73) f();",
        'LATEST_SIM_VERSION as L',
      ],
      [
        "export { LATEST_SIM_VERSION as CURRENT } from './types.js';",
        'LATEST_SIM_VERSION as CURRENT',
      ],
      ['const { LATEST_SIM_VERSION: l } = t; if (l >= 73) f();', 'LATEST_SIM_VERSION: l'],
      ['const { simVersion: v } = world; if (v >= 72) f();', 'simVersion: v'],
      ["const { 'simVersion': v } = world;", "'simVersion': v"],
      ['function g({ simVersion: v }) { return v >= 72; }', 'simVersion: v'],
    ];
    for (const [src, renamed] of cases) {
      expect(flagged('src/sim/foo.ts', src), src).toEqual([`version rename: ${renamed}`]);
    }
    // Not a rename: a plain import or destructuring keeps the name rule 2 knows.
    expect(
      flagged(
        'src/sim/foo.ts',
        "import { LATEST_SIM_VERSION } from './types.js'; const { simVersion } = world;",
      ),
    ).toEqual([]);
    // In save.ts a renamed import is never allowed either; a renamed registry name
    // is reported once, as a registry name.
    expect(
      flagged('src/platform/save.ts', "import { LATEST_SIM_VERSION as L } from '../sim/types.js';"),
    ).toEqual(['version rename: LATEST_SIM_VERSION as L']);
  });

  it('ignores comments, templates, other names, assignments and equality', () => {
    const src =
      '// a gate on SIM_VERSION_V99_FOO would fail here\n' +
      '/* world.simVersion >= SIM_VERSION_V3 */\n' +
      'const p = `SIM_VERSION_V${n}[^0-9]`;\n' +
      "const q = 'LATEST_SIM_VERSION = (SIM_VERSION_V)?';\n" +
      'world.simVersion = LATEST_SIM_VERSION;\n' +
      'if (world.simVersion === LATEST_SIM_VERSION) f();\n' +
      'if (world.tick >= 72 && raw < limit) f();\n' +
      'const r = SAVE_FORMAT_VERSION > 3 && MAX_SIM_VERSIONS > 3;\n' +
      // A version read inside a nested function or named in a type is not the operand.
      'if (list.findIndex((t) => t.simVersion === v) >= 0) f();\n' +
      'if ((s as { simVersion?: unknown; tick: number }).tick > 3) f();';
    expect(flagged('src/sim/foo.ts', src)).toEqual([]);
  });

  it('allows in types.ts only the registry entries and the LATEST line, and in save.ts only the types.js import and the MIN line', () => {
    const registry =
      'export const LEGACY_SIM_VERSION = 2 as const;\n' +
      'export const SIM_VERSION_V3 = 3 as const;\n' +
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
    // The MIN line is allowed only as written: top level, the entry as the whole value.
    for (const src of [
      'export const MIN_ACCEPTED_SIM_VERSION = USE ? SIM_VERSION_V99_FOO : 1;',
      'function f() { const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO; }',
      'export let MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO;',
      'export const FOO_SINCE = SIM_VERSION_V99_FOO;',
    ]) {
      expect(flagged('src/platform/save.ts', src), src).toEqual([
        'registry name: SIM_VERSION_V99_FOO',
      ]);
    }
  });

  it('catches a version flag or alias in any other types.ts top-level const (Codex on #422)', () => {
    const registry =
      'export const SIM_VERSION_V73_FOO = 73 as const;\n' +
      'export const LATEST_SIM_VERSION = SIM_VERSION_V73_FOO;\n';
    // A top-level flag that code could then branch on (`if (USE_FOO)`).
    expect(
      flagged(
        'src/sim/types.ts',
        registry + 'export const USE_FOO = LATEST_SIM_VERSION >= SIM_VERSION_V73_FOO;',
      ),
    ).toEqual([
      'simVersion comparison: LATEST_SIM_VERSION >= SIM_VERSION_V73_FOO',
      'registry name: SIM_VERSION_V73_FOO',
    ]);
    // The same in other non-registry top-level consts, and the spots around the
    // allowed ones: a `let`, a LATEST line that is more than the bare entry, an
    // entry whose value is a flag, a re-export, a type.
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ['export const FOO_SINCE = SIM_VERSION_V73_FOO;', ['registry name: SIM_VERSION_V73_FOO']],
      ['const FLAGS = { foo: SIM_VERSION_V73_FOO };', ['registry name: SIM_VERSION_V73_FOO']],
      [
        'export const USE_BAR = 73 <= LATEST_SIM_VERSION;',
        ['simVersion comparison: 73 <= LATEST_SIM_VERSION'],
      ],
      [
        'export const A = 1, USE_BAZ = SIM_VERSION_V73_FOO > 72;',
        ['simVersion comparison: SIM_VERSION_V73_FOO > 72', 'registry name: SIM_VERSION_V73_FOO'],
      ],
      [
        'export const USE_QUX = LATEST_SIM_VERSION === SIM_VERSION_V73_FOO;',
        ['registry name: SIM_VERSION_V73_FOO'],
      ],
      ['export let SIM_VERSION_V74_BAR = 74;', ['registry name: SIM_VERSION_V74_BAR']],
      [
        'export const LATEST_SIM_VERSION = USE ? SIM_VERSION_V73_FOO : 72;',
        ['registry name: SIM_VERSION_V73_FOO'],
      ],
      [
        'export const SIM_VERSION_V74_BAR = LATEST_SIM_VERSION >= 73 ? 74 : 73;',
        ['simVersion comparison: LATEST_SIM_VERSION >= 73'],
      ],
      ['export { SIM_VERSION_V73_FOO as FOO };', ['registry name: SIM_VERSION_V73_FOO']],
      ['export type Foo = typeof SIM_VERSION_V73_FOO;', ['registry name: SIM_VERSION_V73_FOO']],
    ];
    for (const [src, want] of cases) expect(flagged('src/sim/types.ts', src), src).toEqual(want);
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
    // Only the top-level function: a nested function or a method of that name is not it.
    for (const src of [
      'function outer() { function snapshotWindowMessage(simVersion, min) { return simVersion < min; } }',
      'class C { snapshotWindowMessage(simVersion, min) { return simVersion < min; } }',
      'const snapshotWindowMessage = (simVersion, min) => simVersion < min;',
    ]) {
      expect(flagged('src/platform/snapshot-window.ts', src), src).toEqual([
        'simVersion comparison: simVersion < min',
      ]);
    }
  });

  it('allows a comparison against LATEST or MIN only in save.ts validateSimVersion', () => {
    const fn = (name: string): string =>
      `function ${name}(raw) {\n` +
      '  if (raw > LATEST_SIM_VERSION) throw new FutureSimVersionError(raw, LATEST_SIM_VERSION);\n' +
      '  if (raw < MIN_ACCEPTED_SIM_VERSION) throw new OldSimVersionError(raw);\n' +
      '  return raw;\n' +
      '}';
    const both = [
      'simVersion comparison: raw > LATEST_SIM_VERSION',
      'simVersion comparison: raw < MIN_ACCEPTED_SIM_VERSION',
    ];
    expect(flagged('src/platform/save.ts', fn('validateSimVersion'))).toEqual([]);
    expect(flagged('src/platform/save.ts', fn('other'))).toEqual(both);
    expect(flagged('src/platform/other.ts', fn('validateSimVersion'))).toEqual(both);
    expect(
      flagged('src/platform/save.ts', `export function load(raw) { ${fn('validateSimVersion')} }`),
    ).toEqual(both);
  });
});
