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
//     Content-Encoding: gzip, X-Schema-Version: 1).
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
import { buildDebugSnapshot, type DebugSnapshot } from '../platform/debug-snapshot.js';
import { GameOutcome } from '../sim/game-over.js';

// Build-time-injected by vite.config.ts / vite.lib.config.ts `define`. The
// ambient declaration keeps the playtrace module self-contained — no
// global.d.ts shim required for a single-consumer define.
declare const __APP_VERSION__: string;

/** Wire-level schema version. Bumped on any breaking change to the envelope
 *  shape. Mirrored in the `X-Schema-Version` header so the server can reject
 *  unknown versions without paying the cost of decompressing the body. */
export const PLAYTRACE_SCHEMA_VERSION = 1 as const;

/** Hard ceiling on the gzipped body. Defense-in-depth — the server also
 *  enforces this and returns 413. Picked to fit comfortably inside the
 *  API Gateway HTTP API + Lambda binary-invoke effective payload cap. */
export const PLAYTRACE_MAX_GZIPPED_BYTES = 5 * 1024 * 1024;

/** Free-text survey field cap (per ADR §"Decision → Wire shape"). Enforced
 *  client-side so the server doesn't need to truncate. */
export const PLAYTRACE_FREE_TEXT_MAX = 2000;

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

/** Envelope as it goes over the wire (pre-gzip). Exported so tests can
 *  reconstruct expectations against the same shape. */
export interface PlaytraceEnvelope {
  sessionId: string;
  schemaVersion: typeof PLAYTRACE_SCHEMA_VERSION;
  gameVersion: string;
  simVersion: number;
  seed: number;
  tick: number;
  outcome: 'Victory' | 'Defeat' | 'MutualDestruction';
  quitFromPauseMenu: boolean;
  survey: PlaytraceSurvey;
  snapshot: DebugSnapshot | null;
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
export function outcomeToWire(
  outcome: GameOutcome,
): 'Victory' | 'Defeat' | 'MutualDestruction' {
  switch (outcome) {
    case GameOutcome.Victory:           return 'Victory';
    case GameOutcome.Defeat:            return 'Defeat';
    case GameOutcome.MutualDestruction: return 'MutualDestruction';
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

/** Build a fully-typed envelope from the submission input + a pre-built
 *  snapshot (or null for survey-only). Pure — no fetch, no compression.
 *  Exported for the downgrade-fallback unit test. */
export function buildPlaytraceEnvelope(
  input: PlaytraceSubmissionInput,
  snapshot: DebugSnapshot | null,
): PlaytraceEnvelope {
  return {
    sessionId: input.sessionId,
    schemaVersion: PLAYTRACE_SCHEMA_VERSION,
    gameVersion: __APP_VERSION__,
    // Sourced from the LIVE snapshot's own simVersion (per ADR §"Schema
    // versioning"). For loaded older saves, that field reflects what the
    // save was written as — accurate even though the running build is
    // newer. The current world.simVersion is the right field to read; we
    // do not import LATEST_SIM_VERSION at build time.
    simVersion: input.world.simVersion,
    seed: input.seed,
    tick: input.world.tick,
    outcome: outcomeToWire(input.outcome),
    quitFromPauseMenu: input.quitFromPauseMenu,
    survey: {
      rating: input.survey.rating,
      // truncateFreeText is idempotent; running it here guarantees the
      // contract bound even if a caller passed an unsanitized survey
      // straight to buildPlaytraceEnvelope (bypassing submitPlaytrace's
      // hoist). The hoist still saves repeated work in the downgrade loop.
      freeText: truncateFreeText(input.survey.freeText),
      brokenFlag: input.survey.brokenFlag,
    },
    snapshot,
  };
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
  if (input.endpoint === '') {
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
 *  Each stage rebuilds the envelope with the reduced snapshot, re-gzips,
 *  and checks size before falling through. Returns the first body that
 *  fits the cap, or the final survey-only body which always fits. */
async function buildPayloadWithDowngrade(
  input: PlaytraceSubmissionInput,
): Promise<Blob> {
  // Stage 1 — full snapshot.
  let snapshot = buildDebugSnapshot(input.world, input.seed, input.inputLog);
  let body = await encodeEnvelope(input, snapshot);
  if (body.size <= PLAYTRACE_MAX_GZIPPED_BYTES) return body;

  // Stage 2 — drop antTrace (typically dominant size contribution).
  snapshot = buildDebugSnapshot(input.world, input.seed, input.inputLog, {
    includeAntTrace: false,
  });
  body = await encodeEnvelope(input, snapshot);
  if (body.size <= PLAYTRACE_MAX_GZIPPED_BYTES) return body;

  // Stage 3 — also drop inputLog. Replay value is now gone.
  snapshot = buildDebugSnapshot(input.world, input.seed, input.inputLog, {
    includeAntTrace: false,
    includeInputLog: false,
  });
  body = await encodeEnvelope(input, snapshot);
  if (body.size <= PLAYTRACE_MAX_GZIPPED_BYTES) return body;

  // Stage 4 — survey-only. Always fits (envelope is a handful of fields).
  return encodeEnvelope(input, null);
}

/** Build a survey-only payload directly, skipping the snapshot construction.
 *  Used when the player did not opt in to upload. */
async function buildSurveyOnlyPayload(
  input: PlaytraceSubmissionInput,
): Promise<Blob> {
  return encodeEnvelope(input, null);
}

/** Stringify the envelope and gzip it. Shared helper across all four
 *  downgrade stages so the wire framing stays identical between them. */
async function encodeEnvelope(
  input: PlaytraceSubmissionInput,
  snapshot: DebugSnapshot | null,
): Promise<Blob> {
  const envelope = buildPlaytraceEnvelope(input, snapshot);
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
