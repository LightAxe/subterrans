import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Read package.json at config-evaluation time so __APP_VERSION__ in the built
// bundle reflects the version on disk when `npm run build` ran. Used by the
// playtrace upload module (issue #122) as the `gameVersion` field on the
// submission envelope — sourced from package.json rather than hand-maintained
// so version bumps flow through to telemetry automatically.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Issue #122 — dev-server mock for the playtrace upload endpoint.
 *
 * In `npm run dev`, attaches a middleware that handles
 * `POST /api/playtrace`: decodes the gzipped JSON body, logs a one-line
 * summary to the dev console (sessionId, outcome, gzipped bytes, rating,
 * brokenFlag, hasSnapshot, free-text preview), and returns the same
 * `{ accepted: true, sessionId: <echo> }` body the production Lambda
 * returns. Lets you exercise the full upload flow end-to-end on localhost
 * without standing up the website's Lambda + S3 stack.
 *
 * Enable with:
 *
 *     # in .env.local
 *     VITE_PLAYTRACE_ENDPOINT=/api/playtrace
 *
 * Then `npm run dev` → play to game-over (or use the pause menu's
 * "Quit & feedback" entry) → fill the survey → Submit. The dev-server
 * terminal logs the decoded envelope summary; failing requests log a
 * stack trace.
 *
 * Production builds NEVER include this middleware: Vite plugins with only
 * `configureServer` hooks are dev-only by construction.
 */
const playtraceMockPlugin = (): Plugin => ({
  name: 'subterrans-playtrace-mock',
  configureServer(server) {
    server.middlewares.use('/api/playtrace', (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
      if (req.method !== 'POST') {
        // Let the dev server's default 404 handle GET/HEAD/etc.
        next();
        return;
      }
      // Sanity cap on the mock's incoming body — dev-only, but a runaway
      // client (or a misconfigured browser-side test) could otherwise OOM
      // the dev server. 10 MB is comfortably above the production 5 MB
      // gzipped cap, so legitimate submissions always fit.
      const MAX_MOCK_BODY = 10 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let received = 0;
      let oversized = false;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_MOCK_BODY) {
          if (!oversized) {
            oversized = true;
            // eslint-disable-next-line no-console
            console.warn(`[playtrace-mock] body exceeded ${MAX_MOCK_BODY} bytes — discarding`);
            res.statusCode = 413;
            res.end('Payload Too Large');
            req.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (oversized) return; // response already sent
        try {
          const raw = Buffer.concat(chunks);
          let envelope: Record<string, unknown> = {};
          let parseError: string | null = null;
          // The wire format is gzip-encoded JSON. Decompress + parse, but
          // tolerate parse failures so the mock surfaces *what* the client
          // sent even when the JSON is malformed — diagnosing a bad
          // serialization is the whole point of having this middleware.
          try {
            const decompressed = gunzipSync(raw);
            envelope = JSON.parse(decompressed.toString('utf8')) as Record<string, unknown>;
          } catch (err) {
            parseError = err instanceof Error ? err.message : String(err);
          }
          const survey = envelope['survey'] as Record<string, unknown> | undefined;
          const freeText = typeof survey?.['freeText'] === 'string' ? survey['freeText'] as string : '';
          const freeTextPreview = freeText.length > 80 ? `${freeText.slice(0, 80)}…` : freeText;
          // One-line summary keeps the dev-server log readable. The full
          // envelope is also logged below for offline inspection.
          // eslint-disable-next-line no-console
          console.log(
            `[playtrace-mock] received: sessionId=${envelope['sessionId'] ?? '?'} `
            + `outcome=${envelope['outcome'] ?? '?'} `
            + `gzippedBytes=${raw.length} `
            + `rating=${survey?.['rating'] ?? '?'} `
            + `brokenFlag=${survey?.['brokenFlag'] ?? '?'} `
            + `hasSnapshot=${envelope['snapshot'] !== null} `
            + `freeText=${JSON.stringify(freeTextPreview)}`
            + (parseError !== null ? ` PARSE_ERROR=${parseError}` : ''),
          );
          // Full envelope dump (without the snapshot payload — the snapshot
          // is large and noisy in the terminal; if you need it, change
          // `null` → the actual snapshot block).
          // eslint-disable-next-line no-console
          console.log('[playtrace-mock] envelope:', JSON.stringify({ ...envelope, snapshot: envelope['snapshot'] === null ? null : '<elided>' }, null, 2));

          res.statusCode = 202;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ accepted: true, sessionId: envelope['sessionId'] ?? null }));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[playtrace-mock] handler error:', err);
          res.statusCode = 500;
          res.end('mock middleware error');
        }
      });
    });
  },
});

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [playtraceMockPlugin()],
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
  },
});
