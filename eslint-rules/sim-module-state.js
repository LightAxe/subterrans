// code/eslint-rules/sim-module-state.js
// Custom ESLint rule: subterrans/sim-module-state  (issue #211)
//
// Flags PERSISTENT MODULE-LEVEL mutable state in src/sim/ so it cannot land silently
// — the determinism footgun before lockstep multiplayer. A module-scope mutable buffer
// that isn't reset per tick diverges peers under lockstep and breaks save/replay, and is
// invisible in single-player. This rule forces a reviewable acknowledgement at the
// declaration site (see code/AGENTS.md → Review guidelines → Determinism).
//
// SCOPE — "persistent module-level" means a binding that lives for the module's (or a
// namespace's) lifetime: a declaration whose direct parent is the `Program` body or a
// `namespace`/`module` body (`TSModuleBlock`), plain or `export`ed. Declarations nested
// in a function, a block, a loop, or an `if` are NOT flagged — they are scoped to that
// one-time execution and do not persist as cross-tick state (a `var` hoisted out of a
// block is the rare exception and is treated as a documented gap, below).
//
// WHAT IT FLAGS at that scope:
//   - any `let` or `var` binding (reassignable — incl. scalars: the worst cross-tick
//     footgun);
//   - any `const` whose initializer, AFTER unwrapping type assertions / `satisfies` /
//     non-null `!` and trailing method-call chains, is an array literal, or a
//     `new <collection>()` (bare `new Map()` or global-qualified `new globalThis.Map()`)
//     — incl. chained forms like `new Int32Array(n).fill(-1)` and `[1, 2].map(...)`.
//
// ESCAPES (each makes intent explicit):
//   - immutable lookup array → `[...] as const` (optionally wrapped in an outer
//     `satisfies T`, which preserves the readonly value type). This is the ONLY array
//     exemption: `as number[]`, a `readonly`/`ReadonlyArray<>` annotation, and chained
//     forms like `[...] as const as number[]` / `[...] as unknown as const` /
//     `([...] as const).slice()` all leave a mutable runtime array and are flagged.
//   - genuine scratch/cache/memo → `// eslint-disable-next-line subterrans/sim-module-state
//     -- sim-scratch: reset-per-tick` (or sim-cache:/sim-memo: <why it is safe>). The
//     `--` reason is enforced separately by scripts/check-sim-boundary.sh.
//
// DELIBERATE GAPS (NOT caught — syntactic rule, covered by the review checklist):
//   - factory `CallExpression` returns (`const X = makeBuffer()`, `Array.from(...)`), and
//     plain mutable objects (`const X = {}`). Those carry a plain `// sim-scratch:` marker.
//   - `new RegExp()` / `new Error()` / custom (non-collection) classes.
//   - destructuring binds (`const [BUF] = [new Int32Array()]`) — the pattern's RHS is not
//     inspected (skipped so the common `const [a, b] = [1, 2]` form doesn't false-positive).
//   - non-literal/non-ctor expression forms: conditional (`c ? [] : []`), logical,
//     sequence, and identifier aliases (`const A = otherArray`) are not traced.
//   - `var` hoisted out of a nested block; `using` / `await using`; ambient `declare`.

/** `new`-expression callees that produce a mutable collection. */
const COLLECTION_CONSTRUCTORS = new Set([
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

/** Global namespace objects a collection ctor may be qualified by. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

/** True for `expr as const` / `<const>expr`. */
function isConstAssertion(node) {
  if (!node || (node.type !== 'TSAsExpression' && node.type !== 'TSTypeAssertion')) return false;
  const ann = node.typeAnnotation;
  return (
    ann &&
    ann.type === 'TSTypeReference' &&
    ann.typeName &&
    ann.typeName.type === 'Identifier' &&
    ann.typeName.name === 'const'
  );
}

/**
 * True when `init` is an immutable array lookup: `[...] as const`, optionally wrapped in
 * outer `satisfies T` (which preserves the readonly value type). Anything else leaves a
 * mutable runtime array.
 */
function isExemptAsConstArray(init) {
  let node = init;
  while (node && node.type === 'TSSatisfiesExpression') node = node.expression;
  return isConstAssertion(node) && node.expression && node.expression.type === 'ArrayExpression';
}

/**
 * Strip type assertions, non-null assertions (`!`), AND trailing method-call chains to
 * reach the base expression, so `new Int32Array(n).fill(-1)` / `([1] as const).slice()` /
 * `new Map()!` resolve to their array-literal or `new <collection>()` root.
 */
function unwrapToBase(node) {
  let cur = node;
  let changed = true;
  while (cur && changed) {
    changed = false;
    while (
      cur &&
      (cur.type === 'TSAsExpression' ||
        cur.type === 'TSSatisfiesExpression' ||
        cur.type === 'TSTypeAssertion' ||
        cur.type === 'TSNonNullExpression')
    ) {
      cur = cur.expression;
      changed = true;
    }
    if (
      cur &&
      cur.type === 'CallExpression' &&
      cur.callee &&
      cur.callee.type === 'MemberExpression'
    ) {
      cur = cur.callee.object;
      changed = true;
    }
  }
  return cur;
}

/** True for a `new <collection>()` — bare (`new Map()`) or global-qualified (`new globalThis.Map()`). */
function isCollectionConstructor(node) {
  if (!node || node.type !== 'NewExpression' || !node.callee) return false;
  const c = node.callee;
  if (c.type === 'Identifier') return COLLECTION_CONSTRUCTORS.has(c.name);
  return (
    c.type === 'MemberExpression' &&
    !c.computed &&
    c.object &&
    c.object.type === 'Identifier' &&
    GLOBAL_OBJECTS.has(c.object.name) &&
    c.property &&
    c.property.type === 'Identifier' &&
    COLLECTION_CONSTRUCTORS.has(c.property.name)
  );
}

/** Name of the collection ctor, bare or qualified. */
function collectionCtorName(node) {
  return node.callee.type === 'Identifier' ? node.callee.name : node.callee.property.name;
}

/**
 * True when the declaration is a PERSISTENT module/namespace binding — direct child of a
 * `Program` or `TSModuleBlock` body (plain or `export`ed). Block/loop/function-nested
 * declarations are scoped to one-time execution and return false.
 */
function isModuleScope(declaration) {
  let parent = declaration.parent;
  if (parent && parent.type === 'ExportNamedDeclaration') parent = parent.parent;
  return Boolean(parent) && (parent.type === 'Program' || parent.type === 'TSModuleBlock');
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Persistent module-level mutable state in src/sim must be `as const` (immutable arrays) or carry an eslint-disable with a sim-scratch/sim-cache/sim-memo reason (determinism invariant, issue #211).',
    },
    schema: [],
    messages: {
      mutableLet:
        'Module-level `let`/`var` in src/sim is reassignable cross-tick state. If immutable, use `const … as const`; otherwise add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why it is reset/safe>`.',
      mutableArray:
        'Module-level mutable array literal in src/sim. If it is an immutable lookup, wrap it as `[...] as const`; otherwise add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why>`. (A `readonly`/`ReadonlyArray<>` annotation, `as number[]`, or a chained `as const` does not make it immutable.)',
      mutableCollection:
        'Module-level mutable `new {{ctor}}()` in src/sim is cross-tick state. Add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why it is reset/safe>`.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.declare) return; // ambient `declare const/let` — no runtime state
        if (!isModuleScope(node)) return;

        for (const decl of node.declarations) {
          // Destructuring binds the initializer's elements into sub-locals; the RHS
          // literal isn't retained as one module binding. Skip (documented gap).
          if (decl.id.type === 'ArrayPattern' || decl.id.type === 'ObjectPattern') continue;

          if (node.kind === 'let' || node.kind === 'var') {
            // `var` is reassignable module state too (and hoisted) — treat it like `let`.
            context.report({ node: decl, messageId: 'mutableLet' });
            continue;
          }
          if (node.kind !== 'const') continue; // ignore `using` / `await using`
          if (!decl.init) continue;

          // Peel type assertions / non-null / trailing method-call chains to the base,
          // so `[1, 2].map(...)` / `new Int32Array(n).fill(-1)` resolve to their root.
          const base = unwrapToBase(decl.init);
          if (!base) continue;

          if (base.type === 'ArrayExpression') {
            if (isExemptAsConstArray(decl.init)) continue;
            context.report({ node: decl, messageId: 'mutableArray' });
          } else if (isCollectionConstructor(base)) {
            context.report({
              node: decl,
              messageId: 'mutableCollection',
              data: { ctor: collectionCtorName(base) },
            });
          }
        }
      },
    };
  },
};
