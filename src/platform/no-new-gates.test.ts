// no-new-gates.test.ts — #408: no new simVersion gates before 1.0.
//
// DELETE THIS FILE AT 1.0, when gates come back (ARCHITECTURE.md Principle 7,
// "Re-enabling simVersion gates (post-1.0)", turn-on checklist item (c)).
//
// Pre-1.0 policy (AGENTS.md "simVersion and saves"): a sim behaviour change is not
// gated behind `simVersion`. It bumps LATEST_SIM_VERSION and sets
// MIN_ACCEPTED_SIM_VERSION to the same value. #408 reaped every old gate, and this
// guard keeps new ones out mechanically. It parses every non-test TypeScript or
// JavaScript source (.ts .mts .cts .tsx .js .mjs .cjs .jsx) under src/, scripts/ and
// bench/, and those at the repo root (the build configs: vite.config.ts,
// vite.lib.config.ts, vitest.config.ts and the rest, not recursively), with the
// TypeScript compiler API (syntax only, no type checker), and fails on three kinds of
// reference. A build config counts because a Vite `define` can turn a version test
// into a shipped flag. Shell scripts and data files are not scanned: the sim runs and
// is built only in TS/JS, so only TS/JS can gate its behaviour on a version. The root
// HTML pages (index.html, whose inline module script Vite bundles) must not name a
// version at all.
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
//        - src/platform/save.ts, its import from '../sim/types.js' of exactly the
//          entry the MIN line names (not renamed).
//      Anywhere else it is a gate: inside a function, deeper in an initializer
//      (`export const USE_FOO = LATEST_SIM_VERSION >= SIM_VERSION_V73_FOO`), in
//      another top-level const (`const FOO_SINCE = SIM_VERSION_V73_FOO`), a type
//      or an export list.
//   2. 'simVersion comparison': a relational comparison (<, <=, >, >=) where
//      either operand contains, anywhere inside it, a name that holds a
//      simVersion. That name is `simVersion` or a camelCase `…SimVersion`
//      (`validatedSimVersion`), or a SCREAMING_CASE constant with a `SIM_VERSION`
//      segment (LATEST_SIM_VERSION, MIN_ACCEPTED_SIM_VERSION, any registry name,
//      PIN_SIM_VERSION), leading underscores allowed (`this._simVersion`, a Vite
//      `define` such as `__SIM_VERSION__`). It counts as an identifier, a property
//      (`world.simVersion`, `w?.simVersion`, `t.LATEST_SIM_VERSION`) or a literal
//      element key (`w['simVersion']`), private ones (`this.#simVersion`) included. So
//      `world.simVersion >= 72`, `(w.simVersion ?? 0) >= 72`,
//      `Number(w.simVersion) >= 72`, `w.simVersion! >= 72` and the build-wide flag
//      `LATEST_SIM_VERSION >= 73` all count. Allowed only as the two window checks'
//      own bound comparisons (WINDOW_COMPARISONS):
//        - snapshotWindowMessage in src/platform/snapshot-window.ts
//          (`simVersion < min`, `simVersion > latest`);
//        - validateSimVersion in src/platform/save.ts (`raw > LATEST_SIM_VERSION`,
//          `raw < MIN_ACCEPTED_SIM_VERSION`).
//      Each must be spelled exactly so. Only whitespace is normalized: a comment
//      inside it, parentheses or missing spaces make it a mismatch, which is flagged
//      (fails safe). It must also sit in the function's own body, not in a function
//      or class nested in it, and each operand must be bound exactly once: the
//      function's own plain parameter (no default, not rest or destructured), or
//      the real constant (save.ts's unrenamed LATEST_SIM_VERSION import from
//      '../sim/types.js', its MIN line), with no other binding of or assignment to
//      that name (in the function for a parameter, in the file for a constant). So
//      a local `const LATEST_SIM_VERSION = 72`, an assignment `min = 73` or a
//      default `min = 73` turns a window comparison into a gate, and is flagged.
//      Any other comparison inside those functions is a gate like anywhere else.
//   3. 'version rename': an import, export or destructuring that renames such a
//      name (`import { LATEST_SIM_VERSION as L }`, `export { LATEST_SIM_VERSION as
//      CURRENT }`, `export default LATEST_SIM_VERSION`, `const { simVersion: v } =
//      world`), which would hide every later comparison from rule 2. Never allowed.
//      (A renamed registry name is already a 'registry name' reference, so it is
//      not reported twice.)
//
// A version bump touches only the registry and the MIN line, so it never trips this
// guard. Comments are not code (the AST skips them), and a template such as
// `SIM_VERSION_V${n}` is not a registry name. Only test files (*.test.<ext>) and
// declaration files are skipped: tests may pin and compare versions. Test helpers
// that are not *.test.<ext> (e.g. food-test-utils.ts) are scanned like any other
// file.
//
// Known limits (syntactic analysis cannot close them; review covers them):
//   - a version copied to another name and compared under it
//     (`const v = world.simVersion; v >= 72`, `const l = LATEST_SIM_VERSION`),
//     a dynamic import read into a name included
//     (`const v = (await import('./types.js')).LATEST_SIM_VERSION`; read inline,
//     `(await import('./types.js')).LATEST_SIM_VERSION >= 73` is caught);
//   - a version passed as an argument and compared under the parameter's name
//     (`isAtLeast(w.simVersion, 72)`), a window check included: calling one with a
//     constant bound and branching on the result
//     (`snapshotWindowMessage(w.simVersion, 73, 999) !== null`);
//   - an alias made other than by an ES import, export or destructuring: an
//     object-literal property (`{ L: LATEST_SIM_VERSION }`), a class field or getter,
//     a default parameter (`(v = w.simVersion) => v >= 72`), an array destructure
//     (`const [v] = [w.simVersion]`), a CommonJS export
//     (`module.exports = LATEST_SIM_VERSION`), or a field derived from the version and
//     written into the world or save (`world.rulesEpoch = world.simVersion`);
//   - a test that is not a relational comparison: a `switch` on simVersion, an
//     equality test (`=== 72`), a lookup or membership test
//     (`[72, 73].includes(v)`, `table[v]`, `w.simVersion in TABLE`), a library call
//     (`Math.max(w.simVersion, 72) === w.simVersion`), bitwise arithmetic
//     (`w.simVersion >> 7`), or truthiness of arithmetic (`if (w.simVersion - 72)`);
//   - a version read only inside a nested function in the operand
//     (`(() => w.simVersion)() >= 72`);
//   - what a window check does with its own bound comparison: that it rejects
//     (throws, or returns the message) is pinned by save.test.ts at MIN - 1 and
//     LATEST + 1 and by snapshot-window.test.ts, not here;
//   - a name built at run time ('SIM_VERSION_V' + n, w['sim' + 'Version']), or code
//     run by `eval` (`eval('min = 73')` in a window check).

import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // repo root (code/)
/** Scanned recursively. The repo root's own files (the build configs) are scanned too, not recursively. */
const SCAN_DIRS = ['src', 'scripts', 'bench'];

/** A version-registry constant's name: SIM_VERSION_V<n>, optionally _<SUFFIX>. */
const REGISTRY_NAME = /^SIM_VERSION_V\d+(?:_\w*)?$/;
/**
 * A name that holds a simVersion: `simVersion`, camelCase ending in `SimVersion`, or
 * a SCREAMING_CASE constant with a `SIM_VERSION` segment (LATEST_SIM_VERSION,
 * MIN_ACCEPTED_SIM_VERSION, SIM_VERSION_V72_FOO), after any leading underscores
 * (`_simVersion`, a Vite `define` such as `__SIM_VERSION__`).
 */
const SIM_VERSION_NAME =
  /^_*(?:simVersion|[a-z][A-Za-z0-9]*SimVersion|(?:[A-Z0-9]+_)*SIM_VERSION(?:_\w*)?)$/;
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
  minImport: "src/platform/save.ts import of the MIN line's entry from '../sim/types.js'",
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
 * specifier (`LATEST_SIM_VERSION as L`), a destructuring element
 * (`{ simVersion: v }`), or a default export of one (`export default
 * LATEST_SIM_VERSION`, `export = t.LATEST_SIM_VERSION`), which an importer may call
 * anything (`import L from './ver.js'`). A registry name is left to rule 1, which
 * flags it wherever it sits.
 */
function renamesVersionName(node: ts.Node): boolean {
  if (ts.isExportAssignment(node)) {
    let e = node.expression;
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
    }
    const name = ts.isIdentifier(e)
      ? e.text
      : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)
        ? e.name.text
        : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)
          ? e.argumentExpression.text
          : '';
    return SIM_VERSION_NAME.test(name) && !REGISTRY_NAME.test(name);
  }
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
 * The top-level function declaration that holds `node`, if any. Top level only: a
 * nested function or a method that merely shares a window check's name is not that
 * check.
 */
function topLevelFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let stmt: ts.Node = node;
  while (stmt.parent !== undefined && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
  return ts.isFunctionDeclaration(stmt) ? stmt : undefined;
}

/**
 * save.ts's MIN line, the top-level `const MIN_ACCEPTED_SIM_VERSION = <entry>`: its
 * declared name and the registry entry it names. Undefined when there is no such line
 * (its import is then allowed for nothing).
 */
function minLine(sf: ts.SourceFile): { name: ts.Identifier; entry: string } | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(d.name) &&
        d.name.text === 'MIN_ACCEPTED_SIM_VERSION' &&
        d.initializer !== undefined &&
        ts.isIdentifier(d.initializer) &&
        isWholeInitializerOf(d.initializer, 'MIN_ACCEPTED_SIM_VERSION')
      ) {
        return { name: d.name, entry: d.initializer.text };
      }
    }
  }
  return undefined;
}

/**
 * save.ts's own name for LATEST_SIM_VERSION: a value import (not `import type`) from
 * '../sim/types.js', not renamed. Undefined when there is none.
 */
function latestImport(sf: ts.SourceFile): ts.Identifier | undefined {
  for (const stmt of sf.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !ts.isStringLiteral(stmt.moduleSpecifier) ||
      stmt.moduleSpecifier.text !== '../sim/types.js'
    ) {
      continue;
    }
    const clause = stmt.importClause;
    if (
      clause === undefined ||
      clause.phaseModifier !== undefined ||
      clause.namedBindings === undefined ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      continue;
    }
    for (const spec of clause.namedBindings.elements) {
      if (!spec.isTypeOnly && spec.propertyName === undefined) {
        if (spec.name.text === 'LATEST_SIM_VERSION') return spec.name;
      }
    }
  }
  return undefined;
}

/**
 * The only simVersion comparisons allowed, each inside its named top-level function
 * and spelled exactly so. Only whitespace is normalized: a comment inside the
 * expression, parentheses or missing spaces make it a mismatch, which is flagged
 * (fails safe). Anything else in those functions is a gate like anywhere else:
 * `if (world.simVersion >= 73)` added to validateSimVersion fails (Codex on #422).
 * Changing a window check means updating this list.
 */
const WINDOW_COMPARISONS: Readonly<Record<string, readonly string[]>> = {
  'src/platform/save.ts validateSimVersion': [
    'raw > LATEST_SIM_VERSION',
    'raw < MIN_ACCEPTED_SIM_VERSION',
  ],
  'src/platform/snapshot-window.ts snapshotWindowMessage': [
    'simVersion < min',
    'simVersion > latest',
  ],
};

/**
 * The constants a window comparison may name, each with the one binding it must
 * resolve to in its file. Any other operand must be the window check's own parameter.
 */
const WINDOW_CONSTANTS: ReadonlyMap<string, (sf: ts.SourceFile) => ts.Identifier | undefined> =
  new Map([
    ['LATEST_SIM_VERSION', latestImport],
    ['MIN_ACCEPTED_SIM_VERSION', (sf: ts.SourceFile) => minLine(sf)?.name],
  ]);

/**
 * True when `id` declares a binding: a variable (a catch clause's included), a
 * parameter, a destructured name, a function, class, enum or namespace, or an import.
 */
function isBindingName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isImportEqualsDeclaration(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportSpecifier(p)) &&
    p.name === id
  );
}

/**
 * True when `n` is written, not read: the target of an assignment (compound and
 * destructuring ones included), of `++` or `--`, or of a for-in/of loop. It climbs
 * through what a target can be wrapped or destructured in: `(min) = 73`,
 * `min! = 73`, `[min] = [73]`, `({ min } = o)`, `({ a: min } = o)`, `[...min] = a`.
 */
function isWriteTarget(n: ts.Node): boolean {
  const p = n.parent;
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return p.left === n;
  }
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
    return (
      p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
    );
  }
  if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === n;
  return (
    (ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      (ts.isShorthandPropertyAssignment(p) && p.name === n) ||
      (ts.isPropertyAssignment(p) && p.initializer === n)) &&
    isWriteTarget(p)
  );
}

/** True when `name` is bound or written anywhere in `scope` but at `own`, its one binding. */
function reboundIn(scope: ts.Node, name: string, own: ts.Identifier): boolean {
  const visit = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) &&
      n.text === name &&
      n !== own &&
      (isBindingName(n) || isWriteTarget(n))) ||
    ts.forEachChild(n, (c) => (visit(c) ? true : undefined)) === true;
  return visit(scope);
}

/**
 * True when `name`, an operand of a window comparison in `decl`, is bound exactly
 * once. One of WINDOW_CONSTANTS must resolve to its real binding, with no other
 * binding of or assignment to that name in the file. Any other name must be `decl`'s
 * own plain parameter (no default, not rest or destructured), with no other binding
 * of or assignment to it in `decl` (save.ts has other functions with a `raw`).
 */
function boundOnce(name: string, decl: ts.FunctionDeclaration): boolean {
  const constant = WINDOW_CONSTANTS.get(name);
  if (constant !== undefined) {
    const sf = decl.getSourceFile();
    const own = constant(sf);
    return own !== undefined && !reboundIn(sf, name, own);
  }
  for (const p of decl.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text === name) {
      return (
        p.initializer === undefined &&
        p.dotDotDotToken === undefined &&
        !reboundIn(decl, name, p.name)
      );
    }
  }
  return false;
}

/**
 * True when `node` is one of the window comparisons listed for `fn` in `file`, and
 * means what it says. Beyond the exact text, it must be evaluated by the window
 * check itself, not by a function or class nested in it, and each operand must be
 * a bare name bound exactly once (boundOnce). Text alone would pass a local
 * `const LATEST_SIM_VERSION = 72`, an assignment `min = 73`, a default `min = 73` or
 * a nested `(raw) => raw > LATEST_SIM_VERSION` called with 72 (Codex on #422).
 */
function isWindowComparison(file: string, fn: string, node: ts.Node): boolean {
  const decl = topLevelFunction(node);
  if (decl?.name?.text !== fn || !ts.isBinaryExpression(node)) return false;
  const text = node.getText(node.getSourceFile()).replace(/\s+/g, ' ');
  if (!(WINDOW_COMPARISONS[`${file} ${fn}`] ?? []).includes(text)) return false;
  const evaluatedBy = ts.findAncestor(
    node.parent,
    (p) => ts.isFunctionLike(p) || ts.isClassLike(p),
  );
  if (evaluatedBy !== decl) return false;
  return [node.left, node.right].every((op) => ts.isIdentifier(op) && boundOnce(op.text, decl));
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
      return isWindowComparison(file, 'validateSimVersion', node) ? ALLOW.loadCheck : null;
    }
    // A named import of exactly the entry the MIN line uses, not renamed:
    // `SIM_VERSION_V99_FOO as G` would let G be compared unseen, and any other
    // entry has no allowed use in save.ts.
    const spec = node.parent;
    if (ts.isImportSpecifier(spec) && spec.propertyName === undefined) {
      const from = spec.parent.parent.parent.moduleSpecifier;
      return ts.isStringLiteral(from) &&
        from.text === '../sim/types.js' &&
        spec.name.text === minLine(node.getSourceFile())?.entry
        ? ALLOW.minImport
        : null;
    }
    return isWholeInitializerOf(node, 'MIN_ACCEPTED_SIM_VERSION') ? ALLOW.minDecl : null;
  }
  if (
    file === 'src/platform/snapshot-window.ts' &&
    kind === 'simVersion comparison' &&
    isWindowComparison(file, 'snapshotWindowMessage', node)
  ) {
    return ALLOW.windowCheck;
  }
  return null;
}

/** Every registry-name reference and simVersion comparison in one file's source. */
function findGateRefs(file: string, source: string): Ref[] {
  // No explicit ScriptKind: the compiler infers TS or JS from the file's extension.
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
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

/** TS/JS sources the guard scans; everything else (shell, JSON, snapshots) is not code the sim runs. */
const SOURCE_FILE = /\.[mc]?[tj]sx?$/;
/** Skipped: tests (which may pin versions) and declaration files. */
const SKIPPED_FILE = /\.test\.[mc]?[tj]sx?$|\.d\.[mc]?ts$/;

/** The TS/JS sources in `dir`, and, when `recursive`, in every directory below it. */
function listSourceFiles(dir: string, recursive = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (recursive) out.push(...listSourceFiles(p));
    } else if (SOURCE_FILE.test(entry) && !SKIPPED_FILE.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const repoPath = (f: string): string => relative(ROOT, f).split('\\').join('/');

/**
 * Every scanned file, repo-relative: SCAN_DIRS in full, and the repo root's own
 * files (the build configs, which can `define` a shipped flag), not recursively.
 */
const scannedFiles = (): string[] =>
  [
    ...SCAN_DIRS.flatMap((d) => listSourceFiles(join(ROOT, d))),
    ...listSourceFiles(ROOT, false),
  ].map(repoPath);

let treeRefs: Ref[] | null = null;
/** Every reference in the scanned tree (parsed once, on first use). */
function scanTree(): Ref[] {
  if (treeRefs === null) {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(100); // the walk found the tree
    treeRefs = files.flatMap((f) => findGateRefs(f, readFileSync(join(ROOT, f), 'utf8')));
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

  it('scans the root build configs, and the root HTML pages name no version (Codex on #422)', () => {
    // A build config can `define` a shipped flag from a version test
    // (`__USE_FOO__: JSON.stringify(LATEST_SIM_VERSION >= 73)`), so each is scanned.
    expect(scannedFiles()).toEqual(
      expect.arrayContaining([
        'vite.config.ts',
        'vite.lib.config.ts',
        'vitest.config.ts',
        'playwright.config.ts',
        'eslint.config.ts',
        'eslint.typecheck.config.ts',
      ]),
    );
    // Vite bundles index.html's inline module script, which the walk does not parse.
    const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
    expect(pages).toContain('index.html');
    for (const page of pages) {
      expect(readFileSync(join(ROOT, page), 'utf8'), page).not.toMatch(/sim_?version/i);
    }
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
      'class C { _simVersion = 0; f() { if (this._simVersion >= 72) g(); } }',
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
      'if (__SIM_VERSION__ >= 73) f();', // a Vite `define` name
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
      // A default export goes by whatever name its importer picks
      // (`import L from './ver.js'; L >= 73`) (Codex on #422).
      ['export default LATEST_SIM_VERSION;', 'export default LATEST_SIM_VERSION;'],
      ['export default t.MIN_ACCEPTED_SIM_VERSION;', 'export default t.MIN_ACCEPTED_SIM_VERSION;'],
      [
        'export default (LATEST_SIM_VERSION as number);',
        'export default (LATEST_SIM_VERSION as number);',
      ],
      ["export default t['LATEST_SIM_VERSION'];", "export default t['LATEST_SIM_VERSION'];"],
      ['export = world.simVersion;', 'export = world.simVersion;'],
    ];
    for (const [src, renamed] of cases) {
      expect(flagged('src/sim/foo.ts', src), src).toEqual([`version rename: ${renamed}`]);
    }
    // A default export of a registry name is reported once, as a registry name, and
    // one of anything else is not a rename.
    expect(flagged('src/sim/foo.ts', 'export default SIM_VERSION_V99_FOO;')).toEqual([
      'registry name: SIM_VERSION_V99_FOO',
    ]);
    expect(flagged('src/sim/foo.ts', 'export default t.SIM_VERSION_V99_FOO;')).toEqual([
      'registry name: SIM_VERSION_V99_FOO',
    ]);
    expect(
      flagged('vite.config.ts', 'export default defineConfig({ define: { __APP_VERSION__: v } });'),
    ).toEqual([]);
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
    // Only the entry the MIN line names may be imported (CodeRabbit on #422): another
    // entry has no allowed use in save.ts, and without a MIN line none is allowed.
    expect(
      flagged(
        'src/platform/save.ts',
        "import { SIM_VERSION_V98_BAR, SIM_VERSION_V99_FOO } from '../sim/types.js';\n" +
          'export const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO;\n',
      ),
    ).toEqual(['registry name: SIM_VERSION_V98_BAR']);
    expect(
      flagged('src/platform/save.ts', "import { SIM_VERSION_V99_FOO } from '../sim/types.js';"),
    ).toEqual(['registry name: SIM_VERSION_V99_FOO']);
    expect(
      flagged(
        'src/platform/save.ts',
        "import { SIM_VERSION_V99_FOO } from '../sim/types.js';\n" +
          'export let MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO;\n',
      ),
    ).toEqual(['registry name: SIM_VERSION_V99_FOO', 'registry name: SIM_VERSION_V99_FOO']);
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

  it('walks TS and JS sources, and skips only tests and declaration files (Codex on #422)', () => {
    // The walker itself, on a scratch tree: every TS/JS extension is listed, at any
    // depth; tests, declaration files, shell scripts and data files are not.
    const dir = mkdtempSync(join(tmpdir(), 'no-new-gates-'));
    try {
      mkdirSync(join(dir, 'nested'));
      const scanned = [
        'a.ts',
        'b.mts',
        'c.cts',
        'd.tsx',
        'e.js',
        'f.mjs',
        'g.cjs',
        'h.jsx',
        'nested/i.ts',
      ];
      const skipped = [
        'x.test.ts',
        'y.test.mjs',
        'z.d.ts',
        'w.d.mts',
        'run.sh',
        'data.json',
        'nested/v.snap',
      ];
      for (const f of [...scanned, ...skipped]) writeFileSync(join(dir, f), '');
      const listed = listSourceFiles(dir).map((f) => relative(dir, f).split('\\').join('/'));
      expect(listed.sort()).toEqual([...scanned].sort());
      // The repo root is walked without recursion: its own files only.
      const top = listSourceFiles(dir, false).map((f) => relative(dir, f));
      expect(top.sort()).toEqual(scanned.filter((f) => !f.includes('/')).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // A root build config's shipped flag is caught like any other gate.
    expect(
      flagged(
        'vite.config.ts',
        "import { LATEST_SIM_VERSION } from './src/sim/types.js';\n" +
          'export default defineConfig({\n' +
          '  define: { __USE_FOO__: JSON.stringify(LATEST_SIM_VERSION >= 73) },\n' +
          '});',
      ),
    ).toEqual(['simVersion comparison: LATEST_SIM_VERSION >= 73']);
    // And a JS-kind or TSX-kind file is parsed and its gate caught.
    for (const file of ['scripts/foo.mjs', 'scripts/foo.cjs', 'bench/foo.js', 'src/foo.tsx']) {
      expect(flagged(file, 'if (world.simVersion >= 72) run();'), file).toEqual([
        'simVersion comparison: world.simVersion >= 72',
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

  /** save.ts's real head: the LATEST import and the MIN line a window comparison names. */
  const SAVE_HEAD =
    "import { LATEST_SIM_VERSION, SIM_VERSION_V99_FOO } from '../sim/types.js';\n" +
    'export const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO;\n';

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
    expect(flagged('src/platform/save.ts', SAVE_HEAD + fn('validateSimVersion'))).toEqual([]);
    expect(flagged('src/platform/save.ts', SAVE_HEAD + fn('other'))).toEqual(both);
    expect(flagged('src/platform/other.ts', fn('validateSimVersion'))).toEqual(both);
    expect(
      flagged(
        'src/platform/save.ts',
        SAVE_HEAD + `export function load(raw) { ${fn('validateSimVersion')} }`,
      ),
    ).toEqual(both);
  });

  it('allows inside the window-check functions only their exact bound comparisons (Codex on #422)', () => {
    // A gate slipped into validateSimVersion or snapshotWindowMessage is still a gate.
    const save =
      SAVE_HEAD +
      'function validateSimVersion(raw) {\n' +
      '  if (raw > LATEST_SIM_VERSION) throw new Error();\n' +
      '  if (raw < MIN_ACCEPTED_SIM_VERSION) throw new Error();\n' +
      '  if (world.simVersion >= 73) migrate();\n' +
      '  if (raw >= MIN_ACCEPTED_SIM_VERSION + 1) migrate();\n' +
      '  return raw;\n' +
      '}';
    expect(flagged('src/platform/save.ts', save)).toEqual([
      'simVersion comparison: world.simVersion >= 73',
      'simVersion comparison: raw >= MIN_ACCEPTED_SIM_VERSION + 1',
    ]);
    const window =
      'export function snapshotWindowMessage(simVersion, min, latest) {\n' +
      '  if (simVersion < min) return "old";\n' +
      '  if (simVersion > latest) return "new";\n' +
      '  if (simVersion >= 73) return "gated";\n' +
      '  if (simVersion <= min) return "edge";\n' +
      '  if (simVersion /* edge */ < min) return "commented";\n' +
      '  if ((simVersion) < min) return "parenthesized";\n' +
      '  return null;\n' +
      '}';
    // Only whitespace is normalized: a comment or parentheses make a mismatch (fails safe).
    expect(flagged('src/platform/snapshot-window.ts', window)).toEqual([
      'simVersion comparison: simVersion >= 73',
      'simVersion comparison: simVersion <= min',
      'simVersion comparison: simVersion /* edge */ < min',
      'simVersion comparison: (simVersion) < min',
    ]);
  });

  it("allows a window comparison only on the check's own parameters and the real LATEST and MIN (Codex on #422)", () => {
    // The text alone matches, but the bound is not what the window check means: a
    // local constant, a nested function, a rebound or defaulted parameter.
    const latest = 'simVersion comparison: raw > LATEST_SIM_VERSION';
    const min = 'simVersion comparison: raw < MIN_ACCEPTED_SIM_VERSION';
    const validate = (body: string, params = 'raw'): string =>
      `function validateSimVersion(${params}) {\n${body}\n` +
      '  if (raw > LATEST_SIM_VERSION) throw new Error();\n' +
      '  if (raw < MIN_ACCEPTED_SIM_VERSION) throw new Error();\n' +
      '  return raw;\n' +
      '}\n';
    // The real shape passes, beside other functions that bind and write their own `raw`.
    expect(
      flagged(
        'src/platform/save.ts',
        SAVE_HEAD +
          validate('') +
          'function other(raw) { raw = 1; const { raw: r } = o; return r; }\n' +
          'function third() { let raw = 0; raw++; return raw; }\n',
      ),
    ).toEqual([]);
    const saveCases: readonly (readonly [string, readonly string[]])[] = [
      // A local constant shadows the real one, so every comparison on it is suspect.
      [
        SAVE_HEAD +
          validate(
            '  { const LATEST_SIM_VERSION = 72; if (raw > LATEST_SIM_VERSION) FLAGS.foo = true; }',
          ),
        [latest, latest],
      ],
      [
        SAVE_HEAD +
          validate(
            '  const MIN_ACCEPTED_SIM_VERSION = 73; if (raw < MIN_ACCEPTED_SIM_VERSION) legacy = true;',
          ),
        [min, min],
      ],
      // A nested function compares its own `raw`, which also rebinds the name.
      [
        SAVE_HEAD +
          validate(
            '  const g = (raw) => { if (raw > LATEST_SIM_VERSION) FLAGS.foo = true; }; g(72);',
          ),
        [latest, latest, min],
      ],
      [SAVE_HEAD + validate('  class K { f = raw > LATEST_SIM_VERSION; }'), [latest]],
      // No real LATEST: a local constant instead of the import, a renamed, type-only or
      // foreign import, an assignment to it, or a parameter of that name.
      [
        "import { SIM_VERSION_V99_FOO } from '../sim/types.js';\n" +
          'export const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V99_FOO;\n' +
          'const LATEST_SIM_VERSION = 72;\n' +
          validate(''),
        [latest],
      ],
      [
        SAVE_HEAD.replace('LATEST_SIM_VERSION,', 'PINNED as LATEST_SIM_VERSION,') + validate(''),
        [latest],
      ],
      [
        "import type { LATEST_SIM_VERSION } from '../sim/types.js';\n" +
          SAVE_HEAD.replace('LATEST_SIM_VERSION, ', '') +
          validate(''),
        [latest],
      ],
      [
        "import { LATEST_SIM_VERSION } from './pinned.js';\n" +
          SAVE_HEAD.replace('LATEST_SIM_VERSION, ', '') +
          validate(''),
        [latest],
      ],
      [SAVE_HEAD + 'LATEST_SIM_VERSION = 72;\n' + validate(''), [latest]],
      [SAVE_HEAD + validate('', 'raw, LATEST_SIM_VERSION'), [latest]],
      // No real MIN: a second declaration of it anywhere in the file.
      [SAVE_HEAD + 'function f(MIN_ACCEPTED_SIM_VERSION) { return 0; }\n' + validate(''), [min]],
      // A `raw` that is not the plain parameter: written, defaulted, rest, redeclared.
      [SAVE_HEAD + validate('  raw = 72;'), [latest, min]],
      [SAVE_HEAD + validate('', 'raw = 72'), [latest, min]],
      [SAVE_HEAD + validate('', '...raw'), [latest, min]],
      [SAVE_HEAD + validate('  var raw = 72;'), [latest, min]],
      [SAVE_HEAD + validate('', 'input'), [latest, min]],
    ];
    for (const [src, want] of saveCases) {
      expect(flagged('src/platform/save.ts', src), src).toEqual(want);
    }

    const lt = 'simVersion comparison: simVersion < min';
    const gt = 'simVersion comparison: simVersion > latest';
    const window = (body: string, params = 'simVersion, min, latest'): string =>
      `export function snapshotWindowMessage(${params}) {\n${body}\n` +
      "  if (simVersion < min) return 'old';\n" +
      "  if (simVersion > latest) return 'new';\n" +
      '  return null;\n' +
      '}\n';
    expect(flagged('src/platform/snapshot-window.ts', window(''))).toEqual([]);
    const windowCases: readonly (readonly [string, readonly string[]])[] = [
      ['  min = 73;', [lt]],
      ["  { const min = 73; if (simVersion < min) return 'gated'; }", [lt, lt]],
      ['  const check = (simVersion, min) => simVersion < min;', [lt, lt, gt]],
      ['  min++;', [lt]],
      ['  min ??= 73;', [lt]],
      ['  (min as number) = 73;', [lt]],
      ['  [min] = [73];', [lt]],
      ['  ({ min } = { min: 73 });', [lt]],
      ['  ({ m: min } = { m: 73 });', [lt]],
      ['  for (min of [73]) break;', [lt]],
      ['  try { f(); } catch (min) { return null; }', [lt]],
      ['  function min() { return 73; }', [lt]],
      ['  var latest = 999;', [gt]],
    ];
    for (const [body, want] of windowCases) {
      expect(flagged('src/platform/snapshot-window.ts', window(body)), body).toEqual(want);
    }
    // A parameter that is defaulted, rest or destructured is not a plain one.
    for (const [params, want] of [
      ['simVersion, min = 73, latest', [lt]],
      ['simVersion, latest, ...min', [lt]],
      ['simVersion, { min }, latest', [lt]],
    ] as const) {
      expect(flagged('src/platform/snapshot-window.ts', window('', params)), params).toEqual(want);
    }
  });
});
