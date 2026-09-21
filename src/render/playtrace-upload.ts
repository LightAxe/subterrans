// playtrace-upload.ts — issue #122 / ADR 0013 playtrace upload module.
//
// Browser-only glue that gzips and POSTs a survey + (optional) debug-snapshot
// payload to the website's `/api/playtrace` endpoint. Sibling to
// debug-snapshot-download.ts: that file handles the F9 local-file path; this
// one handles the same payload going to the cloud receiver for diagnostics.
//
// Boundary rules (ADR 0013):
//   - No src/sim/ imports — sessionId comes from crypto.randomUUID(), the
//     gameVersion from the build-time __APP_VERSION__ define, simVersion from
//     world.simVersion (read by the caller, not us).
//   - One outbound POST per submission. Body is gzipped JSON; framing matches
//     the contract verbatim (Content-Type: application/octet-stream,
//     Content-Encoding: gzip, X-Schema-Version: PLAYTRACE_SCHEMA_VERSION).
//   - Client cap: gzipped body ≤ 5 MB. Downgrade fallback rebuilds the
//     snapshot with antTrace omitted, then with inputLog omitted, then
//     submits survey-only (snapshot: null).
//   - Feature flag: an empty endpoint string disables the upload entirely.
//     The caller (main.ts via VITE_PLAYTRACE_ENDPOINT) is expected to feature-
//     gate the survey overlay too, but a defensive check here keeps a missed
//     gating from sending traffic to the wrong origin.
//
// Concurrency: a single in-flight controller is tracked at module scope so
// `cancelInFlightUpload()` can abort a still-running submission when the
// game restarts mid-upload. The contract is fire-and-forget from the player's
// perspective (the survey overlay closes immediately on submit), but if the
// game restarts before the request completes, the abort prevents the new
// session from racing the old one through the network.

import type { WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';
import type { SimEvent } from '../sim/telemetry.js';
import { buildDebugSnapshot, type DebugSnapshot } from '../platform/debug-snapshot.js';
import { GameOutcome } from '../sim/game-over.js';
import { buildPlaytraceSummary, type PlaytraceSummary } from './summary-builder.js';

// Build-time-injected by vite.config.ts / vite.lib.config.ts `define`. The
// ambient declaration keeps the playtrace module self-contained — no
// global.d.ts shim required for a single-consumer define.
declare const __APP_VERSION__: string;

/** Wire-level schema version. Bumped on any breaking change to the envelope
 *  shape. Mirrored in the `X-Schema-Version` header so the server can reject
 *  unknown versions without paying the cost of decompressing the body.
 *
 *  v3 (#294): adds the always-present `difficulty` tier. */
export const PLAYTRACE_SCHEMA_VERSION = 3 as const;

/** Hard ceiling on the gzipped body. Defense-in-depth — the server also
 *  enforces this and returns 413. Picked to fit comfortably inside the
 *  API Gateway HTTP API + Lambda binary-invoke effective payload cap. */
export const PLAYTRACE_MAX_GZIPPED_BYTES = 5 * 1024 * 1024;

/** Free-text survey field cap (per ADR §"Decision → Wire shape"). Enforced
 *  client-side so the server doesn't need to truncate. */
export const PLAYTRACE_FREE_TEXT_MAX = 2000;

/**
 * Issue #295 — default for the survey's "include a snapshot" checkbox.
 *
 * It shipped `false` until 2026-09-20, so a report carried the survey and
 * nothing else unless the player ticked the box. Opt-in rate was 0 of 2, which
 * is the expected outcome for an unticked box at the end of a round, and it is
 * why #293 — the first
 * substantive external playtest report — arrived with a seed and a sentence.
 *
 * The size question that blocked the flip is now answered. `scripts/measure-
 * playtrace-size.ts` runs real headless matches, stops at the terminal outcome
 * (the only tick a submission is ever built at) and gzips the four payloads the
 * downgrade chain would produce. Across 5 seeds per arm the largest FULL
 * envelope AT ROUND END was 24.1 KB against a passive player and 25.9 KB with
 * BOTH colonies AI-driven (`--both-ai`, the upper-bound arm: twice the live ants
 * and a real player inputLog). That is ~0.5% of PLAYTRACE_MAX_GZIPPED_BYTES, and
 * the downgrade chain never fired at any checkpoint. The world snapshot
 * dominates and barely grows with colony size, so size is not the reason to keep
 * this off.
 *
 * Flipping to `true` is the entire behaviour change: UIScene seeds the checkbox
 * from this constant and swaps the label to SURVEY_UPLOAD_LABEL_DEFAULT_ON,
 * which states plainly what is being sent. Deliberately typed `boolean` (not
 * inferred as `true`) so neither branch reads as dead code. Flipped ON on
 * 2026-09-20 — Rob's call on #295 once the measurement above came in: size is a
 * non-issue, the box stays visible and untickable, and the snapshot carries game
 * state only (ADR 0013 §Privacy), which the default-on label says outright.
 */
export const PLAYTRACE_INCLUDE_SNAPSHOT_DEFAULT: boolean = true;

/** Optional-email cap (#303). 254 is the RFC 5321 maximum forward-path length,
 *  so nothing longer can be a real address. Unlike the free text, an over-long
 *  value is DROPPED rather than truncated: truncating would manufacture a
 *  plausible-looking address belonging to somebody else, and the field is
 *  optional, so dropping costs nothing. */
export const PLAYTRACE_EMAIL_MAX = 254;

/** Survey contents collected by the overlay. Mirrors the wire envelope's
 *  `survey` object 1:1 — keep these in sync if the contract changes. */
export interface PlaytraceSurvey {
  /** Player rating, 1-5 inclusive. Validated at the overlay layer; this
   *  module trusts the caller to have clamped already. */
  rating: number;
  /** Free-text feedback. Truncated to PLAYTRACE_FREE_TEXT_MAX before send. */
  freeText: string;
  /** "Report as broken" flag — orthogonal to the rating so a 5-star "great
   *  game but X is broken" report is expressible. */
  brokenFlag: boolean;
  /** #303 — optional contact address, so a report that needs a follow-up
   *  question can get one. ABSENT (not `''`, not `null`) when the player left
   *  the field empty or typed something that isn't shaped like an address:
   *  see {@link sanitizeSurveyEmail}. Never blocks a submission. */
  email?: string;
}

/** Inputs the caller (game-scene) supplies to issue a submission. The module
 *  builds the snapshot internally so the downgrade rebuild can re-call
 *  buildDebugSnapshot with reduced options without forcing the caller to
 *  carry the world reference across the await. */
export interface PlaytraceSubmissionInput {
  /** Endpoint URL — `''` means feature off, the call no-ops. Typically
   *  `/api/playtrace` in production, threaded via VITE_PLAYTRACE_ENDPOINT. */
  endpoint: string;
  /** Stable per-session client UUID. Generated render-side via
   *  `crypto.randomUUID()` — never read off the sim PRNG. */
  sessionId: string;
  /** Terminal outcome for the run. `None` is rejected (the overlay only
   *  opens on a terminal outcome); the caller should never pass it. */
  outcome: GameOutcome;
  /** UI flag — true when the survey was reached via the pause menu's
   *  "Quit & feedback" path rather than after a natural game-over. */
  quitFromPauseMenu: boolean;
  /** Whether to include the debug snapshot in the submission. False =
   *  survey-only; the wire envelope's `snapshot` becomes null. */
  includeSnapshot: boolean;
  /** Live world reference, used only to build the snapshot. The module
   *  does not retain the reference beyond the synchronous build call. */
  world: WorldState;
  /** Session seed (matches the SaveFile envelope). */
  seed: number;
  /** Session-accumulated command log. Caller-owned reference; the upload
   *  shallow-copies each command into the payload. */
  inputLog: readonly SimCommand[];
  /** Survey contents from the overlay. */
  survey: PlaytraceSurvey;
  /** True when the session was booted from a saved file rather than a fresh
   *  game. Causes summary.eventsCoverage to be 'since_load' instead of
   *  'full_round', flagging that events before the save tick are missing. */
  resumedFromSave: boolean;
}

/** Result of a submission attempt. The caller surfaces a toast based on
 *  `status` (the survey overlay has already closed by this point). */
export type PlaytraceUploadResult =
  | { status: 'ok'; httpStatus: number }
  | { status: 'feature-off' }
  | { status: 'cancelled' }
  /** Server rejected the body (400/413) or transport failed (offline / DNS).
   *  Both produce the same UI: "feedback failed, please try again". */
  | { status: 'error'; reason: string; httpStatus?: number }
  /** Rate-limited. UI shows "try again later"; client does not auto-retry. */
  | { status: 'rate-limited'; retryAfterSeconds?: number }
  /** Server-side feature flag is off (PLAYTRACE_ENABLED=false → 503).
   *  Treated the same as `feature-off` by the UI — silent skip. */
  | { status: 'server-disabled' };

/** Round end reason — orthogonal to outcome; lets telemetry join outcome ×
 *  end-reason for D-30 distribution. 'QueenDeath' is the only reason in
 *  S0b-S4; TimeoutTiebreak and StalemateTiebreak land in S5. */
export type RoundEndReason = 'QueenDeath' | 'TimeoutTiebreak' | 'StalemateTiebreak';

/** Envelope as it goes over the wire (pre-gzip). Exported so tests can
 *  reconstruct expectations against the same shape.
 *
 *  v2 additions: events, summary, roundEndReason.
 *  - events + summary are omitted on survey-only submissions (snapshot: null).
 *  - roundEndReason is always present but may be null (quit from pause menu,
 *    or a game-over without a detectable queen-death event).
 *
 *  v3 addition: difficulty. Present on EVERY submission, survey-only included —
 *  survey-only is the common case and is precisely where the tier cannot be
 *  recovered from a snapshot (#294). */
export interface PlaytraceEnvelope {
  sessionId: string;
  schemaVersion: typeof PLAYTRACE_SCHEMA_VERSION;
  gameVersion: string;
  simVersion: number;
  /** v3 (#294) — the tier the round was played on, read off `world.difficulty`
   *  at submission time. Balance feedback ("too easy") is uninterpretable
   *  without it. schemaVersion 1/2 records will never carry it. */
  difficulty: 'Easy' | 'Normal' | 'Hard';
  seed: number;
  tick: number;
  outcome: 'Victory' | 'Defeat' | 'MutualDestruction';
  roundEndReason: RoundEndReason | null;
  quitFromPauseMenu: boolean;
  survey: PlaytraceSurvey;
  snapshot: DebugSnapshot | null;
  // Present only when snapshot is non-null (survey-only uploads omit both).
  events?: SimEvent[];
  summary?: PlaytraceSummary;
}

// ---------------------------------------------------------------------------
// Internal state — single in-flight controller for cancel-on-restart
// ---------------------------------------------------------------------------

let inFlightController: AbortController | null = null;

/** Aborts any in-flight upload. Idempotent — safe to call when no upload
 *  is in flight. Called from game restart paths so an upload from the
 *  previous session can't race the new session through the network. */
export function cancelInFlightUpload(): void {
  if (inFlightController !== null) {
    inFlightController.abort();
    inFlightController = null;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/** Map the sim's numeric GameOutcome to the contract's string name. The
 *  string form decouples the wire from the sim's internal numbering so the
 *  enum can be renumbered without breaking on-disk telemetry. `None` is
 *  invalid input — the survey only opens on a terminal outcome. */
export function outcomeToWire(outcome: GameOutcome): 'Victory' | 'Defeat' | 'MutualDestruction' {
  switch (outcome) {
    case GameOutcome.Victory:
      return 'Victory';
    case GameOutcome.Defeat:
      return 'Defeat';
    case GameOutcome.MutualDestruction:
      return 'MutualDestruction';
    case GameOutcome.None:
      throw new Error('playtrace-upload: outcome=None should never reach the wire');
  }
}

/** Sanitize the free-text response: trim, then truncate to the contract's
 *  cap. Exported so the overlay can show a live char counter against the
 *  same cap. */
export function truncateFreeText(s: string): string {
  // Trim only trailing whitespace — leading spaces in feedback ("  this is
  // broken because…") are usually a paste artifact and dropping them keeps
  // the stored row readable; we don't strip leading meaningful chars.
  const trimmed = s.replace(/\s+$/, '');
  if (trimmed.length <= PLAYTRACE_FREE_TEXT_MAX) return trimmed;
  return trimmed.slice(0, PLAYTRACE_FREE_TEXT_MAX);
}

/**
 * Sanitize the optional email (#303). Returns `undefined` — meaning "omit the
 * field entirely" — for anything that isn't plausibly an address, so a typo is
 * silently dropped instead of blocking the submission or surfacing an error
 * the player has no reason to care about.
 *
 * The shape check is deliberately loose: exactly one `@`, no whitespace
 * anywhere, and a non-empty local part and domain. A stricter client-side
 * pattern would silently discard the valid-but-unusual addresses it fails to
 * recognize, and the only cost of letting an odd one through is one bounced
 * follow-up. Anything longer than {@link PLAYTRACE_EMAIL_MAX} is dropped, not
 * truncated.
 *
 * Exported so the overlay and the platform settings layer apply the same rule.
 */
export function sanitizeSurveyEmail(raw: string | undefined): string | undefined {
  // Type-guarded rather than `=== undefined`: a stray null/number from an
  // untyped caller must cost the optional field, never the whole submission
  // (ADR 0013 — a bad optional email is dropped, not a 400 and not a throw).
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > PLAYTRACE_EMAIL_MAX) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  const at = trimmed.indexOf('@');
  // indexOf === lastIndexOf rejects both zero and two-or-more '@'.
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return undefined;
  if (at === trimmed.length - 1) return undefined;
  return trimmed;
}

/** Assemble the wire `survey` object: free text truncated, email sanitized to
 *  present-or-absent. Kept separate from the envelope literal so both the
 *  truncation and the omit-on-invalid rule live in one place. */
function buildWireSurvey(survey: PlaytraceSurvey): PlaytraceSurvey {
  const wire: PlaytraceSurvey = {
    rating: survey.rating,
    freeText: truncateFreeText(survey.freeText),
    brokenFlag: survey.brokenFlag,
  };
  const email = sanitizeSurveyEmail(survey.email);
  if (email !== undefined) wire.email = email;
  return wire;
}

/** Build a fully-typed envelope from the submission input + a pre-built
 *  snapshot (or null for survey-only). Pure — no fetch, no compression.
 *  Exported for the downgrade-fallback unit test. */
/** Derive the RoundEndReason from the event buffer. Returns null when no
 *  terminal event was emitted (quit from pause menu, or pre-S1 round).
 *  S5: round_end tiebreak events take priority; checked before queen_death. */
function deriveRoundEndReason(events: SimEvent[]): RoundEndReason | null {
  for (const ev of events) {
    if (ev.type === 'round_end') return ev.payload.reason;
  }
  for (const ev of events) {
    if (ev.type === 'queen_death') return 'QueenDeath';
  }
  return null;
}

export function buildPlaytraceEnvelope(
  input: PlaytraceSubmissionInput,
  snapshot: DebugSnapshot | null,
  // v2: pre-captured events and summary (must be provided in synchronous
  // prefix to avoid racing a post-restart world mutation).
  capturedEvents?: SimEvent[],
  capturedSummary?: PlaytraceSummary,
): PlaytraceEnvelope {
  const roundEndReason = capturedEvents ? deriveRoundEndReason(capturedEvents) : null;

  const envelope: PlaytraceEnvelope = {
    sessionId: input.sessionId,
    schemaVersion: PLAYTRACE_SCHEMA_VERSION,
    gameVersion: __APP_VERSION__,
    simVersion: input.world.simVersion,
    difficulty: input.world.difficulty,
    seed: input.seed,
    tick: input.world.tick,
    outcome: outcomeToWire(input.outcome),
    roundEndReason,
    quitFromPauseMenu: input.quitFromPauseMenu,
    survey: buildWireSurvey(input.survey),
    snapshot,
  };

  // Attach events + summary only when a snapshot is present (spec: survey-only
  // uploads omit both fields entirely).
  if (snapshot !== null && capturedEvents !== undefined && capturedSummary !== undefined) {
    envelope.events = capturedEvents;
    envelope.summary = capturedSummary;
  }

  return envelope;
}

/** Gzip a UTF-8 string using the native CompressionStream API. Returns the
 *  compressed bytes as a Blob so the caller can read `.size` for the cap
 *  check before deciding whether to retry with a smaller payload. */
export async function gzipString(s: string): Promise<Blob> {
  const stream = new Blob([s], { type: 'application/json' })
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

// ---------------------------------------------------------------------------
// Submission flow — graceful downgrade + fetch POST
// ---------------------------------------------------------------------------

/**
 * Submit a playtrace. Handles the full ADR §"Size limits and graceful
 * downgrade" sequence:
 *
 *   1. Build the full snapshot (or null if includeSnapshot=false) and
 *      gzip the envelope. If it fits the 5 MB cap, send it.
 *   2. Else rebuild with `includeAntTrace: false` (typically dominant
 *      contribution to size), re-gzip, retry.
 *   3. Else also drop the inputLog. Replay value is gone — caller's
 *      overlay should have warned the player when the box was ticked.
 *   4. Else fall back to a survey-only submission (snapshot: null).
 *
 * Feature flag handling: an empty endpoint string short-circuits to
 * `feature-off` without touching the network. Errors are normalized into
 * the {@link PlaytraceUploadResult} discriminated union so the caller
 * doesn't need to inspect raw Response objects.
 *
 * Timing invariant — load-bearing: the entire snapshot construction
 * (buildDebugSnapshot → serializeWorldState) and envelope build run in
 * this function's SYNCHRONOUS PREFIX, before the first true `await`
 * suspension point (which is inside `gzipString`'s `new Response(...).blob()`).
 * Callers may therefore mutate the live `world` reference immediately
 * after `void submitPlaytrace(...)` returns — game-scene.ts depends on
 * this so its end-of-game `restartGame()` doesn't race the in-flight
 * payload. The downgrade rebuild path stays inside the same async tail
 * after suspension, but by then every world read has already happened
 * into JSON-safe primitives via serializeWorldState (see save.ts:569).
 */
export async function submitPlaytrace(
  input: PlaytraceSubmissionInput,
): Promise<PlaytraceUploadResult> {
  // Trim before checking so a whitespace-only endpoint (e.g. an embedder
  // passing `playtraceEndpoint: '   '`, or a templated env var that
  // resolved blank) is treated as feature-off rather than firing a fetch
  // against an invalid URL. main.ts also normalizes at the boundary; this
  // is defense-in-depth for direct submitPlaytrace callers.
  const endpoint = input.endpoint.trim();
  if (endpoint === '') {
    // Feature flag is off — silent skip. The overlay should already be
    // gated on the same check; this guard is defense-in-depth.
    return { status: 'feature-off' };
  }

  // Cancel any prior in-flight upload before starting a new one. Two
  // submissions in flight simultaneously would race the server's per-route
  // throttle (5 burst / 1 rps) for no benefit — only one survey per game.
  cancelInFlightUpload();
  const controller = new AbortController();
  inFlightController = controller;

  // Pre-truncate the free-text once. The downgrade loop rebuilds the
  // envelope up to four times; running truncateFreeText each time would
  // re-allocate the (possibly large) string on every rebuild for no value.
  // Hoisting it also keeps the cleaned form stable across stages so the
  // server sees identical bytes regardless of which downgrade landed.
  const truncatedFreeText = truncateFreeText(input.survey.freeText);
  const preparedInput: PlaytraceSubmissionInput = {
    ...input,
    endpoint,
    survey: { ...input.survey, freeText: truncatedFreeText },
  };

  try {
    const body = preparedInput.includeSnapshot
      ? await buildPayloadWithDowngrade(preparedInput)
      : await buildSurveyOnlyPayload(preparedInput);

    const response = await fetch(preparedInput.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
        'X-Schema-Version': String(PLAYTRACE_SCHEMA_VERSION),
      },
      body,
      // No credentials, no referrer policy override — same-origin POST.
      signal: controller.signal,
    });

    if (response.status === 202) {
      return { status: 'ok', httpStatus: 202 };
    }
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      return retryAfter !== undefined
        ? { status: 'rate-limited', retryAfterSeconds: retryAfter }
        : { status: 'rate-limited' };
    }
    if (response.status === 503) {
      return { status: 'server-disabled' };
    }
    return {
      status: 'error',
      reason: `HTTP ${response.status}`,
      httpStatus: response.status,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { status: 'cancelled' };
    }
    return {
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Only clear the module-level controller if it still points to ours —
    // a concurrent cancelInFlightUpload + new submit may have rotated it
    // while this submission was awaiting the network.
    if (inFlightController === controller) inFlightController = null;
  }
}

/** ADR §"Size limits and graceful downgrade" sequence for snapshot-included
 *  submissions. Tries full → no-antTrace → no-antTrace-no-inputLog → null.
 *
 *  **World capture happens exactly once, in this function's synchronous
 *  prefix.** Both the wire envelope's top-level fields (`tick`, `simVersion`,
 *  ...) AND the nested snapshot field are read off `input.world` here, then
 *  the downgrade stages emit derivatives of the captured envelope via plain
 *  object manipulation — no further world reads. Codex P1 finding: the
 *  caller's pattern is `void submitPlaytrace(...)` followed by an immediate
 *  synchronous `restartGame()`, which mutates the live world. The first
 *  `await` here yields control to that restart, so any later
 *  `buildPlaytraceEnvelope(input, ...)` or `buildDebugSnapshot(input.world, ...)`
 *  would race a post-restart world and produce a payload with mixed
 *  sessions on the very oversized path this loop exists to handle. */
async function buildPayloadWithDowngrade(input: PlaytraceSubmissionInput): Promise<Blob> {
  // Capture the world ONCE, synchronously, into JSON-safe primitives.
  // world.events.slice() and buildPlaytraceSummary must happen here (in
  // the sync prefix) before the first await yields control back to the
  // caller — game-scene.ts fires restartGame() immediately after
  // void-casting submitPlaytrace, so the live world is mutated during the
  // async tail of this function.
  const capturedEvents: SimEvent[] = input.world.events.slice();
  const capturedSummary = buildPlaytraceSummary(
    input.world,
    input.resumedFromSave,
    outcomeToWire(input.outcome),
  );
  const fullSnap = buildDebugSnapshot(input.world, input.seed, input.inputLog);
  const fullEnvelope = buildPlaytraceEnvelope(input, fullSnap, capturedEvents, capturedSummary);

  // Stage 1 — full envelope.
  let body = await gzipEnvelope(fullEnvelope);
  if (body.size <= PLAYTRACE_MAX_GZIPPED_BYTES) return body;

  // Stage 2 — drop antTrace (typically dominant size contribution).
  const stage2: PlaytraceEnvelope = {
    ...fullEnvelope,
    snapshot: { ...fullSnap, antTrace: [] },
  };
  body = await gzipEnvelope(stage2);
  if (body.size <= PLAYTRACE_MAX_GZIPPED_BYTES) return body;

  // Stage 3 — also drop inputLog. Replay value is now gone.
  const stage3: PlaytraceEnvelope = {
    ...fullEnvelope,
    snapshot: { ...fullSnap, antTrace: [], inputLog: [] },
  };
  body = await gzipEnvelope(stage3);
  if (body.size <= PLAYTRACE_MAX_GZIPPED_BYTES) return body;

  // Stage 4 — survey-only. Derive from the pre-captured fullEnvelope
  // (not from input.world directly) to avoid reading mutated world state
  // after the awaits above — restartGame() may have fired. Events and
  // summary are excluded per spec (survey-only uploads omit both).
  const { events: _ev, summary: _sm, ...stage4Base } = fullEnvelope;
  const stage4: PlaytraceEnvelope = { ...stage4Base, snapshot: null };
  return gzipEnvelope(stage4);
}

/** Build a survey-only payload directly, skipping the snapshot construction.
 *  Used when the player unticked the replay-data box. Same world-capture
 *  property as the downgrade path: the envelope is built in this function's
 *  synchronous prefix before the first await.
 *
 *  Capture events synchronously so roundEndReason is derived from the
 *  pre-restart event buffer (world.events may be mutated after the first
 *  await if restartGame fires immediately). */
async function buildSurveyOnlyPayload(input: PlaytraceSubmissionInput): Promise<Blob> {
  const capturedEvents: SimEvent[] = input.world.events.slice();
  // survey-only: snapshot is null, so events+summary are omitted from the
  // envelope body (per spec). roundEndReason IS included — it's a top-level
  // field present on all submissions.
  const envelope = buildPlaytraceEnvelope(input, null, capturedEvents);
  return gzipEnvelope(envelope);
}

/** Stringify a fully-built envelope and gzip it. The envelope is already
 *  decoupled from the live world at this point — this function does no
 *  further world reads. */
async function gzipEnvelope(envelope: PlaytraceEnvelope): Promise<Blob> {
  return gzipString(JSON.stringify(envelope));
}

/** Parse a Retry-After header value as integer seconds. Returns undefined on
 *  unparseable input (the contract specifies seconds; HTTP-date form is
 *  accepted by some servers but the contract pins it to seconds). */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}
