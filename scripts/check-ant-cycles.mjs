#!/usr/bin/env node
// scripts/check-ant-cycles.mjs
// #212: enforce the layered, ACYCLIC module graph for src/sim/ant/.
//
// Parses static `import/export … from './x.js'` (incl. multi-line forms), dynamic
// `import('./x.js')`, and bare side-effect `import './x.js'` among src/sim/ant/*.ts
// (excluding *.test.ts), builds the intra-ant import graph, detects cycles, and forbids
// any sub-module from importing the barrel './ant-system.js' (a module->barrel->module
// cycle). Pure `import type { … } from './x'` statements are excluded — type-only
// imports are erased at compile time and cannot form a runtime cycle, so counting them
// would risk a phantom-cycle false positive.
//
// Known limitation: comment stripping is not string-literal aware, so a `/*`…`*/` pair
// split across two separate string literals could elide a real import line. The ant/
// tree contains no such literals today; revisit if that changes.
//
// PLAN.md #212 layering: Layer 0 `ant-motion` (leaf) <- behaviors <- `ant-movement`
// (orchestrator) <- `ant-system` (barrel). Exit 0 clean; exit 1 with a diagnostic.
// No network, no deps — runs in `npm run verify`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const DIR = 'src/sim/ant';
const BARREL = 'ant-system';

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => basename(f, '.ts'));
const fileset = new Set(files);

// Strip block + line comments so a `from './x.js'` mention inside a comment is not
// mistaken for a real import edge, then strip pure type-only import statements (which
// produce no runtime edge).
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
function stripTypeOnlyImports(s) {
  return s
    .replace(/\bimport\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/g, '') // braced
    .replace(
      /\bimport\s+type\s+(?:\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s*['"][^'"]+['"];?/g,
      '', // default / namespace type-only imports
    );
}

// Runtime-edge sources, all matched over the whole (comment-stripped) file so multi-line
// forms are caught: static `… from './x'` (import-from + export-from), dynamic
// `import('./x')`, and bare side-effect `import './x'`. The sibling-path alternation
// `(?:\./|\.\./ant/)` catches both the conventional `./x` form and the relative-up
// `../ant/x` form, so a barrel import / cycle written either way is still gated.
const SIB = '(?:\\.\\/|\\.\\.\\/ant\\/)';
const STATIC_RE = new RegExp(`\\bfrom\\s*['"]${SIB}([A-Za-z0-9_-]+)(?:\\.js)?['"]`, 'g');
const DYNAMIC_RE = new RegExp(
  `\\bimport\\s*\\(\\s*['"]${SIB}([A-Za-z0-9_-]+)(?:\\.js)?['"]\\s*\\)`,
  'g',
);
const SIDEEFFECT_RE = new RegExp(`^\\s*import\\s+['"]${SIB}([A-Za-z0-9_-]+)(?:\\.js)?['"]`, 'gm');

const graph = new Map(files.map((f) => [f, new Set()]));
const barrelImporters = [];

for (const mod of files) {
  const src = stripTypeOnlyImports(stripComments(readFileSync(join(DIR, mod + '.ts'), 'utf8')));
  for (const RE of [STATIC_RE, DYNAMIC_RE, SIDEEFFECT_RE]) {
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(src))) {
      const target = m[1];
      if (!fileset.has(target)) continue; // only intra-ant sibling modules
      if (target === BARREL && mod !== BARREL) {
        barrelImporters.push(`${mod}.ts imports the barrel ./${BARREL}.js`);
      }
      graph.get(mod).add(target);
    }
  }
}

// Layer policy (#212): enforce the documented dependency DIRECTION, not merely
// acyclicity. Layer 0 leaf (ant-motion + the pre-existing SoA ant-store) <- Layer 1
// behaviors <- Layer 2 orchestrator (ant-movement) <- barrel (ant-system). A new
// sub-module defaults to 'behavior' (the strictest rule); update this map deliberately
// when introducing a new leaf or orchestrator.
const layerOf = (mod) =>
  mod === 'ant-system'
    ? 'barrel'
    : mod === 'ant-movement'
      ? 'orchestrator'
      : mod === 'ant-motion' || mod === 'ant-store'
        ? 'leaf'
        : 'behavior';
const ALLOWED = {
  leaf: new Set(['leaf']),
  behavior: new Set(['leaf']),
  orchestrator: new Set(['leaf', 'behavior']),
  barrel: new Set(['leaf', 'behavior', 'orchestrator']),
};
const layerViolations = [];
for (const [mod, targets] of graph) {
  const from = layerOf(mod);
  for (const t of targets) {
    const to = layerOf(t);
    if (!ALLOWED[from].has(to)) {
      layerViolations.push(
        `${mod}.ts (${from}) imports ${t}.ts (${to}) — a ${from} may import only ${[...ALLOWED[from]].join('/')}`,
      );
    }
  }
}

// DFS cycle detection (white/gray/black).
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map(files.map((f) => [f, WHITE]));
const stack = [];
const cycles = [];
function dfs(u) {
  color.set(u, GRAY);
  stack.push(u);
  for (const v of graph.get(u)) {
    if (color.get(v) === GRAY) {
      cycles.push([...stack.slice(stack.indexOf(v)), v].join(' -> '));
    } else if (color.get(v) === WHITE) {
      dfs(v);
    }
  }
  stack.pop();
  color.set(u, BLACK);
}
for (const f of files) if (color.get(f) === WHITE) dfs(f);

let bad = false;
if (barrelImporters.length) {
  bad = true;
  console.error(
    'check-ant-cycles: sub-module imports the barrel (module -> barrel -> module cycle):',
  );
  for (const b of barrelImporters) console.error('  ' + b);
}
if (cycles.length) {
  bad = true;
  console.error('check-ant-cycles: import cycle(s) detected in src/sim/ant/:');
  for (const c of [...new Set(cycles)]) console.error('  ' + c);
}
if (layerViolations.length) {
  bad = true;
  console.error(
    'check-ant-cycles: layer-direction violation(s) (#212 — behaviors may depend only on Layer 0):',
  );
  for (const v of layerViolations) console.error('  ' + v);
}
if (bad) {
  console.error(
    '\nThe ant/ module graph MUST be acyclic (#212: Layer 0 ant-motion <- behaviors <- ant-movement <- barrel).',
  );
  process.exit(1);
}
const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
console.log(
  `check-ant-cycles: clean — ${files.length} modules, ${edges} intra-ant edges, no cycles, no barrel imports.`,
);
