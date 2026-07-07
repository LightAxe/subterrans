// scripts/cross-engine-hash.ts
// #229 — Node side of the cross-engine byte-identity proof. Prints ONE line:
//   "<seed> <ticks> <hash>"
// The Playwright spec (tests/cross-engine-determinism.spec.ts) parses this,
// relays the SAME (seed, ticks) to the browser harness, and compares hashes.
//
// Run: node --experimental-strip-types scripts/cross-engine-hash.ts
//
// Mirrors run-sim.ts's .js->.ts resolve hook — Node's --experimental-strip-types
// does not remap the TypeScript .js-import convention, so we register a hook
// before the dynamic import. Do NOT edit run-sim.ts (fixed FNDN-08 proof).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

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

// Dynamic import runs after hook registration — the .js paths inside run-canned resolve correctly.
const { runCannedHash, CE_SEED, CE_TICKS } = await import('../tests/cross-engine/run-canned.ts');
console.log(`${CE_SEED} ${CE_TICKS} ${runCannedHash(CE_SEED, CE_TICKS)}`);
