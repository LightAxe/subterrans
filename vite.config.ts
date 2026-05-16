import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Read package.json at config-evaluation time so __APP_VERSION__ in the built
// bundle reflects the version on disk when `npm run build` ran. Used by the
// playtrace upload module (issue #122) as the `gameVersion` field on the
// submission envelope — sourced from package.json rather than hand-maintained
// so version bumps flow through to telemetry automatically.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
  },
});
