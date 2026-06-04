// code/src/sim/clny-08-guard.test.ts
// CLNY-08 / Phase 9 SC 7 — no player-vs-enemy BRANCHING inside src/sim/ production code.
//
// Scope: every non-test .ts file under src/sim/ (recursive).
// Carve-outs:
//   1. `*.test.ts` — tests legitimately branch on colony identity in assertions.
//   2. `constants.ts` — the definition site for PLAYER_COLONY_ID / ENEMY_COLONY_ID.
// What's a "branch"?
//   - Direct equality / inequality against the constants: `=== PLAYER_COLONY_ID`, `PLAYER_COLONY_ID ===`, etc.
//   - Helper predicates named `isPlayer` or `isEnemy` (any form).
//   - (Bonus) any `if`-statement condition string mentioning either constant.
// What's NOT a branch (explicitly permitted):
//   - `world.colonies[PLAYER_COLONY_ID]`, `grids[ENEMY_COLONY_ID] = ...`
//   - `initColony(world, PLAYER_COLONY_ID, ...)`
//   - `for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID])`
//   - Import statements
//   - Comments (stripped before scanning)

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // .../code/src/sim/

function listSimProductionFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      out.push(...listSimProductionFiles(p));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function stripCommentsAndImports(source: string): string {
  return (
    source
      // line comments
      .replace(/\/\/.*$/gm, '')
      // block comments (non-greedy, multiline)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // import statements (whole line) — keyed access inside imports is irrelevant
      .replace(/^\s*import\s[^;]*;\s*$/gm, '')
  );
}

// Branching regexes. Each must match a branching USE, not a keyed access or call argument.
const BRANCHING_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: '=== PLAYER_COLONY_ID', re: /===\s*PLAYER_COLONY_ID\b/ },
  { name: '!== PLAYER_COLONY_ID', re: /!==\s*PLAYER_COLONY_ID\b/ },
  { name: 'PLAYER_COLONY_ID ===', re: /\bPLAYER_COLONY_ID\s*===/ },
  { name: 'PLAYER_COLONY_ID !==', re: /\bPLAYER_COLONY_ID\s*!==/ },
  { name: '=== ENEMY_COLONY_ID', re: /===\s*ENEMY_COLONY_ID\b/ },
  { name: '!== ENEMY_COLONY_ID', re: /!==\s*ENEMY_COLONY_ID\b/ },
  { name: 'ENEMY_COLONY_ID ===', re: /\bENEMY_COLONY_ID\s*===/ },
  { name: 'ENEMY_COLONY_ID !==', re: /\bENEMY_COLONY_ID\s*!==/ },
  { name: 'isPlayer identifier', re: /\bisPlayer\b/ },
  { name: 'isEnemy identifier', re: /\bisEnemy\b/ },
];

// Carve-outs — file paths (relative to src/sim/) that are exempt from the scan.
const CARVE_OUTS = new Set<string>([
  'constants.ts', // the definition site — exporting the symbols is not branching
]);

describe('CLNY-08 / SC 7 static branching guard', () => {
  const files = listSimProductionFiles(HERE);

  it('scans at least 10 production sim files (sanity)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = relative(HERE, file);
    if (CARVE_OUTS.has(rel)) continue;

    it(`${rel} contains no player-vs-enemy branching`, () => {
      const raw = readFileSync(file, 'utf-8');
      const cleaned = stripCommentsAndImports(raw);

      const hits: string[] = [];
      for (const { name, re } of BRANCHING_PATTERNS) {
        if (re.test(cleaned)) hits.push(name);
      }

      expect(
        hits,
        `${rel} violates CLNY-08 — branching pattern(s) detected: ${hits.join(', ')}. ` +
          `Keyed access and iteration are permitted; direct equality and isPlayer/isEnemy helpers are not.`,
      ).toEqual([]);
    });
  }
});
