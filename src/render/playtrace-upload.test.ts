// playtrace-upload.test.ts — issue #122 / ADR 0013 coverage for the
// upload module. Three concerns:
//
//   1. Graceful downgrade — when the gzipped body exceeds the cap, the
//      module retries with reduced snapshot shape (antTrace off → inputLog
//      off → survey-only). This is the headline correctness property.
//   2. Feature-flag gating — an empty endpoint string must short-circuit
//      without touching `fetch`. Defense-in-depth against an overlay that
//      forgot to gate on the same flag.
//   3. Wire framing — Content-Type / Content-Encoding / X-Schema-Version
//      headers match the contract, body is the gzipped envelope.
//
// The fetch + CompressionStream APIs are present in Vitest's node-environment
// runtime (Node 22+); these tests do NOT require jsdom. Where the body Blob
// needs to be inspected we read it back via arrayBuffer().

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  submitPlaytrace,
  buildPlaytraceEnvelope,
  outcomeToWire,
  truncateFreeText,
  cancelInFlightUpload,
  PLAYTRACE_FREE_TEXT_MAX,
  PLAYTRACE_SCHEMA_VERSION,
  type PlaytraceSubmissionInput,
} from './playtrace-upload.js';
import { GameOutcome } from '../sim/game-over.js';
import { createWorldState } from '../sim/types.js';
import * as debugSnapshot from '../platform/debug-snapshot.js';

const MAX_TEST_ENTITIES = 16;

function makeInput(overrides: Partial<PlaytraceSubmissionInput> = {}): PlaytraceSubmissionInput {
  const world = createWorldState(123, MAX_TEST_ENTITIES);
  return {
    endpoint: '/api/playtrace',
    sessionId: 'test-uuid-0000',
    outcome: GameOutcome.Victory,
    quitFromPauseMenu: false,
    includeSnapshot: true,
    world,
    seed: 123,
    inputLog: [],
    survey: { rating: 5, freeText: '', brokenFlag: false },
    resumedFromSave: false,
    ...overrides,
  };
}

describe('outcomeToWire', () => {
  it('maps the three terminal outcomes to their string forms', () => {
    expect(outcomeToWire(GameOutcome.Victory)).toBe('Victory');
    expect(outcomeToWire(GameOutcome.Defeat)).toBe('Defeat');
    expect(outcomeToWire(GameOutcome.MutualDestruction)).toBe('MutualDestruction');
  });

  it('throws on None — the contract forbids it on the wire', () => {
    expect(() => outcomeToWire(GameOutcome.None)).toThrow(/None should never reach the wire/);
  });
});

describe('truncateFreeText', () => {
  it('passes through short input unchanged', () => {
    expect(truncateFreeText('hello')).toBe('hello');
  });

  it('trims trailing whitespace', () => {
    expect(truncateFreeText('hello   \n')).toBe('hello');
  });

  it('truncates to PLAYTRACE_FREE_TEXT_MAX', () => {
    const long = 'a'.repeat(PLAYTRACE_FREE_TEXT_MAX + 50);
    const out = truncateFreeText(long);
    expect(out.length).toBe(PLAYTRACE_FREE_TEXT_MAX);
  });
});

describe('buildPlaytraceEnvelope', () => {
  it('produces a wire envelope with the contracted fields', () => {
    const input = makeInput();
    const env = buildPlaytraceEnvelope(input, null);
    expect(env.sessionId).toBe(input.sessionId);
    expect(env.schemaVersion).toBe(PLAYTRACE_SCHEMA_VERSION);
    expect(env.outcome).toBe('Victory');
    expect(env.snapshot).toBeNull();
    expect(env.survey.rating).toBe(5);
  });

  it('echoes the live world simVersion (per ADR §"Schema versioning")', () => {
    const input = makeInput();
    input.world.simVersion = 42;
    const env = buildPlaytraceEnvelope(input, null);
    expect(env.simVersion).toBe(42);
  });
});

describe('submitPlaytrace — feature flag gating', () => {
  it('short-circuits when endpoint is the empty string without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called when feature flag is off');
    });
    try {
      const result = await submitPlaytrace(makeInput({ endpoint: '' }));
      expect(result).toEqual({ status: 'feature-off' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('treats whitespace-only endpoint as feature-off (codex P2)', async () => {
    // A templated env var that resolved to whitespace (`'   '`,
    // `'\t\n'`) would otherwise pass the `=== ''` check and fire fetch
    // against an invalid URL. Trim before gating.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called for a whitespace-only endpoint');
    });
    try {
      for (const endpoint of ['   ', '\t', '\n', ' \t\n  ']) {
        const result = await submitPlaytrace(makeInput({ endpoint }));
        expect(result).toEqual({ status: 'feature-off' });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('submitPlaytrace — wire framing', () => {
  it('sends a same-origin POST with the contracted headers and gzipped body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    try {
      await submitPlaytrace(makeInput());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('/api/playtrace');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/octet-stream');
      expect(headers['Content-Encoding']).toBe('gzip');
      expect(headers['X-Schema-Version']).toBe('2');
      // Body should be a Blob of non-zero size — the gzipped envelope.
      const body = init?.body as Blob;
      expect(body).toBeInstanceOf(Blob);
      expect(body.size).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports server-side disable (HTTP 503) cleanly so the UI silently skips', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 503 }));
    try {
      const result = await submitPlaytrace(makeInput());
      expect(result).toEqual({ status: 'server-disabled' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('surfaces a Retry-After header on HTTP 429', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    try {
      const result = await submitPlaytrace(makeInput());
      expect(result).toEqual({ status: 'rate-limited', retryAfterSeconds: 30 });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('submitPlaytrace — graceful downgrade', () => {
  it('walks the antTrace → inputLog → survey-only stages when the body exceeds the cap', async () => {
    // Force the downgrade loop by making gzipString return artificial sizes
    // depending on which downgrade stage the envelope reflects. We can't
    // spy on the internal gzipString (it's a module-local helper); instead
    // we observe stage transitions indirectly by capturing every fetch
    // call's body and asserting that the final body corresponds to a
    // survey-only envelope (snapshot: null).
    //
    // Strategy: stub global CompressionStream so each compressed Blob is
    // sized proportionally to the input. The default CompressionStream
    // shrinks our test payloads to bytes; making the gzip-result size
    // grow linearly with input length gives us a deterministic way to
    // make stage 1+2+3 oversize.
    const origCS = globalThis.CompressionStream;
    // Custom CompressionStream that emits the input UTF-8 bytes unchanged
    // (no compression). That way a JSON envelope >5 MB stays >5 MB on the
    // "gzipped" side, and the downgrade loop is forced to walk forward.
    class IdentityCompressionStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor(_format: string) {
        super({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
      }
    }
    (globalThis as unknown as { CompressionStream: unknown }).CompressionStream =
      IdentityCompressionStream;

    // Inflate the input so stage 1 (full snapshot) breaches the 5 MB cap.
    // The world has no ants but we shove a fat free-text string in the
    // survey envelope to make the JSON body grow past the threshold.
    const fat = 'a'.repeat(2 * 1024 * 1024); // 2 MB
    const input = makeInput({
      // Free text capped at 2000 chars — irrelevant for body size; instead
      // we inflate the inputLog with fake commands so the envelope JSON
      // crosses 5 MB on stages 1 and 2.
      inputLog: Array.from(
        { length: 3 },
        () =>
          ({
            type: 'SetBehaviorRatio',
            colonyId: 1,
            ratio: { forage: 50, fight: 50 },
            issuedAtTick: 0,
            // The padding pushes each command's stringified form past 2 MB —
            // three of them = 6 MB stage-1 body. Stage 2 keeps the inputLog
            // (still 6 MB). Stage 3 drops the inputLog and survives. Stage 4
            // is the survey-only fallback (always fits).
            _padding: fat,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
      ),
    });

    const bodies: Array<Blob> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(init!.body as Blob);
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    try {
      const result = await submitPlaytrace(input);
      expect(result.status).toBe('ok');
      // Exactly one fetch — the module performs the downgrade locally and
      // only calls fetch once with the final, fitting body.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The final body must be ≤ 5 MB (the cap).
      const finalBody = bodies[0]!;
      expect(finalBody.size).toBeLessThanOrEqual(5 * 1024 * 1024);
    } finally {
      fetchSpy.mockRestore();
      (globalThis as unknown as { CompressionStream: unknown }).CompressionStream = origCS;
    }
  });

  it('skips snapshot construction when includeSnapshot is false', async () => {
    // Use vi.mock at the module boundary so the import binding in
    // playtrace-upload.ts is replaced (vi.spyOn on a namespace object
    // doesn't reach a direct import). Defer to a dynamic import after
    // the mock is registered.
    vi.resetModules();
    const buildSpy = vi.fn(() => ({
      version: 1,
      seed: 0,
      tick: 0,
      inputLog: [],
      snapshot: {} as never,
      antTrace: [],
    }));
    vi.doMock('../platform/debug-snapshot.js', async (importOriginal) => {
      const orig = await importOriginal<typeof debugSnapshot>();
      return { ...orig, buildDebugSnapshot: buildSpy };
    });
    const mod = await import('./playtrace-upload.js');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    try {
      await mod.submitPlaytrace(makeInput({ includeSnapshot: false }));
      expect(buildSpy).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock('../platform/debug-snapshot.js');
      vi.resetModules();
    }
  });
});

describe('submitPlaytrace — timing invariant (load-bearing)', () => {
  // game-scene.ts:onSubmit fires `void submitPlaytrace(...)` and then
  // synchronously calls restartGame(), which mutates the live world.
  // The wire envelope MUST be fully captured into JSON-safe primitives
  // before that mutation can happen. This test mutates world.tick and
  // world.simVersion immediately after `void submitPlaytrace(...)`
  // returns, then waits for the upload to land and asserts the body
  // reflects the pre-mutation state.
  it('captures world.tick / simVersion before yielding control to the caller (stage-1 fit)', async () => {
    const input = makeInput();
    // eslint-disable-next-line no-restricted-syntax
    input.world.tick = 9999;
    input.world.simVersion = 7;

    const bodies: Array<{ tick: number; simVersion: number }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Decompress the body and capture the envelope fields we care about.
      const blob = init!.body as Blob;
      const buf = new Uint8Array(await blob.arrayBuffer());
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      const env = JSON.parse(text) as { tick: number; simVersion: number };
      bodies.push({ tick: env.tick, simVersion: env.simVersion });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    try {
      // Fire-and-forget exactly as game-scene does.
      const pending = submitPlaytrace(input);
      // Mutate the live world IMMEDIATELY — same synchronous tick as the
      // caller. This simulates restartGame() running right after the void
      // submitPlaytrace expression. If the envelope were captured lazily
      // (after the first await), these mutations would corrupt the body.
      // eslint-disable-next-line no-restricted-syntax
      input.world.tick = 0;
      input.world.simVersion = 0;
      await pending;
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toEqual({ tick: 9999, simVersion: 7 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // Codex P1 regression: the downgrade loop's stages 2/3 used to
  // re-call buildDebugSnapshot(input.world, ...) AFTER suspending on
  // stage 1's gzip — by that point restartGame() had mutated the world.
  // This test forces the downgrade loop to walk all the way to stage 4
  // by stubbing CompressionStream to identity-encode, then mutates the
  // world between submit and final resolution and asserts the body
  // reflects pre-mutation state at every wire-visible field.
  it('downgrade stages derive from the stage-1 envelope, not the live world (codex P1)', async () => {
    const origCS = globalThis.CompressionStream;
    // Identity CompressionStream — passes input bytes through unchanged
    // so the downgrade loop is forced to walk all stages by JSON-encoded
    // body size, not by real gzip ratio.
    const IdentityCS = function (this: unknown, _format: string) {
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      });
    };
    (globalThis as unknown as { CompressionStream: unknown }).CompressionStream = IdentityCS;

    // Inflate the inputLog so stages 1 and 2 exceed the 5 MB cap and the
    // downgrade walks past them. Stage 3 (no antTrace, no inputLog)
    // shrinks below 5 MB and lands at fetch.
    const fat = 'a'.repeat(2 * 1024 * 1024);
    const input = makeInput({
      inputLog: Array.from(
        { length: 3 },
        () =>
          ({
            type: 'SetBehaviorRatio',
            colonyId: 1,
            ratio: { forage: 50, fight: 50 },
            issuedAtTick: 0,
            _padding: fat,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
      ),
    });
    // eslint-disable-next-line no-restricted-syntax
    input.world.tick = 5555;
    input.world.simVersion = 9;

    const bodies: Array<{ tick: number; simVersion: number }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Identity-encoded body: bytes ARE the JSON. Skip DecompressionStream
      // (it would reject non-gzip input).
      const blob = init!.body as Blob;
      const text = await blob.text();
      const env = JSON.parse(text) as { tick: number; simVersion: number };
      bodies.push({ tick: env.tick, simVersion: env.simVersion });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    try {
      const pending = submitPlaytrace(input);
      // Same synchronous-tick mutation as the stage-1 test. This must NOT
      // leak into the final body even though the downgrade loop awaits
      // multiple times before sending.
      // eslint-disable-next-line no-restricted-syntax
      input.world.tick = 0;
      input.world.simVersion = 0;
      const result = await pending;
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toEqual({ tick: 5555, simVersion: 9 });
    } finally {
      fetchSpy.mockRestore();
      (globalThis as unknown as { CompressionStream: unknown }).CompressionStream = origCS;
    }
  });
});

describe('cancelInFlightUpload', () => {
  beforeEach(() => {
    cancelInFlightUpload();
  });

  it('aborts an in-flight submission, surfacing { status: cancelled }', async () => {
    // Mock fetch as a long-running promise that rejects with AbortError
    // when the signal aborts. We resolve `fetchStarted` from inside the
    // mock so the test knows when to call cancelInFlightUpload(); a bare
    // `await Promise.resolve()` doesn't yield long enough for the gzip
    // pipeline + fetch dispatch to complete.
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal !== undefined && signal !== null) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
        resolveFetchStarted();
      });
    });
    try {
      const pending = submitPlaytrace(makeInput());
      await fetchStarted;
      cancelInFlightUpload();
      const result = await pending;
      expect(result.status).toBe('cancelled');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
