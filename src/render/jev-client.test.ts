// jev-client.test.ts — the browser half of the proxy contract. No real network:
// `fetchImpl` is injected.

import { describe, it, expect, vi } from 'vitest';
import {
  JEV_DEFAULT_TIMEOUT_MS,
  JevRequestError,
  assertRequestValid,
  createJevClient,
} from './jev-client.js';
import { JEV_MAX_QUESTIONS, JEV_MAX_STATE_BYTES, type JevQuestionMap } from './jev-encode.js';

const QUESTIONS: JevQuestionMap = {
  ratio: {
    type: 'choice',
    instructions: 'pick a split',
    criteria: { economy: 'forage more', military: 'fight more' },
  },
  spider_priority: {
    type: 'noul',
    instructions: 'hunt the spider?',
    criteria: { true: 'yes', false: 'no' },
  },
};

const STATE = { game_phase: 'early', our_colony: { workers: 'small' } };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const OK_BODY = {
  answers: {
    ratio: {
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

describe('createJevClient — happy path', () => {
  it('POSTs { state, questions } as JSON to the endpoint and returns the decoded answers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
    const res = await client.ask(STATE, QUESTIONS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/jev');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ state: STATE, questions: QUESTIONS });

    expect(res.answers).toEqual(OK_BODY.answers);
    expect(res.usage).toEqual(OK_BODY.usage);
    expect(res.model).toBe('jev-latest');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('tolerates a 200 with no usage / model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ answers: {} }));
    const res = await createJevClient({ endpoint: '/api/jev', fetchImpl }).ask(STATE, QUESTIONS);
    expect(res.usage).toBeNull();
    expect(res.model).toBeNull();
    expect(res.answers).toEqual({});
  });

  it('exposes an 8s default deadline', () => {
    expect(JEV_DEFAULT_TIMEOUT_MS).toBe(8000);
  });

  it('uses the global fetch when no fetchImpl is injected', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await createJevClient({ endpoint: '/api/jev' }).ask(STATE, QUESTIONS);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.model).toBe('jev-latest');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('createJevClient — failures (every one is a failed beat)', () => {
  const cases: { status: number; label: string }[] = [
    { status: 400, label: 'bad request' },
    { status: 500, label: 'misconfigured' },
    { status: 502, label: 'upstream error' },
    { status: 503, label: 'upstream unavailable' },
  ];
  for (const { status, label } of cases) {
    it(`throws JevRequestError on ${status} (${label})`, async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: label }, status));
      const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
      await expect(client.ask(STATE, QUESTIONS)).rejects.toMatchObject({
        name: 'JevRequestError',
        status,
      });
    });
  }

  it('surfaces Retry-After from a 503', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503, { 'Retry-After': '30' }));
    const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
    await expect(client.ask(STATE, QUESTIONS)).rejects.toMatchObject({
      status: 503,
      retryAfter: '30',
    });
  });

  it('wraps a network/timeout rejection with status null', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError'));
    const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
    await expect(client.ask(STATE, QUESTIONS)).rejects.toMatchObject({ status: null });
  });

  it('throws on a 200 with a non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
    await expect(client.ask(STATE, QUESTIONS)).rejects.toThrow(/non-JSON/);
  });

  it('throws on a 200 whose body has no answers object', async () => {
    for (const body of [{}, { answers: null }, { answers: [] }, { answers: 'nope' }]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
      const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
      await expect(client.ask(STATE, QUESTIONS)).rejects.toThrow(/no answers object/);
    }
  });

  it('refuses to send when no endpoint is configured', async () => {
    const fetchImpl = vi.fn();
    const client = createJevClient({ endpoint: '', fetchImpl });
    await expect(client.ask(STATE, QUESTIONS)).rejects.toThrow(/no endpoint/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('assertRequestValid — fail fast, never pay for a guaranteed 400', () => {
  it('accepts a well-formed request', () => {
    expect(() => assertRequestValid(STATE, QUESTIONS)).not.toThrow();
  });

  it('rejects an empty question set', () => {
    expect(() => assertRequestValid(STATE, {})).toThrow(/no questions/);
  });

  it(`rejects more than ${JEV_MAX_QUESTIONS} questions`, () => {
    const many: Record<string, JevQuestionMap[string]> = {};
    for (let i = 0; i <= JEV_MAX_QUESTIONS; i++) {
      many[`q_${String.fromCharCode(97 + i)}`] = QUESTIONS.ratio!;
    }
    expect(() => assertRequestValid(STATE, many)).toThrow(/exceeds/);
  });

  it('rejects an id or option key that breaks the proxy pattern', () => {
    expect(() => assertRequestValid(STATE, { Ratio: QUESTIONS.ratio! })).toThrow(/question id/);
    expect(() =>
      assertRequestValid(STATE, {
        ratio: { type: 'choice', instructions: 'x', criteria: { 'not-ok': 'nope' } },
      }),
    ).toThrow(/option key/);
  });

  it('rejects a state over the 16 KB cap', () => {
    const huge = { blob: 'x'.repeat(JEV_MAX_STATE_BYTES + 1) };
    expect(() => assertRequestValid(huge, QUESTIONS)).toThrow(/over the/);
  });

  it('is enforced by ask() before any fetch happens', async () => {
    const fetchImpl = vi.fn();
    const client = createJevClient({ endpoint: '/api/jev', fetchImpl });
    await expect(
      client.ask({ blob: 'x'.repeat(JEV_MAX_STATE_BYTES + 1) }, QUESTIONS),
    ).rejects.toThrow(JevRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
