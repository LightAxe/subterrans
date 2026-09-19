// jev-client.ts — browser side of the Jev proxy contract (v2, session-bound).
//
// The game never talks to TypeSafe directly and carries no SDK: it POSTs JSON to
// a SAME-ORIGIN proxy (`/api/jev` in production, the Vite dev-server proxy
// locally) which holds the API key, owns the prompt and forwards to Jev. The
// configured endpoint is a BASE path with two routes under it:
//
//   POST <base>/session   body {}
//     200 { token, expiresInSeconds, beatBudget, minBeatIntervalMs }
//     429 { error: 'rate_limited' } (+Retry-After) | 500 | 503
//
//   POST <base>/beat      body { token, state }
//     200 { answers, usage, model }
//     400 bad_request | 401 invalid_token | 403 budget_exhausted
//     429 too_fast (+Retry-After) | 500 | 502 | 503
//
// `state` is EXACTLY the object `encodeBeat()` produces — bucketed, digit-free
// and ≤ JEV_MAX_STATE_BYTES. The proxy is schema-locked: it builds the questions
// itself from the keys under `state.candidates` and ignores any description the
// client might send, so no question text goes over the wire at all any more.
//
// Sessions are this file's business and nobody else's: the controller asks for a
// beat and gets one. `beat()` mints lazily (no session yet, one inside the renew
// margin of its expiry, or one whose beat budget is spent) and, on the two
// session-death codes — 401 invalid_token, 403 budget_exhausted — mints one
// replacement and retries the beat exactly once.
//
// Every other non-200, malformed body, network error and timeout throws, and the
// caller (jev-enemy-controller.ts) counts any throw as one failed beat, falling
// back to the rule-based AI after three in a row. A 429 is deliberately NOT
// retried: `too_fast` means the proxy is pacing us and an immediate retry would
// only make that worse — it is simply a failed beat.
//
// One client owns one session, so `createOpponentControllers` builds one per AI
// seat rather than sharing a token (and its budget) between them.

import {
  JEV_ID_PATTERN,
  JEV_MAX_QUESTIONS,
  JEV_MAX_STATE_BYTES,
  type JevAnswerMap,
} from './jev-encode.js';

/** Client-side deadline for ONE request (a mint and a beat each get their own), in ms. */
export const JEV_DEFAULT_TIMEOUT_MS = 8000;
/**
 * Re-mint this long before a session's stated expiry rather than racing it.
 * Capped at half the session's own lifetime so a short-lived session doesn't
 * re-mint before every single beat.
 */
export const JEV_SESSION_RENEW_MARGIN_MS = 60_000;

export interface JevUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

export interface JevAskResult {
  readonly answers: JevAnswerMap;
  readonly usage: JevUsage | null;
  readonly model: string | null;
  /** Wall-clock round trip of the `/beat` request, measured render-side (never in src/sim/). */
  readonly latencyMs: number;
}

/**
 * What a `/session` mint reported. The three numbers are `null` when the proxy
 * did not send them: the token is the only field the client cannot do without,
 * and the 401 / 403 paths are the real backstops for expiry and budget anyway.
 */
export interface JevMintResult {
  readonly expiresInSeconds: number | null;
  readonly beatBudget: number | null;
  readonly minBeatIntervalMs: number | null;
  /** Wall-clock round trip of the `/session` request. */
  readonly latencyMs: number;
}

/** Cumulative request counters, for logging and for reasoning about the budget. */
export interface JevClientStats {
  /** Every HTTP request this client has sent — mints included. `mints + beats`. */
  readonly requests: number;
  /** `POST <base>/session` requests sent (the readiness probe is one of them). */
  readonly mints: number;
  /** `POST <base>/beat` requests sent, including a retry after a 401 / 403 re-mint. */
  readonly beats: number;
}

/** What the controller depends on. Kept narrow so test doubles stay small. */
export interface JevClient {
  /**
   * Mint a fresh session, replacing whatever this client held. Doubles as the
   * controller's readiness probe: it is the cheapest request that proves the
   * endpoint is alive, and the session it leaves behind is the one the first
   * real beat uses.
   */
  mintSession(): Promise<JevMintResult>;
  /** Run one beat against the current session, minting first if one is needed. */
  beat(state: Record<string, unknown>): Promise<JevAskResult>;
}

/** The real proxy client, which also reports what it has sent. */
export interface JevProxyClient extends JevClient {
  readonly stats: JevClientStats;
}

/** Thrown for any non-200 response; `status` is null for network / timeout failures. */
export class JevRequestError extends Error {
  readonly status: number | null;
  /** The `Retry-After` header when the proxy sent one (429 / 503). */
  readonly retryAfter: string | null;
  constructor(message: string, status: number | null, retryAfter: string | null = null) {
    super(message);
    this.name = 'JevRequestError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface JevClientOptions {
  /** Same-origin BASE path; `/session` and `/beat` hang off it. Empty string is
   *  a programming error — the caller gates on it. */
  readonly base: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** A finite number above zero, or null for anything else (missing, NaN, ≤ 0, wrong type). */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** As `positiveNumber`, but zero is a legitimate value (an interval of "no wait"). */
function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Fail fast on anything the proxy would 400 on, so a bad beat costs no network.
 *
 * v2 checks the state alone, because the state is the whole request: the proxy
 * derives one question per key under `state.candidates` (a string value is a
 * yes/no question, an object value is a choice whose keys are the options), so
 * those keys carry exactly the constraints the question ids and option keys used
 * to carry.
 */
export function assertRequestValid(state: Record<string, unknown>): void {
  const candidates = state.candidates;
  if (typeof candidates !== 'object' || candidates === null || Array.isArray(candidates)) {
    throw new JevRequestError('jev: state has no candidates object', null);
  }
  const groups = candidates as Record<string, unknown>;
  const ids = Object.keys(groups);
  if (ids.length === 0) throw new JevRequestError('jev: no candidates to ask about', null);
  if (ids.length > JEV_MAX_QUESTIONS) {
    throw new JevRequestError(
      `jev: ${ids.length} candidate groups exceeds the ${JEV_MAX_QUESTIONS} question cap`,
      null,
    );
  }
  for (const id of ids) {
    if (!JEV_ID_PATTERN.test(id))
      throw new JevRequestError(`jev: invalid candidate group '${id}'`, null);
    const group = groups[id];
    if (typeof group === 'string') continue; // yes/no question — no option keys
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      throw new JevRequestError(`jev: candidate group '${id}' is neither text nor options`, null);
    }
    for (const key of Object.keys(group)) {
      if (!JEV_ID_PATTERN.test(key)) {
        throw new JevRequestError(`jev: invalid option key '${key}' on group '${id}'`, null);
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

/** The live session, held in memory only. */
interface JevSession {
  readonly token: string;
  /**
   * `performance.now()` deadline at which the session stops being reused —
   * its expiry minus the renew margin. `Infinity` when the proxy sent no
   * expiry, in which case only a 401 retires the session.
   */
  readonly renewAt: number;
  /** `Infinity` when the proxy sent no budget; only a 403 retires the session then. */
  readonly beatBudget: number;
  /** Estimate: counts `/beat` requests SENT, which a rejected beat may not have consumed. */
  beatsUsed: number;
}

export function createJevClient(opts: JevClientOptions): JevProxyClient {
  // Tolerate a trailing slash on the configured base so `/api/jev/` and
  // `/api/jev` build the same two route URLs.
  const base = opts.base.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  let session: JevSession | null = null;
  let mints = 0;
  let beats = 0;

  function requireBase(): void {
    if (base === '') throw new JevRequestError('jev: no endpoint configured', null);
  }

  /** POST one JSON body to a route and insist on a 200. */
  async function post(
    route: '/session' | '/beat',
    body: Record<string, unknown>,
  ): Promise<{ res: Response; latencyMs: number }> {
    const startedAt = performance.now();
    let res: Response;
    try {
      res = await doFetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new JevRequestError(`jev: ${route} failed (${detail})`, null);
    }
    if (res.status !== 200) {
      throw new JevRequestError(
        `jev: proxy returned ${res.status} for ${route}`,
        res.status,
        res.headers.get('Retry-After'),
      );
    }
    return { res, latencyMs: performance.now() - startedAt };
  }

  async function readJson(res: Response): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new JevRequestError('jev: proxy returned a non-JSON body', res.status);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new JevRequestError('jev: proxy returned a non-object body', res.status);
    }
    return body as Record<string, unknown>;
  }

  /** One `/session` mint. Replaces the held session only on success. */
  async function mint(): Promise<{ session: JevSession; result: JevMintResult }> {
    requireBase();
    mints += 1;
    const { res, latencyMs } = await post('/session', {});
    const body = await readJson(res);
    const token = body.token;
    if (typeof token !== 'string' || token === '') {
      throw new JevRequestError('jev: session response has no token', res.status);
    }
    const expiresInSeconds = positiveNumber(body.expiresInSeconds);
    const beatBudget = positiveNumber(body.beatBudget);
    const lifetimeMs = expiresInSeconds === null ? Infinity : expiresInSeconds * 1000;
    const margin = Math.min(JEV_SESSION_RENEW_MARGIN_MS, lifetimeMs / 2);
    const fresh: JevSession = {
      token,
      renewAt: lifetimeMs === Infinity ? Infinity : performance.now() + lifetimeMs - margin,
      beatBudget: beatBudget ?? Infinity,
      beatsUsed: 0,
    };
    session = fresh;
    return {
      session: fresh,
      result: {
        expiresInSeconds,
        beatBudget,
        minBeatIntervalMs: nonNegativeNumber(body.minBeatIntervalMs),
        latencyMs,
      },
    };
  }

  function isUsable(s: JevSession | null): s is JevSession {
    return s !== null && performance.now() < s.renewAt && s.beatsUsed < s.beatBudget;
  }

  async function activeSession(): Promise<JevSession> {
    if (isUsable(session)) return session;
    return (await mint()).session;
  }

  async function sendBeat(s: JevSession, state: Record<string, unknown>): Promise<JevAskResult> {
    beats += 1;
    s.beatsUsed += 1;
    const { res, latencyMs } = await post('/beat', { token: s.token, state });
    const body = await readJson(res);
    const answers = body.answers;
    if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
      throw new JevRequestError('jev: proxy response has no answers object', res.status);
    }
    const usage = body.usage;
    const model = body.model;
    return {
      answers: answers as JevAnswerMap,
      usage: typeof usage === 'object' && usage !== null ? (usage as JevUsage) : null,
      model: typeof model === 'string' ? model : null,
      latencyMs,
    };
  }

  return {
    async mintSession(): Promise<JevMintResult> {
      return (await mint()).result;
    },

    async beat(state: Record<string, unknown>): Promise<JevAskResult> {
      requireBase();
      assertRequestValid(state);
      const current = await activeSession();
      try {
        return await sendBeat(current, state);
      } catch (err) {
        const dead = err instanceof JevRequestError && (err.status === 401 || err.status === 403);
        if (!dead) throw err;
        // 401 invalid_token (expired / unknown) or 403 budget_exhausted: the
        // session is gone, not the endpoint. Mint one replacement and retry
        // this beat ONCE — a second failure of any kind is a failed beat.
        session = null;
        const replacement = await mint();
        return await sendBeat(replacement.session, state);
      }
    },

    get stats(): JevClientStats {
      return { requests: mints + beats, mints, beats };
    },
  };
}
