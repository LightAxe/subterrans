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
//   - object-literal keys    { foodStored: 0 }, Object.assign(c, { foodStored }),
//                            ({ foodStored } = c), { ['foodStored']: n }
//   - bare string literals   Reflect.get(c, 'foodStored'), const k = 'foodPiles'
// Comments are not code (the AST ignores them) and strings containing `//` are
// ordinary tokens. Type declarations (`foodStored: number` in an interface or type
// literal) are declarations, not access, and are not reported.
//
// A reference is allowed only inside the named functions listed in ALLOWED below
// (or anywhere in the facade files). Anything else fails the test with file:line.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // repo root (code/)
const SCAN_DIRS = ['src', 'scripts', 'bench'];
const NAMES: ReadonlySet<string> = new Set(['foodPiles', 'foodStored']);
const ANY = '*';

/**
 * file → enclosing named functions allowed to reference food storage ('*' = whole
 * file). '<module>' is top-level code outside any function.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // The facade and its test-only setter own the storage.
  'src/sim/food/food-api.ts': [ANY],
  'src/sim/food/food-test-utils.ts': [ANY],
  // WorldState construction and cloning.
  'src/sim/types.ts': ['createWorldState', 'copyWorldState'],
  // Record constructors: the record type still declares the field until PR 2.
  'src/sim/colony/colony-store.ts': ['createColonyRecord'],
  'src/sim/colony/colony-system.ts': ['checkPendingChambers'],
  // Save serializer / validator / dialog summary: they own the on-disk shape.
  'src/platform/save.ts': [
    'validateChamberRecord',
    'serializeColony',
    'serializeWorldState',
    'validateColonyScalars',
    'deserializeColony',
    'deserializeWorldState',
    'getSaveInfo',
    'savedChamberFoodFp',
  ],
  'src/platform/save-schema.ts': ['<module>'],
  // The projection strips the storage-shaped keys from a serialized COPY.
  'src/platform/food-projection.ts': ['<module>'],
  // Bench fixture: chamber record literals.
  'bench/tick-cost.bench.ts': ['buildBroodColony'],
};

interface StorageRef {
  line: number;
  kind: string;
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

/** Every syntactic reference to a food-storage field in `source`. */
function findStorageRefs(source: string, fileName = 'x.ts'): StorageRef[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: StorageRef[] = [];
  const hit = (node: ts.Node, kind: string): void => {
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
        hit(node, 'object-literal key');
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
      const allow = ALLOWED[rel] ?? [];
      for (const r of findStorageRefs(readFileSync(file, 'utf8'), rel)) {
        if (allow.includes(ANY) || allow.includes(r.fn)) {
          if (!allowedUsed.has(rel)) allowedUsed.set(rel, new Set());
          allowedUsed.get(rel)!.add(allow.includes(ANY) ? ANY : r.fn);
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

  it('every allow-list entry is still needed (keeps the list tight)', () => {
    const stale: string[] = [];
    for (const [file, fns] of Object.entries(ALLOWED)) {
      for (const fn of fns) {
        if (!result.allowedUsed.get(file)?.has(fn)) stale.push(`${file} → ${fn}`);
      }
    }
    expect(stale).toEqual([]);
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
