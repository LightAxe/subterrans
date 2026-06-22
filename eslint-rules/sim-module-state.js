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
//   - destructuring is inspected by direct array-index / object-property match on an
//     array/object literal RHS (`const [buf] = [new Int32Array()]` IS caught); a
//     rest/computed/nested pattern or a non-literal RHS (`const [x] = makePair()`) is not.
//   - sequence expressions (`(f(), [])`) and identifier aliases (`const A = otherArray`)
//     are not traced. Conditional (`c ? [] : []`) and logical (`a || []`) ARE traced.
//   - `var` hoisted out of a nested block; `using` / `await using`; ambient `declare`.
//
// NOT a hazard (correctly NOT flagged — the collection is discarded, not retained):
// member/property access on a fresh collection, e.g. `const x = new Map().get` (a
// reference to the unbound `Map.prototype.get` — JS methods are not auto-bound) or
// `const n = new Set().size` (a primitive). Neither keeps a live collection.

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

/** Peel `as X` / `<X>` / `satisfies X` / non-null `!` wrappers off an expression. */
function peelAssertions(node) {
  let cur = node;
  while (
    cur &&
    (cur.type === 'TSAsExpression' ||
      cur.type === 'TSSatisfiesExpression' ||
      cur.type === 'TSTypeAssertion' ||
      cur.type === 'TSNonNullExpression')
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Peel only `satisfies X` wrappers (type-preserving — never affects mutability). */
function peelSatisfies(node) {
  let cur = node;
  while (cur && cur.type === 'TSSatisfiesExpression') cur = cur.expression;
  return cur;
}

/**
 * True when `init` is an immutable array lookup: an array literal whose effective type is
 * readonly via `as const`. Handles `[...] as const`, `[...] as const satisfies T`, and
 * `[...] satisfies T as const` (satisfies is type-preserving in either position). A
 * mutating outer assertion (`as number[]`, `as unknown as const`) leaves it mutable.
 */
function isExemptAsConstArray(init) {
  const outer = peelSatisfies(init);
  if (!isConstAssertion(outer)) return false;
  const inner = peelSatisfies(outer.expression);
  return Boolean(inner) && inner.type === 'ArrayExpression';
}

/**
 * Strip type/non-null assertions AND trailing method-call chains to reach the base
 * expression, so `new Int32Array(n).fill(-1)` / `([1] as const).slice()` / `new Map()!`
 * resolve to their array-literal or `new <collection>()` root.
 */
function unwrapToBase(node) {
  let cur = node;
  let changed = true;
  while (cur && changed) {
    changed = false;
    const peeled = peelAssertions(cur);
    if (peeled !== cur) {
      cur = peeled;
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

/**
 * True for a `new <collection>()` — bare (`new Map()`), global-qualified
 * (`new globalThis.Map()`), or with the callee itself wrapped in type/non-null
 * assertions (`new (Map as any)()`, `new (Set!)()`).
 */
function isCollectionConstructor(node) {
  if (!node || node.type !== 'NewExpression' || !node.callee) return false;
  const c = peelAssertions(node.callee);
  if (!c) return false;
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

/** Name of the collection ctor (callee peeled of assertions), bare or qualified. */
function collectionCtorName(node) {
  const c = peelAssertions(node.callee);
  return c.type === 'Identifier' ? c.name : c.property.name;
}

/**
 * Classify an initializer as yielding persistent mutable state. Recurses through
 * conditional (`c ? a : b`) and logical (`a || b`, `x ?? y`) expressions — ANY branch
 * that yields a mutable array/collection makes the binding a hazard. Returns
 * `{ kind: 'array' }` | `{ kind: 'collection', ctor }` | null.
 */
function findMutable(node) {
  if (!node) return null;
  // Unwrap assertions / non-null / method-call chains FIRST, so an outer wrapper on a
  // conditional/logical (`(cond ? [1] : [2]) as number[]`, `(a || [1]).slice()`) still
  // reaches the branch recursion below rather than falling through as non-mutable.
  const base = unwrapToBase(node);
  if (!base) return null;
  if (base.type === 'ConditionalExpression') {
    return findMutable(base.consequent) || findMutable(base.alternate);
  }
  if (base.type === 'LogicalExpression') {
    return findMutable(base.left) || findMutable(base.right);
  }
  if (base.type === 'ArrayExpression') return isExemptAsConstArray(node) ? null : { kind: 'array' };
  if (isCollectionConstructor(base)) return { kind: 'collection', ctor: collectionCtorName(base) };
  return null;
}

/** True when an expression value yields a mutable array/collection (used by destructuring). */
function isMutableCollectionValue(node) {
  return findMutable(node) !== null;
}

/**
 * True when a destructuring pattern binds a mutable array/collection element of an
 * array/object literal initializer into a persistent local — e.g. `const [buf] =
 * [new Int32Array(8)]` or `const { m } = { m: new Map() }`. Matches by array index /
 * object-property name; rest/computed/nested patterns and non-literal RHS are not traced
 * (documented gaps). `const [a, b] = [1, 2]` (primitives) is correctly not matched.
 */
function destructuringBindsMutable(pattern, init) {
  const base = unwrapToBase(init);
  if (!base) return false;
  if (pattern.type === 'ArrayPattern' && base.type === 'ArrayExpression') {
    for (let i = 0; i < pattern.elements.length; i++) {
      const pel = pattern.elements[i];
      if (!pel || pel.type === 'RestElement') continue; // hole / rest — gap
      const rel = base.elements[i];
      if (rel && rel.type !== 'SpreadElement' && isMutableCollectionValue(rel)) return true;
    }
  } else if (pattern.type === 'ObjectPattern' && base.type === 'ObjectExpression') {
    for (const pprop of pattern.properties) {
      if (
        pprop.type !== 'Property' ||
        pprop.computed ||
        !pprop.key ||
        pprop.key.type !== 'Identifier'
      ) {
        continue;
      }
      const rprop = base.properties.find(
        (p) =>
          p.type === 'Property' &&
          !p.computed &&
          p.key &&
          p.key.type === 'Identifier' &&
          p.key.name === pprop.key.name,
      );
      if (rprop && isMutableCollectionValue(rprop.value)) return true;
    }
  }
  return false;
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
      mutableDestructure:
        'Module-level destructuring binds a mutable array/collection into a persistent local. Bind it directly (with `as const` if immutable) or add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why it is reset/safe>`.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.declare) return; // ambient `declare const/let` — no runtime state
        if (!isModuleScope(node)) return;

        for (const decl of node.declarations) {
          // Destructuring: the RHS literal isn't retained as one binding, but an element
          // bound into a local can be a live collection (`const [buf] = [new Int32Array()]`).
          // Inspect the matched element/property rather than skipping wholesale.
          if (decl.id.type === 'ArrayPattern' || decl.id.type === 'ObjectPattern') {
            if (decl.init && destructuringBindsMutable(decl.id, decl.init)) {
              context.report({ node: decl, messageId: 'mutableDestructure' });
            }
            continue;
          }

          if (node.kind === 'let' || node.kind === 'var') {
            // `var` is reassignable module state too (and hoisted) — treat it like `let`.
            context.report({ node: decl, messageId: 'mutableLet' });
            continue;
          }
          if (node.kind !== 'const') continue; // ignore `using` / `await using`
          if (!decl.init) continue;

          // Classify the initializer (peeling assertions/non-null/method chains, and
          // recursing through conditional/logical branches) as a mutable array/collection.
          const found = findMutable(decl.init);
          if (found && found.kind === 'array') {
            context.report({ node: decl, messageId: 'mutableArray' });
          } else if (found && found.kind === 'collection') {
            context.report({
              node: decl,
              messageId: 'mutableCollection',
              data: { ctor: found.ctor },
            });
          }
        }
      },
    };
  },
};
