// vite.lib.config.ts — library-mode build for embedding the game in host pages.
//
// Companion to vite.config.ts. The standalone HTML build (vite.config.ts) emits
// dist/index.html + a hashed JS bundle that auto-mounts via index.html's inline
// script. This config emits a single ESM module exporting { mount, MountOptions,
// MountedGame } with no top-level side effects, so a host page (e.g. an Astro
// page on subterrans.com) can import it and call mount(target) itself.
//
// Phaser is bundled inline (rollupOptions.external = []) so the host doesn't
// need it as its own dependency. Sprite URLs in src/render/game-scene.ts use
// import.meta.env.BASE_URL — invoke this build with --base=/demo/play/ so the
// asset URLs bake in to the website's deploy path.
//
// Output filename is content-hashed (index.[hash].js) so the website can
// publish it under Cache-Control: immutable without invalidation churn.
// A sibling manifest.json maps `entry → filename` so the deploy can inject
// the correct <script src=…> URL into the host page. A sibling index.d.ts
// declares the public API surface (mount/MountOptions/MountedGame) for
// type-only imports in the host project.

import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// Package version — exposed to the bundle as the __APP_VERSION__ define so
// the playtrace upload module (issue #122) can report `gameVersion` on the
// submission envelope. Same source-of-truth as the standalone build's
// vite.config.ts; keeping the two configs in sync is a manual review check.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Emit dist-lib/manifest.json after the bundle is written, so the website
 *  deploy can read `entry` and inject the right hashed <script src=…>.
 *
 *  Asserts exactly one entry chunk — silent skip on multi-entry would
 *  produce a stale or missing manifest, which the website's deploy then
 *  reads and breaks production. Better to fail the build loudly. */
const manifestPlugin = (): Plugin => ({
  name: 'subterrans-lib-manifest',
  writeBundle(options, bundle) {
    const entries = Object.values(bundle).filter(
      (chunk) => 'isEntry' in chunk && chunk.isEntry === true,
    );
    if (entries.length !== 1) {
      throw new Error(
        `subterrans-lib-manifest: expected exactly 1 entry chunk, found ${entries.length}. ` +
        `Library build assumes a single ESM entry — check vite.lib.config.ts lib.entry.`,
      );
    }
    const entry = entries[0];
    const dir = options.dir ?? 'dist-lib';
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ entry: entry.fileName }, null, 2) + '\n',
    );
  },
});

/** Emit dist-lib/index.d.ts by running the TypeScript compiler programmatically
 *  on `src/main.ts`. Generates declarations from the actual source — no
 *  hand-maintained string, no drift risk: any change to MountOptions /
 *  MountedGame / mount in main.ts flows through to the published types on
 *  the next build. JSDoc comments are preserved verbatim by tsc.
 *
 *  We don't use vite-plugin-dts because (a) we already have `typescript`
 *  as a devDep and (b) we want to emit only main.ts's declarations, not
 *  the transitive render-internal modules — `program.emit(sourceFile, …)`
 *  with the writeFile callback constrains output to the single file.
 *
 *  The output filename is fixed (`index.d.ts`, no hash) because TS module
 *  resolution is path-based; consumers reference types via a stable path
 *  that is decoupled from the runtime entry name in manifest.json. */
const dtsPlugin = (): Plugin => ({
  name: 'subterrans-lib-dts',
  writeBundle(options) {
    const dir = options.dir ?? 'dist-lib';
    writeFileSync(join(dir, 'index.d.ts'), generateMainDts());
  },
});

/** Run tsc programmatically on src/main.ts and return the emitted .d.ts
 *  text. Inherits the project's tsconfig (incl. `types: [vite/client]` so
 *  `import.meta.env` resolves) but forces declaration-only emit. */
function generateMainDts(): string {
  const SRC = 'src/main.ts';
  const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) {
    throw new Error('subterrans-lib-dts: tsconfig.json not found in cwd');
  }
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error !== undefined) {
    throw new Error(`subterrans-lib-dts: failed to read tsconfig.json: ${error.messageText}`);
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
  const program = ts.createProgram({
    rootNames: [SRC],
    options: {
      ...parsed.options,
      declaration: true,
      emitDeclarationOnly: true,
      noEmit: false,
      outDir: undefined,
      declarationMap: false,
      sourceMap: false,
    },
  });
  const sourceFile = program.getSourceFile(SRC);
  if (sourceFile === undefined) {
    throw new Error(`subterrans-lib-dts: tsc could not load ${SRC}`);
  }
  // Fail loudly on type errors before emit. `npm run verify` runs
  // `tsc --noEmit` upstream and would catch these too, but a developer
  // running `build:lib` in isolation should not be able to ship a
  // garbage-but-syntactically-valid .d.ts on top of broken types.
  // Restrict to main.ts diagnostics — type errors in transitive modules
  // are out of scope for this build step (they are caught by typecheck).
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    });
    throw new Error(
      `subterrans-lib-dts: TypeScript errors in ${SRC} block .d.ts emit:\n${formatted}`,
    );
  }
  let dts: string | undefined;
  // Pass sourceFile to constrain emit to main.ts only (skip the 50+
  // transitively imported modules). The writeFile callback captures the
  // emitted text in-memory rather than letting tsc write to disk.
  program.emit(sourceFile, (fileName, content) => {
    if (fileName.endsWith('main.d.ts')) dts = content;
  });
  if (dts === undefined) {
    throw new Error('subterrans-lib-dts: tsc emit produced no main.d.ts output');
  }
  return dts;
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Suppress copying public/* into dist-lib/. Sprite assets live in the
  // website's deploy at /demo/play/assets/sprites/* — the library bundle
  // doesn't need to ship duplicates.
  publicDir: false,
  plugins: [manifestPlugin(), dtsPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
    },
    rollupOptions: {
      // Bundle dependencies (Phaser) into the library output. Vite's library
      // mode externalizes package.json dependencies by default — we override
      // so consumers don't need Phaser in their own dependency graph.
      external: [],
      output: {
        // Content-hashed filename for cache-busting. Paired with manifest.json
        // (above) so the website's deploy step knows which file to reference.
        entryFileNames: 'index.[hash].js',
      },
    },
  },
});
