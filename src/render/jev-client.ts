// jev-client.ts — browser side of the Jev proxy contract.
//
// The game never talks to TypeSafe directly and carries no SDK: it POSTs
// `{ state, questions }` as JSON to a SAME-ORIGIN proxy (`/api/jev` in
// production, the Vite dev-server proxy locally) which holds the API key and
// forwards to Jev. Everything the browser knows about the upstream model is the
// shape below.
//
// Proxy contract:
//   POST <endpoint>   Content-Type: application/json
//     body { state, questions }   — ≤ 12 questions, ids/keys ^[a-z][a-z0-9_]{0,40}$,
//                                   serialized state ≤ 16 KB
//   200 { answers, usage, model }
//   400 bad request | 502 upstream error | 503 (+ Retry-After) upstream unavailable
//   500 misconfigured
//
// Every non-200, malformed body, network error and timeout throws — the caller
// (jev-enemy-controller.ts) counts any throw as one failed beat and falls back to
// the rule-based AI after three in a row.

import {
  JEV_ID_PATTERN,
  JEV_MAX_QUESTIONS,
  JEV_MAX_STATE_BYTES,
  type JevAnswerMap,
  type JevQuestionMap,
} from './jev-encode.js';

/** Client-side deadline for one beat, in ms. */
export const JEV_DEFAULT_TIMEOUT_MS = 8000;

export interface JevUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

export interface JevAskResult {
  readonly answers: JevAnswerMap;
  readonly usage: JevUsage | null;
  readonly model: string | null;
  /** Wall-clock round trip, measured render-side (never in src/sim/). */
  readonly latencyMs: number;
}

export interface JevClient {
  ask(state: Record<string, unknown>, questions: JevQuestionMap): Promise<JevAskResult>;
}

/** Thrown for any non-200 response; `status` is null for network / timeout failures. */
export class JevRequestError extends Error {
  readonly status: number | null;
  /** The `Retry-After` header when the proxy sent one (503). */
  readonly retryAfter: string | null;
  constructor(message: string, status: number | null, retryAfter: string | null = null) {
    super(message);
    this.name = 'JevRequestError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface JevClientOptions {
  /** Same-origin proxy URL. Empty string is a programming error — the caller gates on it. */
  readonly endpoint: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Fail fast on anything the proxy would 400 on, so a bad beat costs no network. */
export function assertRequestValid(
  state: Record<string, unknown>,
  questions: JevQuestionMap,
): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new JevRequestError('jev: no questions to ask', null);
  if (ids.length > JEV_MAX_QUESTIONS) {
    throw new JevRequestError(
      `jev: ${ids.length} questions exceeds the ${JEV_MAX_QUESTIONS} cap`,
      null,
    );
  }
  for (const id of ids) {
    if (!JEV_ID_PATTERN.test(id))
      throw new JevRequestError(`jev: invalid question id '${id}'`, null);
    const q = questions[id]!;
    for (const key of Object.keys(q.criteria)) {
      if (!JEV_ID_PATTERN.test(key)) {
        throw new JevRequestError(`jev: invalid option key '${key}' on question '${id}'`, null);
      }
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
  if (bytes > JEV_MAX_STATE_BYTES) {
    throw new JevRequestError(
      `jev: state is ${bytes} bytes, over the ${JEV_MAX_STATE_BYTES} cap`,
      null,
    );
  }
}

export function createJevClient(opts: JevClientOptions): JevClient {
  const endpoint = opts.endpoint;
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async ask(state, questions) {
      if (endpoint === '') throw new JevRequestError('jev: no endpoint configured', null);
      assertRequestValid(state, questions);
      const startedAt = performance.now();
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new JevRequestError(`jev: request failed (${detail})`, null);
      }
      if (res.status !== 200) {
        throw new JevRequestError(
          `jev: proxy returned ${res.status}`,
          res.status,
          res.headers.get('Retry-After'),
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new JevRequestError('jev: proxy returned a non-JSON body', res.status);
      }
      const answers = (body as { answers?: unknown } | null)?.answers;
      if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
        throw new JevRequestError('jev: proxy response has no answers object', res.status);
      }
      const usage = (body as { usage?: unknown }).usage;
      const model = (body as { model?: unknown }).model;
      return {
        answers: answers as JevAnswerMap,
        usage: typeof usage === 'object' && usage !== null ? (usage as JevUsage) : null,
        model: typeof model === 'string' ? model : null,
        latencyMs: performance.now() - startedAt,
      };
    },
  };
}
