// food-api-guard.test.ts — #290 PR 1: food STORAGE is touched only through the facade.
//
// Scans every non-test .ts file under src/, scripts/ and bench/ for direct access
// to the three food-storage fields — `world.foodPiles`, `ColonyRecord.foodStored`
// and `ChamberRecord.foodStored` — and fails if any appears outside the files that
// own the storage. Comments are stripped first. Object-literal KEYS (`foodStored: 0`
// in a record constructor) are not access and are not flagged; member access
// (`x.foodStored`, `x?.foodPiles`), bracket access (`x['foodStored']`) and
// destructuring (`{ foodPiles } = …`) are.
//
// Allowed:
//   - src/sim/food/food-api.ts        — the facade itself
//   - src/sim/food/food-test-utils.ts — test/bench setters (bypass caps)
//   - src/sim/types.ts                — the WorldState declaration + copyWorldState
//   - src/platform/save.ts            — the serializer/validator (owns the on-disk shape)
//   - src/platform/save-schema.ts     — the serialized-field inventory

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // repo root (code/)
const SCAN_DIRS = ['src', 'scripts', 'bench'];
const ALLOWED = new Set([
  'src/sim/food/food-api.ts',
  'src/sim/food/food-test-utils.ts',
  'src/sim/types.ts',
  'src/platform/save.ts',
  'src/platform/save-schema.ts',
]);

const ACCESS_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'member access .foodPiles', re: /\.\s*foodPiles\b/ },
  { name: 'member access .foodStored', re: /\.\s*foodStored\b/ },
  {
    name: "bracket access ['foodPiles'|'foodStored']",
    re: /\[\s*['"`]food(?:Piles|Stored)['"`]\s*\]/,
  },
  {
    name: 'destructuring { foodPiles | foodStored }',
    re: /\{[^{}]*\bfood(?:Piles|Stored)\b[^{}]*\}\s*=[^=>]/,
  },
];

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

function stripComments(source: string): string {
  // `//` preceded by `:` is a URL inside a string (http://…), not a comment.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function findDirectFoodStorageAccess(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of listTsFiles(join(ROOT, d))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const { name, re } of ACCESS_PATTERNS) {
          if (re.test(line)) hits.push(`${rel}:${i + 1} (${name}): ${line.trim()}`);
        }
      });
    }
  }
  return hits;
}

describe('#290 food facade guard', () => {
  it('no direct food-storage access outside the facade and the save serializer', () => {
    expect(findDirectFoodStorageAccess()).toEqual([]);
  });

  it('the scan actually sees the allowed owners (guards against a vacuous pass)', () => {
    const facade = stripComments(readFileSync(join(ROOT, 'src/sim/food/food-api.ts'), 'utf8'));
    expect(ACCESS_PATTERNS[0]!.re.test(facade)).toBe(true);
    expect(ACCESS_PATTERNS[1]!.re.test(facade)).toBe(true);
    expect(listTsFiles(join(ROOT, 'src')).length).toBeGreaterThan(100);
  });
});
