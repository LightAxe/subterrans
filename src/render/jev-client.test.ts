// jev-client.test.ts — the browser half of the v2 proxy contract: a session
// mint, session-bound beats, and the one retry the contract allows. No real
// network — `fetchImpl` is injected and routes on the URL's suffix.

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_SESSION_RENEW_MARGIN_MS,
  JevRequestError,
  assertRequestValid,
  createJevClient,
} from './jev-client.js';
import { JEV_MAX_QUESTIONS, JEV_MAX_STATE_BYTES } from './jev-encode.js';

const BASE = '/api/jev';

/** The shape `encodeBeat()` produces, trimmed to what the client cares about. */
const STATE: Record<string, unknown> = {
  game_phase: 'early',
  our_colony: { workers: 'small' },
  candidates: {
    fight_ratio: { economy: 'forage more', military: 'fight more' },
    dig: { deeper: 'dig down', hold: 'stop digging' },
    spider_priority: 'hunt the spider before anything else',
  },
};

const OK_BODY = {
  answers: {
    fight_ratio: {
      type: 'choice',
      choice: 'military',
      confidence: 0.8,
      probabilities: { military: 0.8 },
    },
    spider_priority: { type: 'noul', noul: 0.2 },
  },
  usage: { input_tokens: 400, output_tokens: 12 },
  model: 'jev-latest',
};

function sessionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-1',
    expiresInSeconds: 600,
    beatBudget: 50,
    minBeatIntervalMs: 250,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * A two-route proxy double. Handlers get the zero-based call index (and, for
 * `/beat`, the parsed request body) and may return a Response or throw to
 * simulate a network failure / timeout.
 */
function fakeProxy(
  opts: {
    session?: (n: number) => Response;
    beat?: (n: number, body: Record<string, unknown>) => Response;
  } = {},
) {
  const sessions: Record<string, unknown>[] = [];
  const beats: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // The signature stays `typeof fetch`-compatible, but the client only ever
    // passes a string URL and a JSON string body.
    const url = input as string;
    urls.push(url);
    if (init !== undefined) inits.push(init);
    const body = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>;
    if (url.endsWith('/session')) {
      sessions.push(body);
      const make = opts.session ?? (() => jsonResponse(sessionBody()));
      return Promise.resolve(make(sessions.length - 1));
    }
    if (url.endsWith('/beat')) {
      beats.push(body);
      const make = opts.beat ?? (() => jsonResponse(OK_BODY));
      return Promise.resolve(make(beats.length - 1, body));
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  return { fetchImpl, sessions, beats, urls, inits };
}

/** Freeze `performance.now()` so session expiry is a test input, not a race. */
function mockClock(): { advance: (ms: number) => void } {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('createJevClient — session mint', () => {
  it('POSTs an empty body to <base>/session and reports what the proxy said', async () => {
    const proxy = fakeProxy();
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    const res = await client.mintSession();

    expect(proxy.urls).toEqual(['/api/jev/session']);
    const init = proxy.inits[0]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(proxy.sessions[0]).toEqual({});

    expect(res.expiresInSeconds).toBe(600);
    expect(res.beatBudget).toBe(50);
    expect(res.minBeatIntervalMs).toBe(250);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports null for every hint a sparse session response leaves out', async () => {
    const proxy = fakeProxy({ session: () => jsonResponse({ token: 'tok-bare' }) });
    const res = await createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl }).mintSession();
    expect(res.expiresInSeconds).toBeNull();
    expect(res.beatBudget).toBeNull();
    expect(res.minBeatIntervalMs).toBeNull();
  });

  it('surfaces a 429 rate_limited with its Retry-After', async () => {
    const proxy = fakeProxy({
      session: () => jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '30' }),
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.mintSession()).rejects.toMatchObject({
      name: 'JevRequestError',
      status: 429,
      retryAfter: '30',
    });
  });

  it('wraps a network / timeout rejection with status null', async () => {
    const proxy = fakeProxy({
      session: () => {
        throw new DOMException('aborted', 'TimeoutError');
      },
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.mintSession()).rejects.toMatchObject({ status: null });
  });

  it('throws when the session response has no usable token', async () => {
    for (const body of [{}, { token: '' }, { token: 7 }, { token: null }]) {
      const proxy = fakeProxy({ session: () => jsonResponse(body) });
      const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
      await expect(client.mintSession()).rejects.toThrow(/no token/);
    }
  });

  it('throws on a non-JSON or non-object session body', async () => {
    const bad = fakeProxy({ session: () => new Response('not json', { status: 200 }) });
    await expect(
      createJevClient({ base: BASE, fetchImpl: bad.fetchImpl }).mintSession(),
    ).rejects.toThrow(/non-JSON/);

    const array = fakeProxy({ session: () => jsonResponse([1, 2]) });
    await expect(
      createJevClient({ base: BASE, fetchImpl: array.fetchImpl }).mintSession(),
    ).rejects.toThrow(/non-object/);
  });

  it('refuses to send anything when no endpoint is configured', async () => {
    const proxy = fakeProxy();
    const client = createJevClient({ base: '', fetchImpl: proxy.fetchImpl });
    await expect(client.mintSession()).rejects.toThrow(/no endpoint/);
    await expect(client.beat(STATE)).rejects.toThrow(/no endpoint/);
    expect(proxy.fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes an 8s default deadline and a 60s renew margin', () => {
    expect(JEV_DEFAULT_TIMEOUT_MS).toBe(8000);
    expect(JEV_SESSION_RENEW_MARGIN_MS).toBe(60_000);
  });
});

describe('createJevClient — beats', () => {
  it('mints lazily, then POSTs { token, state } — and nothing else', async () => {
    const proxy = fakeProxy();
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    const res = await client.beat(STATE);

    expect(proxy.urls).toEqual(['/api/jev/session', '/api/jev/beat']);
    const body = proxy.beats[0]!;
    expect(Object.keys(body).sort()).toEqual(['state', 'token']);
    expect(body.token).toBe('tok-1');
    expect(body.state).toEqual(STATE);
    expect('questions' in body).toBe(false);

    expect(res.answers).toEqual(OK_BODY.answers);
    expect(res.usage).toEqual(OK_BODY.usage);
    expect(res.model).toBe('jev-latest');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('mints once and reuses the session for later beats', async () => {
    const proxy = fakeProxy();
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await client.beat(STATE);
    await client.beat(STATE);
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(1);
    expect(proxy.beats.length).toBe(3);
    expect(client.stats).toEqual({ requests: 4, mints: 1, beats: 3 });
  });

  it('reuses the session the readiness probe already minted', async () => {
    const proxy = fakeProxy();
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await client.mintSession();
    await client.beat(STATE);
    expect(proxy.urls).toEqual(['/api/jev/session', '/api/jev/beat']);
  });

  it('tolerates a 200 with no usage / model', async () => {
    const proxy = fakeProxy({ beat: () => jsonResponse({ answers: {} }) });
    const res = await createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl }).beat(STATE);
    expect(res.usage).toBeNull();
    expect(res.model).toBeNull();
    expect(res.answers).toEqual({});
  });

  it('throws on a 200 whose body has no answers object', async () => {
    for (const body of [{}, { answers: null }, { answers: [] }, { answers: 'nope' }]) {
      const proxy = fakeProxy({ beat: () => jsonResponse(body) });
      const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
      await expect(client.beat(STATE)).rejects.toThrow(/no answers object/);
    }
  });

  it('throws on a 200 with a non-JSON body', async () => {
    const proxy = fakeProxy({ beat: () => new Response('not json', { status: 200 }) });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toThrow(/non-JSON/);
  });

  it('uses the global fetch when no fetchImpl is injected', async () => {
    const proxy = fakeProxy();
    const original = globalThis.fetch;
    globalThis.fetch = proxy.fetchImpl as unknown as typeof fetch;
    try {
      const res = await createJevClient({ base: BASE }).beat(STATE);
      expect(res.model).toBe('jev-latest');
      expect(proxy.urls).toEqual(['/api/jev/session', '/api/jev/beat']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('tolerates a trailing slash on the configured base', async () => {
    const proxy = fakeProxy();
    await createJevClient({ base: '/api/jev/', fetchImpl: proxy.fetchImpl }).beat(STATE);
    expect(proxy.urls).toEqual(['/api/jev/session', '/api/jev/beat']);
  });
});

describe('createJevClient — beat failures (every one is a failed beat)', () => {
  const cases: { status: number; label: string }[] = [
    { status: 400, label: 'bad_request' },
    { status: 500, label: 'misconfigured' },
    { status: 502, label: 'upstream error' },
    { status: 503, label: 'upstream unavailable' },
  ];
  for (const { status, label } of cases) {
    it(`throws JevRequestError on ${status} (${label}) without retrying`, async () => {
      const proxy = fakeProxy({ beat: () => jsonResponse({ error: label }, status) });
      const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
      await expect(client.beat(STATE)).rejects.toMatchObject({
        name: 'JevRequestError',
        status,
      });
      expect(proxy.beats.length).toBe(1);
      expect(proxy.sessions.length).toBe(1);
    });
  }

  it('surfaces Retry-After from a 503', async () => {
    const proxy = fakeProxy({ beat: () => jsonResponse({}, 503, { 'Retry-After': '30' }) });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: 503, retryAfter: '30' });
  });

  it('treats 429 too_fast as a failed beat and does NOT retry it', async () => {
    const proxy = fakeProxy({
      beat: () => jsonResponse({ error: 'too_fast' }, 429, { 'Retry-After': '1' }),
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: 429, retryAfter: '1' });
    // A retry is what would make the pacing worse; the session is still good.
    expect(proxy.beats.length).toBe(1);
    expect(proxy.sessions.length).toBe(1);
  });

  it('wraps a network / timeout rejection with status null and does not retry', async () => {
    const proxy = fakeProxy({
      beat: () => {
        throw new DOMException('aborted', 'TimeoutError');
      },
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: null });
    expect(proxy.beats.length).toBe(1);
  });
});

describe('createJevClient — the one retry the contract allows', () => {
  for (const status of [401, 403] as const) {
    const label = status === 401 ? 'invalid_token' : 'budget_exhausted';
    it(`re-mints once and retries the beat exactly once on ${status} ${label}`, async () => {
      const proxy = fakeProxy({
        session: (n) => jsonResponse(sessionBody({ token: `tok-${n + 1}` })),
        beat: (n) => (n === 0 ? jsonResponse({ error: label }, status) : jsonResponse(OK_BODY)),
      });
      const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
      const res = await client.beat(STATE);

      expect(res.model).toBe('jev-latest');
      expect(proxy.urls).toEqual([
        '/api/jev/session',
        '/api/jev/beat',
        '/api/jev/session',
        '/api/jev/beat',
      ]);
      expect(proxy.sessions.length).toBe(2);
      expect(proxy.beats.length).toBe(2);
      // The retry carries the NEW token and the same state.
      expect(proxy.beats[0]!.token).toBe('tok-1');
      expect(proxy.beats[1]!.token).toBe('tok-2');
      expect(proxy.beats[1]!.state).toEqual(STATE);
      expect(client.stats).toEqual({ requests: 4, mints: 2, beats: 2 });
    });
  }

  it('gives up when the retried beat fails again — one retry, not a loop', async () => {
    const proxy = fakeProxy({ beat: () => jsonResponse({ error: 'invalid_token' }, 401) });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: 401 });
    expect(proxy.sessions.length).toBe(2);
    expect(proxy.beats.length).toBe(2);
  });

  it('is a failed beat when the replacement session cannot be minted', async () => {
    const proxy = fakeProxy({
      session: (n) => (n === 0 ? jsonResponse(sessionBody()) : jsonResponse({}, 503)),
      beat: () => jsonResponse({ error: 'invalid_token' }, 401),
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: 503 });
    expect(proxy.sessions.length).toBe(2);
    expect(proxy.beats.length).toBe(1);
  });

  it('mints fresh on the next beat after a 401 retired the session', async () => {
    const proxy = fakeProxy({
      session: (n) => jsonResponse(sessionBody({ token: `tok-${n + 1}` })),
      beat: (n) =>
        n === 0 ? jsonResponse({ error: 'invalid_token' }, 401) : jsonResponse({}, 503),
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: 503 });
    // The 401 cleared the session; the retry minted tok-2, which survives.
    await expect(client.beat(STATE)).rejects.toMatchObject({ status: 503 });
    expect(proxy.sessions.length).toBe(2);
    expect(proxy.beats.map((b) => b.token)).toEqual(['tok-1', 'tok-2', 'tok-2']);
  });
});

describe('createJevClient — session lifetime', () => {
  it('re-mints once the session is inside the renew margin', async () => {
    const clock = mockClock();
    const proxy = fakeProxy({
      session: () => jsonResponse(sessionBody({ expiresInSeconds: 120 })),
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });

    await client.beat(STATE);
    clock.advance(59_000); // still outside the 60s margin of the 120s session
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(1);

    clock.advance(2_000); // 61s in: within a minute of expiry
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(2);
    expect(proxy.beats.length).toBe(3);
  });

  it('never spends more than half a short session on the renew margin', async () => {
    const clock = mockClock();
    const proxy = fakeProxy({ session: () => jsonResponse(sessionBody({ expiresInSeconds: 10 })) });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });

    // A 10s session is shorter than the 60s margin: without the cap it would
    // re-mint before every single beat.
    await client.beat(STATE);
    clock.advance(4_000);
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(1);

    clock.advance(2_000);
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(2);
  });

  it('keeps using a session the proxy gave no expiry for', async () => {
    const clock = mockClock();
    const proxy = fakeProxy({ session: () => jsonResponse({ token: 'tok-forever' }) });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await client.beat(STATE);
    clock.advance(86_400_000);
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(1);
  });

  it('re-mints when the stated beat budget is spent, without waiting for a 403', async () => {
    const proxy = fakeProxy({
      session: (n) => jsonResponse(sessionBody({ token: `tok-${n + 1}`, beatBudget: 2 })),
    });
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await client.beat(STATE);
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(1);
    await client.beat(STATE);
    expect(proxy.sessions.length).toBe(2);
    expect(proxy.beats.map((b) => b.token)).toEqual(['tok-1', 'tok-1', 'tok-2']);
  });
});

describe('assertRequestValid — fail fast, never pay for a guaranteed 400', () => {
  it('accepts a well-formed state', () => {
    expect(() => assertRequestValid(STATE)).not.toThrow();
  });

  it('rejects a state with no candidates object', () => {
    for (const state of [{}, { candidates: null }, { candidates: [] }, { candidates: 'nope' }]) {
      expect(() => assertRequestValid(state)).toThrow(/no candidates object/);
    }
  });

  it('rejects an empty candidate set', () => {
    expect(() => assertRequestValid({ candidates: {} })).toThrow(/no candidates/);
  });

  it(`rejects more than ${JEV_MAX_QUESTIONS} candidate groups`, () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= JEV_MAX_QUESTIONS; i++) {
      many[`q_${String.fromCharCode(97 + i)}`] = { yes: 'do it' };
    }
    expect(() => assertRequestValid({ candidates: many })).toThrow(/exceeds/);
  });

  it('rejects a group id or option key that breaks the proxy pattern', () => {
    expect(() => assertRequestValid({ candidates: { Dig: { hold: 'stop' } } })).toThrow(
      /candidate group/,
    );
    expect(() => assertRequestValid({ candidates: { dig: { 'not-ok': 'nope' } } })).toThrow(
      /option key/,
    );
  });

  it('rejects a group that is neither descriptive text nor an option map', () => {
    expect(() => assertRequestValid({ candidates: { dig: 7 } })).toThrow(
      /neither text nor options/,
    );
  });

  it('rejects a state over the 16 KB cap', () => {
    const huge = { candidates: { dig: { hold: 'x'.repeat(JEV_MAX_STATE_BYTES + 1) } } };
    expect(() => assertRequestValid(huge)).toThrow(/over the/);
  });

  it('is enforced by beat() before any fetch happens — not even a session mint', async () => {
    const proxy = fakeProxy();
    const client = createJevClient({ base: BASE, fetchImpl: proxy.fetchImpl });
    await expect(
      client.beat({ candidates: { dig: { hold: 'x'.repeat(JEV_MAX_STATE_BYTES + 1) } } }),
    ).rejects.toThrow(JevRequestError);
    expect(proxy.fetchImpl).not.toHaveBeenCalled();
  });
});
