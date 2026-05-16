import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// Mirror the build-time __APP_VERSION__ define from vite.config.ts so the
// playtrace upload module (issue #122) can read it under Vitest the same
// way it will at runtime in production. Same package.json source-of-truth.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/platform/test-setup.ts'],
  },
});
