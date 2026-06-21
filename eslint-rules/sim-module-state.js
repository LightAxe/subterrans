// code/eslint-rules/sim-module-state.js
// Custom ESLint rule: subterrans/sim-module-state  (issue #211)
//
// Flags MODULE-LEVEL mutable state in src/sim/ so it cannot land silently — the
// determinism footgun before lockstep multiplayer. A module-scope mutable buffer
// that isn't reset per tick diverges peers under lockstep and breaks save/replay,
// and is invisible in single-player. This rule forces a reviewable acknowledgement
// at the declaration site (see code/AGENTS.md → Review guidelines → Determinism).
//
// WHAT IT FLAGS (module scope only — `Program` or `export` directly under `Program`):
//   - any `let` binding (reassignable — incl. scalars: the worst cross-tick footgun);
//   - any `const` whose initializer, AFTER unwrapping type assertions / `satisfies`,
//     is an array literal, or `new <collection>()` for a known mutable-collection ctor.
//
// ESCAPES (each makes intent explicit):
//   - immutable lookup array  → wrap as `[...] as const` (the ONLY exemption, and only
//     when `as const` is the OUTERMOST and sole assertion directly on the array literal;
//     `as number[]`, `satisfies`, a `readonly`/`ReadonlyArray<>` annotation, and chained
//     forms like `[...] as const as number[]` / `[...] as unknown as const` do NOT exempt —
//     they leave the runtime array mutable);
//   - genuine scratch/cache/memo → `// eslint-disable-next-line subterrans/sim-module-state
//     -- sim-scratch: reset-per-tick` (or sim-cache:/sim-memo: <why it is safe>).
//
// DELIBERATE GAPS (NOT caught — syntactic rule, covered by the review checklist):
//   - factory `CallExpression` returns (`const X = makeBuffer()`), and plain mutable
//     objects (`const X = {}`). Those carry a plain `// sim-scratch:` marker comment.
//   - `new RegExp()` / `new Error()` / custom classes — not mutable-collection shapes.
//   - qualified collection ctors (`new globalThis.Array()`) — MemberExpression callee,
//     not matched; bare `new Array()`/`new Map()`/… are.
//   - declarations inside a TS `namespace`/`module` block (parent `TSModuleBlock`) —
//     `src/sim` is namespace-free by convention (ES modules), so this is a non-goal.

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

/** True for `expr as const` / `<const>expr` — the only shape that exempts an array. */
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

/** Strip every `as X` / `<X>` / `satisfies X` wrapper to reach the wrapped expression. */
function unwrapAssertions(node) {
  let cur = node;
  while (
    cur &&
    (cur.type === 'TSAsExpression' ||
      cur.type === 'TSSatisfiesExpression' ||
      cur.type === 'TSTypeAssertion')
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** True when the VariableDeclaration sits at module scope (plain or exported). */
function isModuleScope(declaration) {
  const parent = declaration.parent;
  if (!parent) return false;
  if (parent.type === 'Program') return true;
  return (
    parent.type === 'ExportNamedDeclaration' && parent.parent && parent.parent.type === 'Program'
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Module-level mutable state in src/sim must be `as const` (immutable arrays) or carry an eslint-disable with a sim-scratch/sim-cache/sim-memo reason (determinism invariant, issue #211).',
    },
    schema: [],
    messages: {
      mutableLet:
        'Module-level `let` in src/sim is reassignable cross-tick state. If immutable, use `const … as const`; otherwise add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why it is reset/safe>`.',
      mutableArray:
        'Module-level mutable array literal in src/sim. If it is an immutable lookup, wrap it as `[...] as const`; otherwise add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why>`. (A `readonly`/`ReadonlyArray<>` annotation, `as number[]`, or a chained `as const` does not make it immutable.)',
      mutableCollection:
        'Module-level mutable `new {{ctor}}()` in src/sim is cross-tick state. Add `// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch:/sim-cache:/sim-memo: <why it is reset/safe>`.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (!isModuleScope(node)) return;

        if (node.kind === 'let') {
          for (const decl of node.declarations) {
            context.report({ node: decl, messageId: 'mutableLet' });
          }
          return;
        }
        if (node.kind !== 'const') return; // ignore `var` / `using`

        for (const decl of node.declarations) {
          if (!decl.init) continue;
          const inner = unwrapAssertions(decl.init);
          if (!inner) continue;

          if (inner.type === 'ArrayExpression') {
            // Exempt ONLY the exact `[...] as const` / `<const>[...]` shape: the const
            // assertion must be the OUTERMOST and sole wrapper directly on the array
            // literal. Chains like `[...] as const as number[]`, `[...] as number[] as
            // const`, and `[...] as unknown as const` leave the runtime array mutable.
            const exemptAsConst =
              isConstAssertion(decl.init) &&
              decl.init.expression &&
              decl.init.expression.type === 'ArrayExpression';
            if (exemptAsConst) continue;
            context.report({ node: decl, messageId: 'mutableArray' });
          } else if (
            inner.type === 'NewExpression' &&
            inner.callee &&
            inner.callee.type === 'Identifier' &&
            COLLECTION_CONSTRUCTORS.has(inner.callee.name)
          ) {
            context.report({
              node: decl,
              messageId: 'mutableCollection',
              data: { ctor: inner.callee.name },
            });
          }
        }
      },
    };
  },
};
