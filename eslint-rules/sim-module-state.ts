// code/eslint-rules/sim-module-state.ts
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
//     — incl. chained forms like `new Int32Array(n).fill(-1)` and `[1, 2].map(...)`;
//   - `export default <mutable>` (`export default new Map()` / `export default [1, 2]`),
//     which caches a mutable module-level singleton;
//   - `Object.freeze(...)` / `Object.seal(...)` wrapping a live collection — the freeze is
//     shallow, so the Map/Set inside stays mutable (freezing only primitive literals is
//     immutable and allowed).
//
// ESCAPES (each makes intent explicit):
//   - immutable lookup array → `[...] as const` (optionally wrapped in an outer
//     `satisfies T`, which preserves the readonly value type). This is the ONLY array
//     exemption: `as number[]`, a `readonly`/`ReadonlyArray<>` annotation, and chained
//     forms like `[...] as const as number[]` / `[...] as unknown as const` /
//     `([...] as const).slice()` all leave a mutable runtime array and are flagged. An
//     as-const array holding a live collection (`[new Map()] as const`) is also flagged —
//     `as const` makes the array readonly but cannot immutabilize the collection inside.
//   - genuine scratch/cache/memo → `// eslint-disable-next-line subterrans/sim-module-state
//     -- sim-scratch: reset-per-tick` (or sim-cache:/sim-memo: <why it is safe>). The
//     `--` reason is enforced separately by scripts/check-sim-boundary.sh.
//
// DELIBERATE GAPS (NOT caught — syntactic rule, covered by the review checklist):
//   - factory `CallExpression` returns (`const X = makeBuffer()`, `Array.from(...)`), and
//     plain mutable objects (`const X = {}`). Those carry a plain `// sim-scratch:` marker.
//   - `new RegExp()` / `new Error()` / custom (non-collection) classes.
//   - destructuring: a `let`/`var` destructuring is flagged (reassignable). For `const`,
//     array rest (`const [...r] = …` — always a fresh mutable array), defaults
//     (`[buf = new Map()]`), element/property matches on an array/object literal RHS, and
//     string-literal computed keys ARE caught. Object rest (`{ ...r }`, a plain object), a
//     DYNAMIC computed key, a nested sub-pattern, or a non-literal array RHS
//     (`const [x] = makePair()`) are not.
//   - sequence expressions (`(f(), [])`) and identifier aliases (`const A = otherArray`)
//     are not traced. Conditional (`c ? [] : []`) and logical (`a || []`) ARE traced.
//   - `var` hoisted out of a nested block; `using` / `await using`; ambient `declare`.
//   - pathological compositions no human writes: nested `Object.freeze(Object.freeze(x))`,
//     `Object.freeze([Object.seal(x)])`, destructuring of an `Object.freeze(...)` RHS, and
//     assignment-expression array elements (`[buf = new Int32Array()]`). These retain
//     mutable state but are out of scope for the syntactic rule — review-checklist items.
//
// NOT a hazard (correctly NOT flagged — the collection is discarded, not retained):
// member/property access on a fresh collection, e.g. `const x = new Map().get` (a
// reference to the unbound `Map.prototype.get` — JS methods are not auto-bound) or
// `const n = new Set().size` (a primitive). Neither keeps a live collection.

import type { Rule } from 'eslint';
// AST_NODE_TYPES is a runtime import (not type-only): the type-aware lint layer's
// `no-unsafe-enum-comparison` rule requires `node.type` (an `AST_NODE_TYPES` string enum)
// to be compared against the enum member, not a bare string literal.
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/types';

/** `new`-expression callees that produce a mutable collection. */
const COLLECTION_CONSTRUCTORS: ReadonlySet<string> = new Set([
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
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'window', 'self', 'global']);

/** True for `expr as const` / `<const>expr`. A plain boolean, not a type guard: it is
 *  false for assertion nodes too (`x as number[]`), so a guard would mis-narrow the
 *  false branch. Callers narrow on `node.type` themselves. */
function isConstAssertion(node: TSESTree.Node | null | undefined): boolean {
  if (
    !node ||
    (node.type !== AST_NODE_TYPES.TSAsExpression && node.type !== AST_NODE_TYPES.TSTypeAssertion)
  )
    return false;
  const ann = node.typeAnnotation;
  return Boolean(
    ann &&
    ann.type === AST_NODE_TYPES.TSTypeReference &&
    ann.typeName &&
    ann.typeName.type === AST_NODE_TYPES.Identifier &&
    ann.typeName.name === 'const',
  );
}

/** Peel `as X` / `<X>` / `satisfies X` / non-null `!` wrappers off an expression. */
function peelAssertions(node: TSESTree.Node): TSESTree.Node;
function peelAssertions(node: TSESTree.Node | null | undefined): TSESTree.Node | null | undefined;
function peelAssertions(node: TSESTree.Node | null | undefined): TSESTree.Node | null | undefined {
  let cur = node;
  while (
    cur &&
    (cur.type === AST_NODE_TYPES.TSAsExpression ||
      cur.type === AST_NODE_TYPES.TSSatisfiesExpression ||
      cur.type === AST_NODE_TYPES.TSTypeAssertion ||
      cur.type === AST_NODE_TYPES.TSNonNullExpression)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Peel only `satisfies X` wrappers (type-preserving — never affects mutability). */
function peelSatisfies(node: TSESTree.Node): TSESTree.Node;
function peelSatisfies(node: TSESTree.Node | null | undefined): TSESTree.Node | null | undefined;
function peelSatisfies(node: TSESTree.Node | null | undefined): TSESTree.Node | null | undefined {
  let cur = node;
  while (cur && cur.type === AST_NODE_TYPES.TSSatisfiesExpression) cur = cur.expression;
  return cur;
}

/**
 * True when `init` is an immutable array lookup: an array literal whose effective type is
 * readonly via `as const`. Handles `[...] as const`, `[...] as const satisfies T`, and
 * `[...] satisfies T as const` (satisfies is type-preserving in either position). A
 * mutating outer assertion (`as number[]`, `as unknown as const`) leaves it mutable.
 */
function isExemptAsConstArray(init: TSESTree.Node): boolean {
  const outer = peelSatisfies(init);
  if (
    (outer.type !== AST_NODE_TYPES.TSAsExpression &&
      outer.type !== AST_NODE_TYPES.TSTypeAssertion) ||
    !isConstAssertion(outer)
  ) {
    return false;
  }
  const inner = peelSatisfies(outer.expression);
  if (!inner || inner.type !== AST_NODE_TYPES.ArrayExpression) return false;
  // `as const` makes nested array/object/primitive literals deeply readonly, but it does
  // NOT immutabilize a live collection instance — `[new Map()] as const` still allows
  // `x[0].set(...)`. So an as-const array is exempt only if it holds no collection ctor.
  return !containsCollectionCtor(inner);
}

/** True when an expression contains a live `new <collection>()` — recursing array/object
 *  literals, conditional/logical branches, and `Object.freeze`/`Object.seal` wrappers. */
function containsCollectionCtor(node: TSESTree.Node | null | undefined): boolean {
  if (!node) return false;
  const frozen = objectFreezeArg(node);
  if (frozen) return containsCollectionCtor(frozen);
  const base = unwrapToBase(node);
  if (!base) return false;
  if (isCollectionConstructor(base)) return true;
  if (base.type === AST_NODE_TYPES.ConditionalExpression) {
    return containsCollectionCtor(base.consequent) || containsCollectionCtor(base.alternate);
  }
  if (base.type === AST_NODE_TYPES.LogicalExpression) {
    return containsCollectionCtor(base.left) || containsCollectionCtor(base.right);
  }
  if (base.type === AST_NODE_TYPES.ArrayExpression) {
    return base.elements.some((el) => {
      if (!el) return false;
      // A spread of an inline literal (`[...[new Map()]]`) still carries its elements in.
      if (el.type === AST_NODE_TYPES.SpreadElement) return containsCollectionCtor(el.argument);
      return containsCollectionCtor(el);
    });
  }
  if (base.type === AST_NODE_TYPES.ObjectExpression) {
    return base.properties.some(
      (p) =>
        (p.type === AST_NODE_TYPES.Property && containsCollectionCtor(p.value)) ||
        (p.type === AST_NODE_TYPES.SpreadElement && containsCollectionCtor(p.argument)),
    );
  }
  return false;
}

/**
 * Strip type/non-null assertions AND trailing method-call chains to reach the base
 * expression, so `new Int32Array(n).fill(-1)` / `([1] as const).slice()` / `new Map()!`
 * resolve to their array-literal or `new <collection>()` root.
 */
function unwrapToBase(node: TSESTree.Node): TSESTree.Node;
function unwrapToBase(node: TSESTree.Node | null | undefined): TSESTree.Node | null | undefined;
function unwrapToBase(node: TSESTree.Node | null | undefined): TSESTree.Node | null | undefined {
  let cur = node;
  let changed = true;
  while (cur && changed) {
    changed = false;
    const peeled = peelAssertions(cur);
    if (peeled !== cur) {
      cur = peeled;
      changed = true;
    }
    // Optional chains (`x?.m()`, `x?.m`) wrap the whole chain in a ChainExpression.
    if (cur && cur.type === AST_NODE_TYPES.ChainExpression) {
      cur = cur.expression;
      changed = true;
    }
    if (
      cur &&
      cur.type === AST_NODE_TYPES.CallExpression &&
      cur.callee &&
      cur.callee.type === AST_NODE_TYPES.MemberExpression
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
function isCollectionConstructor(node: TSESTree.Node | null | undefined): boolean {
  if (!node || node.type !== AST_NODE_TYPES.NewExpression || !node.callee) return false;
  const c = peelAssertions(node.callee);
  if (!c) return false;
  if (c.type === AST_NODE_TYPES.Identifier) return COLLECTION_CONSTRUCTORS.has(c.name);
  return Boolean(
    c.type === AST_NODE_TYPES.MemberExpression &&
    !c.computed &&
    c.object &&
    c.object.type === AST_NODE_TYPES.Identifier &&
    GLOBAL_OBJECTS.has(c.object.name) &&
    c.property &&
    c.property.type === AST_NODE_TYPES.Identifier &&
    COLLECTION_CONSTRUCTORS.has(c.property.name),
  );
}

/** Name of the collection ctor (callee peeled of assertions), bare or qualified. */
function collectionCtorName(node: TSESTree.NewExpression): string {
  const c = peelAssertions(node.callee);
  if (c.type === AST_NODE_TYPES.Identifier) return c.name;
  if (
    c.type === AST_NODE_TYPES.MemberExpression &&
    !c.computed &&
    c.property.type === AST_NODE_TYPES.Identifier
  ) {
    return c.property.name;
  }
  // Unreachable: the sole caller (findMutable) calls this only after
  // isCollectionConstructor(node) returned true, which guarantees an Identifier callee or
  // a non-computed member with an Identifier property. Throw rather than invent a name.
  throw new Error(`collectionCtorName: unexpected non-collection callee node type ${c.type}`);
}

/** If `node` is `Object.freeze(arg)` / `Object.seal(arg)`, return `arg`; else null. */
function objectFreezeArg(node: TSESTree.Node | null | undefined): TSESTree.Node | null {
  const peeled = peelAssertions(node);
  if (
    peeled &&
    peeled.type === AST_NODE_TYPES.CallExpression &&
    peeled.callee &&
    peeled.callee.type === AST_NODE_TYPES.MemberExpression &&
    !peeled.callee.computed &&
    peeled.callee.object &&
    peeled.callee.object.type === AST_NODE_TYPES.Identifier &&
    peeled.callee.object.name === 'Object' &&
    peeled.callee.property &&
    peeled.callee.property.type === AST_NODE_TYPES.Identifier &&
    (peeled.callee.property.name === 'freeze' || peeled.callee.property.name === 'seal') &&
    peeled.arguments.length > 0
  ) {
    // `arguments.length > 0` was just checked above; under noUncheckedIndexedAccess the
    // index access is still typed as possibly-undefined, so re-check rather than assert.
    const arg = peeled.arguments[0];
    if (!arg) return null;
    return arg;
  }
  return null;
}

/** True if a value is a non-primitive (mutable) structure — array/object literal or
 *  collection ctor (recursing conditional/logical branches). */
function isNonPrimitiveValue(node: TSESTree.Node | null | undefined): boolean {
  const base = unwrapToBase(node);
  if (!base) return false;
  if (isCollectionConstructor(base)) return true;
  if (base.type === AST_NODE_TYPES.ArrayExpression || base.type === AST_NODE_TYPES.ObjectExpression)
    return true;
  if (base.type === AST_NODE_TYPES.ConditionalExpression) {
    return isNonPrimitiveValue(base.consequent) || isNonPrimitiveValue(base.alternate);
  }
  if (base.type === AST_NODE_TYPES.LogicalExpression) {
    return isNonPrimitiveValue(base.left) || isNonPrimitiveValue(base.right);
  }
  return false;
}

/** True if shallow-freezing `node` (Object.freeze/seal) leaves nested mutable state — the
 *  freeze locks only the top level. `Object.freeze([1, 2])` is immutable; `[[1]]`,
 *  `[new Map()]`, `{ a: [1] }`, and `new Map()` are not. */
function shallowFreezeLeavesMutable(node: TSESTree.Node | null | undefined): boolean {
  const base = unwrapToBase(node);
  if (!base) return false;
  if (isCollectionConstructor(base)) return true;
  if (base.type === AST_NODE_TYPES.ConditionalExpression) {
    return (
      shallowFreezeLeavesMutable(base.consequent) || shallowFreezeLeavesMutable(base.alternate)
    );
  }
  if (base.type === AST_NODE_TYPES.LogicalExpression) {
    return shallowFreezeLeavesMutable(base.left) || shallowFreezeLeavesMutable(base.right);
  }
  if (base.type === AST_NODE_TYPES.ArrayExpression) {
    return base.elements.some((el) => {
      if (!el) return false;
      if (el.type === AST_NODE_TYPES.SpreadElement) return isNonPrimitiveValue(el.argument);
      return isNonPrimitiveValue(el);
    });
  }
  if (base.type === AST_NODE_TYPES.ObjectExpression) {
    return base.properties.some(
      (p) =>
        (p.type === AST_NODE_TYPES.Property && isNonPrimitiveValue(p.value)) ||
        (p.type === AST_NODE_TYPES.SpreadElement && isNonPrimitiveValue(p.argument)),
    );
  }
  return false;
}

/** Persistent-mutable-state classification for a `const` initializer / `export default`
 *  declaration, returned by `findMutable`. */
type MutableFinding = { kind: 'array' } | { kind: 'collection'; ctor: string } | { kind: 'frozen' };

/**
 * Classify an initializer as yielding persistent mutable state. Recurses through
 * conditional (`c ? a : b`) and logical (`a || b`, `x ?? y`) expressions — ANY branch
 * that yields a mutable array/collection makes the binding a hazard. Returns
 * `{ kind: 'array' }` | `{ kind: 'collection', ctor }` | `{ kind: 'frozen' }` | null.
 */
function findMutable(node: TSESTree.Node | null | undefined): MutableFinding | null {
  if (!node) return null;
  // `Object.freeze(x)` / `Object.seal(x)` is SHALLOW: a primitive array/object becomes
  // immutable (safe), but a Map/Set/typed-array inside stays mutable (`.set()` still works).
  // Detect it before the generic method-chain peel (which would reduce it to `Object`).
  const frozenArg = objectFreezeArg(node);
  if (frozenArg) return shallowFreezeLeavesMutable(frozenArg) ? { kind: 'frozen' } : null;
  // Unwrap assertions / non-null / method-call chains FIRST, so an outer wrapper on a
  // conditional/logical (`(cond ? [1] : [2]) as number[]`, `(a || [1]).slice()`) still
  // reaches the branch recursion below rather than falling through as non-mutable.
  const base = unwrapToBase(node);
  if (!base) return null;
  if (base.type === AST_NODE_TYPES.ConditionalExpression) {
    return findMutable(base.consequent) || findMutable(base.alternate);
  }
  if (base.type === AST_NODE_TYPES.LogicalExpression) {
    return findMutable(base.left) || findMutable(base.right);
  }
  if (base.type === AST_NODE_TYPES.ArrayExpression)
    return isExemptAsConstArray(node) ? null : { kind: 'array' };
  // A plain boolean, not a type guard (it is false for `new RegExp()` too), so narrow
  // on the node type here before handing `base` to collectionCtorName.
  if (base.type === AST_NODE_TYPES.NewExpression && isCollectionConstructor(base)) {
    return { kind: 'collection', ctor: collectionCtorName(base) };
  }
  return null;
}

/** True when an expression value yields a mutable array/collection (used by destructuring). */
function isMutableCollectionValue(node: TSESTree.Node | null | undefined): boolean {
  return findMutable(node) !== null;
}

/**
 * True when a destructuring pattern binds a mutable array/collection element of an
 * array/object literal initializer into a persistent local — e.g. `const [buf] =
 * [new Int32Array(8)]` or `const { m } = { m: new Map() }`. Matches by array index /
 * object-property name; rest/computed/nested patterns and non-literal RHS are not traced
 * (documented gaps). `const [a, b] = [1, 2]` (primitives) is correctly not matched.
 */
function destructuringBindsMutable(
  pattern: TSESTree.ArrayPattern | TSESTree.ObjectPattern,
  init: TSESTree.Expression,
): boolean {
  if (pattern.type === AST_NODE_TYPES.ArrayPattern) {
    // An array rest element collects into a FRESH mutable Array — always persistent
    // mutable state, regardless of RHS shape (`const [...r] = xs`, `const [a, ...r] = …`).
    if (pattern.elements.some((el) => el && el.type === AST_NODE_TYPES.RestElement)) return true;
    // A default (`[buf = new Int32Array()]`) can materialize the mutable value itself,
    // independent of the RHS — check it regardless of RHS shape.
    for (const el of pattern.elements) {
      if (el && el.type === AST_NODE_TYPES.AssignmentPattern && isMutableCollectionValue(el.right))
        return true;
    }
    const base = unwrapToBase(init);
    if (base && base.type === AST_NODE_TYPES.ArrayExpression) {
      for (let i = 0; i < pattern.elements.length; i++) {
        if (!pattern.elements[i]) continue; // hole
        const rel = base.elements[i];
        if (rel && rel.type !== AST_NODE_TYPES.SpreadElement && isMutableCollectionValue(rel))
          return true;
      }
    }
    return false;
  }
  if (pattern.type === AST_NODE_TYPES.ObjectPattern) {
    // Defaults (`{ m = new Map() }`) materialize a value independent of the RHS.
    for (const pprop of pattern.properties) {
      if (
        pprop.type === AST_NODE_TYPES.Property &&
        pprop.value &&
        pprop.value.type === AST_NODE_TYPES.AssignmentPattern &&
        isMutableCollectionValue(pprop.value.right)
      ) {
        return true;
      }
    }
    const base = unwrapToBase(init);
    if (base && base.type === AST_NODE_TYPES.ObjectExpression) {
      for (const pprop of pattern.properties) {
        // Object rest (`{ ...r }`) binds a plain object — covered by the object gap, not here.
        if (pprop.type !== AST_NODE_TYPES.Property) continue;
        const key = objKeyName(pprop);
        if (key == null) continue; // unresolvable computed key — documented gap
        const rprop = base.properties.find(
          (p): p is TSESTree.Property =>
            p.type === AST_NODE_TYPES.Property && objKeyName(p) === key,
        );
        if (rprop && isMutableCollectionValue(rprop.value)) return true;
      }
    }
    return false;
  }
  return false;
}

/** Resolve a property's static key (Identifier or string/number literal, incl. computed); null if dynamic. */
function objKeyName(prop: TSESTree.Property): string | null {
  if (prop.type !== AST_NODE_TYPES.Property || !prop.key) return null;
  if (!prop.computed && prop.key.type === AST_NODE_TYPES.Identifier) return prop.key.name;
  if (
    prop.key.type === AST_NODE_TYPES.Literal &&
    (typeof prop.key.value === 'string' || typeof prop.key.value === 'number')
  ) {
    return String(prop.key.value);
  }
  return null;
}

/**
 * True when the declaration is a PERSISTENT module/namespace binding — direct child of a
 * `Program` or `TSModuleBlock` body (plain or `export`ed). Block/loop/function-nested
 * declarations are scoped to one-time execution and return false.
 */
function isModuleScope(declaration: TSESTree.VariableDeclaration): boolean {
  let parent: TSESTree.Node = declaration.parent;
  if (parent && parent.type === AST_NODE_TYPES.ExportNamedDeclaration) parent = parent.parent;
  return (
    Boolean(parent) &&
    (parent.type === AST_NODE_TYPES.Program || parent.type === AST_NODE_TYPES.TSModuleBlock)
  );
}

/** The five violation kinds this rule reports. */
type SimModuleStateMessageId =
  | 'mutableLet'
  | 'mutableArray'
  | 'mutableCollection'
  | 'mutableDestructure'
  | 'mutableFrozen';

const rule: Rule.RuleModule = {
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
      mutableFrozen:
        '`Object.freeze(...)` is shallow — a `Map`/`Set`/typed-array inside it stays mutable in src/sim (`.set()`/`.add()` still work). Add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why>`, or freeze a structure that holds no live collection.',
    } satisfies Record<SimModuleStateMessageId, string>,
  },
  create(context) {
    /** Report a TSESTree node against this rule's context — ESLint core's `context.report`
     *  wants a `Rule.Node` (estree-shaped); the parser is @typescript-eslint/parser, so
     *  every node it hands us at runtime IS a TSESTree node underneath. */
    function report(
      node: TSESTree.Node,
      messageId: SimModuleStateMessageId,
      data?: Record<string, string>,
    ): void {
      context.report({ node: node as unknown as Rule.Node, messageId, data });
    }

    return {
      VariableDeclaration(estreeNode) {
        // The configured parser is @typescript-eslint/parser, so the runtime node IS a
        // TSESTree node — ESLint core's types simply don't model TS syntax (e.g. `declare`).
        const node = estreeNode as unknown as TSESTree.VariableDeclaration;
        if (node.declare) return; // ambient `declare const/let` — no runtime state
        if (!isModuleScope(node)) return;

        for (const decl of node.declarations) {
          // Destructuring: the RHS literal isn't retained as one binding, but an element
          // bound into a local can be a live collection (`const [buf] = [new Int32Array()]`).
          // Inspect the matched element/property rather than skipping wholesale.
          if (
            decl.id.type === AST_NODE_TYPES.ArrayPattern ||
            decl.id.type === AST_NODE_TYPES.ObjectPattern
          ) {
            if (node.kind === 'let' || node.kind === 'var') {
              // Destructured `let`/`var` bindings are reassignable module state too.
              report(decl, 'mutableLet');
            } else if (decl.init && destructuringBindsMutable(decl.id, decl.init)) {
              report(decl, 'mutableDestructure');
            }
            continue;
          }

          if (node.kind === 'let' || node.kind === 'var') {
            // `var` is reassignable module state too (and hoisted) — treat it like `let`.
            report(decl, 'mutableLet');
            continue;
          }
          if (node.kind !== 'const') continue; // ignore `using` / `await using`
          if (!decl.init) continue;

          // Classify the initializer (peeling assertions/non-null/method chains, and
          // recursing through conditional/logical branches) as a mutable array/collection.
          const found = findMutable(decl.init);
          if (found && found.kind === 'array') {
            report(decl, 'mutableArray');
          } else if (found && found.kind === 'collection') {
            report(decl, 'mutableCollection', { ctor: found.ctor });
          } else if (found && found.kind === 'frozen') {
            report(decl, 'mutableFrozen');
          }
        }
      },
      ExportDefaultDeclaration(estreeNode) {
        // Same boundary cast as above: the parser guarantees a TSESTree node at runtime.
        const node = estreeNode as unknown as TSESTree.ExportDefaultDeclaration;
        // `export default new Map()` / `[1, 2]` caches a mutable module-level singleton.
        const found = findMutable(node.declaration);
        if (found && found.kind === 'array') {
          report(node, 'mutableArray');
        } else if (found && found.kind === 'collection') {
          report(node, 'mutableCollection', { ctor: found.ctor });
        } else if (found && found.kind === 'frozen') {
          report(node, 'mutableFrozen');
        }
      },
    };
  },
};

export default rule;
