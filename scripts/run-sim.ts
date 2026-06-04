// scripts/run-sim.ts
// Headless 1000-tick Node runner — FNDN-08.
// Proves src/sim/ loads in Node with zero browser shims.
//
// Run: node --experimental-strip-types scripts/run-sim.ts
//
// Implementation note: src/sim/ uses TypeScript ESM convention (.js import paths
// that TypeScript/Vite resolve to .ts sources). Node's --experimental-strip-types
// does not perform this remapping, so this script registers a minimal resolve hook
// before dynamically importing the sim modules. The register() call must precede
// the dynamic imports to intercept resolution — static imports are hoisted and
// cannot be preceded by synchronous code.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Register a resolve hook that remaps .js -> .ts for Node strip-types.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('.js')) {
        const tsSpec = specifier.slice(0, -3) + '.ts';
        try { return await nextResolve(tsSpec, context); } catch (_) {}
      }
      return nextResolve(specifier, context);
    }
  `),
  pathToFileURL('./'),
);

// Dynamic imports run after hook registration — .js paths resolve correctly.
const { createWorldState } = await import('../src/sim/types.js');
const { tick } = await import('../src/sim/tick.js');

const SEED = 12345;
const ITERATIONS = 1000;

const world = createWorldState(SEED);
for (let i = 0; i < ITERATIONS; i++) {
  // Drain the command queue (mirrors the platform accumulator from Plan 05).
  const cmds = world.commandQueue.splice(0);
  tick(world, cmds);
}

console.log(`Done. Final tick: ${world.tick}`);
