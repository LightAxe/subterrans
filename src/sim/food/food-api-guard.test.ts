// food-api-guard.test.ts — #290 PR 1: food STORAGE is touched only through the facade.
//
// Parses every non-test .ts file under src/, scripts/ and bench/ with the TypeScript
// compiler API and reports any syntactic reference to the food-storage fields
// `foodPiles` / `foodStored` (world.foodPiles, ColonyRecord.foodStored,
// ChamberRecord.foodStored), wherever it sits:
//   - member access          x.foodStored, x?.foodPiles
//   - element access         x['foodStored'], x[`foodPiles`]
//   - destructuring          const { foodStored } = c; multi-line patterns; renames;
//                            for (const { foodStored } of …); function / callback params
//   - object-literal keys    split in two kinds:
//       'object-literal key'    a key in a CONSTRUCTION literal — the literal is a
//                               `return` value, a variable initializer, an arrow
//                               body or a `.push(…)` argument (a new record);
//       'object-literal merge'  any other literal: Object.assign(c, { foodStored }),
//                               any literal with a spread ({ ...c, foodStored: 0 }),
//                               c = { foodStored }, ({ foodStored } = c),
//                               { ['foodStored']: n } passed anywhere else
//   - bare string literals   Reflect.get(c, 'foodStored'), const k = 'foodPiles'
// Comments are not code (the AST ignores them) and strings containing `//` are
// ordinary tokens. Type declarations (`foodStored: number` in an interface or type
// literal) are declarations, not access, and are not reported.
//
// A reference is allowed only inside the named functions listed in ALLOWED below,
// and only of the reference kinds listed for that function (or anywhere in the
// facade files). Anything else fails the test with file:line.
//
// Known limits (syntactic analysis cannot close them; review covers them):
//   - Dynamic keys: an element access with a non-literal key — c[k] where k comes
//     from a variable, a parameter or an exported key list such as
//     food-projection.ts's PROJECTION_STRIPPED_* arrays — is not reported. Only the
//     string literal where the key name is written is, and that is allow-listed in
//     the files that own such lists.
//   - READ does not tell reads from writes: getSaveInfo / savedChamberFoodFp may
//     use member access, so an assignment there would pass. They are platform code
//     over the raw snapshot JSON, not over a WorldState, so a write there cannot
//     reach sim state.
//   - Computed names built at run time ('food' + 'Stored', template expressions)
//     are not recognised.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // repo root (code/)
const SCAN_DIRS = ['src', 'scripts', 'bench'];
const NAMES: ReadonlySet<string> = new Set(['foodPiles', 'foodStored']);
const ANY = '*';

type RefKind =
  | 'member access'
  | 'element access'
  | 'destructuring'
  | 'object-literal key'
  | 'object-literal merge'
  | 'string literal';

const KEY: readonly RefKind[] = ['object-literal key']; // record constructors (construction sites only)
const READ: readonly RefKind[] = ['member access']; // raw-JSON readers
const STR: readonly RefKind[] = ['string literal']; // key-name lists

/**
 * file → enclosing named function → the reference KINDS it may use ('*' = any).
 * '<module>' is top-level code outside any function; the function key '*' covers
 * the whole file. Any-kind access is reserved for the facade, its test setter,
 * copyWorldState and the save serializers/validators; everything else is pinned
 * to the one kind it needs, so e.g. a raw `colony.foodStored += 1` inside a record
 * constructor (a member access) still fails.
 */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, readonly RefKind[] | '*'>>>> = {
  // The facade and its test-only setter own the storage.
  'src/sim/food/food-api.ts': { [ANY]: ANY },
  'src/sim/food/food-test-utils.ts': { [ANY]: ANY },
  // WorldState construction (literal) and cloning (field copies).
  'src/sim/types.ts': { createWorldState: KEY, copyWorldState: ANY },
  // Record constructors: the record type still declares the field until PR 2.
  'src/sim/colony/colony-store.ts': { createColonyRecord: KEY },
  'src/sim/colony/colony-system.ts': { checkPendingChambers: KEY },
  // Save serializer / validators own the on-disk shape.
  'src/platform/save.ts': {
    validateChamberRecord: ANY,
    serializeColony: ANY,
    serializeWorldState: ANY,
    validateColonyScalars: ANY,
    deserializeColony: ANY,
    deserializeWorldState: ANY,
    // The save-dialog summary reads the raw snapshot JSON, not a WorldState.
    getSaveInfo: READ,
    savedChamberFoodFp: READ,
  },
  'src/platform/save-schema.ts': { '<module>': STR },
  // The projection strips the storage-shaped keys from a serialized COPY by name.
  'src/platform/food-projection.ts': { '<module>': STR },
  // Bench fixture: chamber record literals.
  'bench/tick-cost.bench.ts': { buildBroodColony: KEY },
};

/** Whether `ref` in `file` is allowed; returns the allow-list key it used, or null. */
function allowedBy(file: string, ref: StorageRef): string | null {
  const entry = ALLOWED[file];
  if (entry === undefined) return null;
  for (const fn of [ref.fn, ANY]) {
    const kinds = entry[fn];
    if (kinds === undefined) continue;
    if (kinds === ANY || kinds.includes(ref.kind)) return `${fn}:${kinds === ANY ? ANY : ref.kind}`;
  }
  return null;
}

interface StorageRef {
  line: number;
  kind: RefKind;
  fn: string;
  text: string;
}

function stringLikeText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return stringLikeText(node.expression);
  return undefined;
}

/** Nearest enclosing NAMED function-like (arrow callbacks inherit their host's name). */
function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)) &&
      n.name !== undefined
    ) {
      return n.name.getText();
    }
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
      ts.isIdentifier(n.name)
    ) {
      return n.name.text;
    }
  }
  return '<module>';
}

/**
 * True when an object literal builds a NEW value: it is (through parentheses and
 * `as` / `satisfies` / `!` wrappers) a `return` value, a variable initializer, an
 * arrow-function body, or an argument of a `.push(…)` call. False for everything
 * else, notably Object.assign arguments, any literal that spreads another object
 * ({ ...c, foodStored }), assignments and destructuring-assignment targets.
 */
function isConstructionLiteral(lit: ts.ObjectLiteralExpression): boolean {
  // A literal that spreads another object is a merge/copy of an existing record.
  if (lit.properties.some((p) => ts.isSpreadAssignment(p))) return false;
  let child: ts.Node = lit;
  let p: ts.Node = lit.parent;
  while (
    ts.isParenthesizedExpression(p) ||
    ts.isAsExpression(p) ||
    ts.isSatisfiesExpression(p) ||
    ts.isNonNullExpression(p) ||
    ts.isTypeAssertionExpression(p)
  ) {
    child = p;
    p = p.parent;
  }
  if (ts.isReturnStatement(p)) return true;
  if (ts.isVariableDeclaration(p) && p.initializer === child) return true;
  if (ts.isArrowFunction(p) && p.body === child) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(child as ts.Expression)) {
    const callee = p.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'push';
  }
  return false;
}

/** Every syntactic reference to a food-storage field in `source`. */
function findStorageRefs(source: string, fileName = 'x.ts'): StorageRef[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: StorageRef[] = [];
  const hit = (node: ts.Node, kind: RefKind): void => {
    refs.push({
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      fn: enclosingFunctionName(node),
      text: node.getText(sf).split('\n')[0]!.slice(0, 100),
    });
  };
  const claimed = new Set<ts.Node>(); // string nodes already reported via a parent
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text)) {
      hit(node, 'member access');
    } else if (ts.isElementAccessExpression(node)) {
      const k = stringLikeText(node.argumentExpression);
      if (k !== undefined && NAMES.has(k) && !ts.isIdentifier(node.argumentExpression)) {
        hit(node, 'element access');
        claimed.add(node.argumentExpression);
      }
    } else if (ts.isBindingElement(node)) {
      const k = stringLikeText(node.propertyName ?? node.name);
      if (k !== undefined && NAMES.has(k)) {
        hit(node, 'destructuring');
        if (node.propertyName !== undefined) claimed.add(node.propertyName);
      }
    } else if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const k = stringLikeText(node.name);
      if (k !== undefined && NAMES.has(k)) {
        hit(
          node,
          isConstructionLiteral(node.parent) ? 'object-literal key' : 'object-literal merge',
        );
        claimed.add(node.name);
        if (ts.isComputedPropertyName(node.name)) claimed.add(node.name.expression);
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      NAMES.has(node.text) &&
      !claimed.has(node) &&
      !ts.isPropertySignature(node.parent) && // `'foodStored': number` in a type
      !ts.isLiteralTypeNode(node.parent) // keyof-style type positions
    ) {
      hit(node, 'string literal');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function scan(): { violations: string[]; allowedUsed: Map<string, Set<string>> } {
  const violations: string[] = [];
  const allowedUsed = new Map<string, Set<string>>();
  for (const d of SCAN_DIRS) {
    for (const file of listTsFiles(join(ROOT, d))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      for (const r of findStorageRefs(readFileSync(file, 'utf8'), rel)) {
        const by = allowedBy(rel, r);
        if (by !== null) {
          if (!allowedUsed.has(rel)) allowedUsed.set(rel, new Set());
          allowedUsed.get(rel)!.add(by);
        } else {
          violations.push(`${rel}:${r.line} in ${r.fn} (${r.kind}): ${r.text}`);
        }
      }
    }
  }
  return { violations, allowedUsed };
}

describe('#290 food facade guard', () => {
  const result = scan();

  it('no food-storage reference outside the facade and the allow-listed functions', () => {
    expect(result.violations).toEqual([]);
  });

  it('every allow-list entry (function × kind) is still needed (keeps the list tight)', () => {
    const stale: string[] = [];
    for (const [file, fns] of Object.entries(ALLOWED)) {
      for (const [fn, kinds] of Object.entries(fns)) {
        const keys = kinds === ANY ? [`${fn}:${ANY}`] : kinds.map((k) => `${fn}:${k}`);
        for (const k of keys)
          if (!result.allowedUsed.get(file)?.has(k)) stale.push(`${file} → ${k}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('an allow-listed function may use only its listed reference kinds', () => {
    // Reviewer repros: a raw write inside a record constructor, and a raw read
    // hidden at module level of a file allowed only its key-name strings.
    const cases: Array<[string, string]> = [
      [
        'src/sim/colony/colony-system.ts',
        'function checkPendingChambers(world, colony, ch) {\n' +
          '  colony.chambers.push({ chamberId: 1, foodStored: 0 });\n' +
          '  createChamberStock(world, colony, ch);\n' +
          '  colony.foodStored += 1;\n}',
      ],
      [
        'src/platform/food-projection.ts',
        'export const sneaky = { read: (w: any) => w.foodPiles.length };',
      ],
      ['src/sim/colony/colony-store.ts', 'function createColonyRecord(c) { c.foodStored = 5; }'],
      ['bench/tick-cost.bench.ts', 'function buildBroodColony(c) { const { foodStored } = c; }'],
      ['src/platform/save.ts', "function getSaveInfo(c) { return Reflect.get(c, 'foodStored'); }"],
      // KEY covers construction literals only, never a merge into a live record.
      [
        'src/sim/colony/colony-system.ts',
        'function checkPendingChambers(colony) { Object.assign(colony, { foodStored: 0 }); }',
      ],
      [
        'src/sim/colony/colony-store.ts',
        'function createColonyRecord(c) { const d = { ...c, foodStored: 9 }; return d; }',
      ],
      [
        'src/sim/colony/colony-store.ts',
        'function createColonyRecord(c) { c = { ...c, foodStored: 9 }; return c; }',
      ],
      ['bench/tick-cost.bench.ts', 'function buildBroodColony(c) { ({ foodStored: c.x } = c); }'],
    ];
    for (const [file, src] of cases) {
      const refs = findStorageRefs(src, file);
      const rejected = refs.filter((r) => allowedBy(file, r) === null);
      expect(rejected.length, `${file}: ${src}`).toBeGreaterThan(0);
    }
    // …while the permitted kind in the same place still passes.
    const okCases: Array<[string, string]> = [
      [
        'src/sim/colony/colony-system.ts',
        'function checkPendingChambers(colony) { colony.chambers.push({ foodStored: 0 }); }',
      ],
      [
        'src/sim/colony/colony-store.ts',
        'function createColonyRecord() { return { foodStored: 0 }; }',
      ],
      [
        'src/sim/colony/colony-store.ts',
        'function createColonyRecord() { const r = { foodStored: 0 } as R; return r; }',
      ],
    ];
    for (const [file, src] of okCases) {
      const ok = findStorageRefs(src, file);
      expect(ok.length, src).toBe(1);
      expect(
        ok.every((r) => allowedBy(file, r) !== null),
        src,
      ).toBe(true);
    }
  });

  it('catches every known escaping shape', () => {
    const shapes: Array<[string, string]> = [
      ['member access', 'function f(c) { return c.foodStored; }'],
      ['optional chaining', 'function f(w) { return w?.foodPiles?.length; }'],
      ['element access, single quotes', "function f(c) { return c['foodStored']; }"],
      ['element access, template', 'function f(w) { return w[`foodPiles`]; }'],
      ['destructuring', 'function f(c) { const { foodStored } = c; return foodStored; }'],
      [
        'multi-line destructuring',
        'function f(c) {\n  const {\n    workerCount,\n    foodStored,\n  } = c;\n  return foodStored;\n}',
      ],
      ['renamed destructuring', 'function f(c) { const { foodStored: s } = c; return s; }'],
      [
        'for-of destructuring',
        'function f(cs) { for (const { foodStored } of cs) use(foodStored); }',
      ],
      ['parameter destructuring', 'function f({ foodPiles }) { return foodPiles; }'],
      [
        'callback destructuring',
        'function f(cs) { return cs.map(({ foodStored }) => foodStored); }',
      ],
      ['nested destructuring', 'function f(w) { const { colonies: { 1: { foodStored } } } = w; }'],
      ['assignment pattern', 'function f(c) { let x; ({ foodStored: x } = c); return x; }'],
      [
        'after a string containing //',
        "function f(c) { const u = 'http://x'; return c.foodStored; }",
      ],
      [
        'after a block comment opener in a string',
        "function f(c) { const u = '/*'; return c.foodStored; }",
      ],
      ['computed key via const', "const K = 'foodStored'; function f(c) { return c[K]; }"],
      ['Reflect.get', "function f(c) { return Reflect.get(c, 'foodStored'); }"],
      ['Reflect.set', "function f(c) { Reflect.set(c, 'foodStored', 0); }"],
      ['Object.assign key', 'function f(c) { Object.assign(c, { foodStored: 0 }); }'],
      [
        'Object.assign shorthand',
        'function f(c, foodStored) { Object.assign(c, { foodStored }); }',
      ],
      ['computed literal key', "function f(c) { Object.assign(c, { ['foodStored']: 0 }); }"],
      ['spread-then-key', 'function f(c) { return { ...c, foodStored: 0 }; }'],
    ];
    const missed = shapes.filter(([, src]) => findStorageRefs(src).length === 0).map(([n]) => n);
    expect(missed).toEqual([]);
  });

  it('does not flag comments, type declarations or unrelated names', () => {
    const clean = [
      '// c.foodStored in a comment\n/* w.foodPiles */ function f(c) { return c.poolFood; }',
      'interface R { foodStored: number; foodPiles?: unknown[] }',
      "type T = { 'foodStored': number };",
      'function f(c) { return c.foodStoredTotal + c.myFoodPiles; }',
      "const s = 'the foodStored field';",
    ];
    expect(clean.flatMap((src) => findStorageRefs(src))).toEqual([]);
  });

  it('reports the enclosing function so the allow-list can stay per-function', () => {
    const refs = findStorageRefs(
      'function outer(w) { return w.xs.map((p) => p.foodStored); }\nconst g = (c) => c.foodStored;',
    );
    expect(refs.map((r) => r.fn)).toEqual(['outer', 'g']);
  });
});
