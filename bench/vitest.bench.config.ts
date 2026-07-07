// bench/vitest.bench.config.ts — separate Vitest config for wall-clock benchmarks
//
// Invocation: cd code && npx vitest run --config bench/vitest.bench.config.ts
//
// This config exists because the main vitest.config.ts restricts include to
// src/**/*.test.ts (unit tests only, no performance.now). Bench files live
// outside src/sim/ specifically to escape the simSafetyConfig ESLint glob that
// bans performance, Date, and setTimeout.
//
// NOT run by default via npm run verify — benchmarks are a separate invocation.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bench/**/*.bench.ts'],
    environment: 'node',
    // #235 — let tick-cost.bench.ts's console.log ticks/sec lines reach stdout
    // (Vitest intercepts console by default). The pheromone bench uses expect(),
    // so this only affects console-printing benches.
    disableConsoleIntercept: true,
  },
});
