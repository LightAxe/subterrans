// caption-queue.ts — Stage 3b controls rework (issue #18, component #3).
//
// The ONE caption-admission policy that ALL callers route through (existing
// event captions, onboarding-captions, and the new first-use hints) so two
// captions can never paint on top of each other (Codex R1#8/R2). Pure + Phaser-
// free: UIScene owns the Phaser Text/tween + the timing; this module owns only
// the "what happens to this request" decision, so the policy is unit-testable.
//
// Policy (locked in the grill):
//   - The currently-displaying caption is NEVER preempted (it finishes its fade)
//     — except by a newer version of itself (#378, below).
//   - Pending capacity = 1.
//   - Event captions outrank first-use hints.
//   - A duplicate first-use (same hintId already active OR pending) is coalesced
//     — never queued twice.
//   - On overflow the first-use is dropped before an event caption: an incoming
//     event replaces a pending first-use; an incoming first-use is dropped when
//     anything is already pending.
//   - A dropped/coalesced first-use is NOT reported as "begun", so UIScene never
//     marks it shown and it can re-trigger later (Codex R1#9).
//   - #378: captions that share a `supersedeKey` are versions of one message (the
//     raid order the player just gave). A newer one REPLACES an older one instead
//     of queueing behind it: an older one waiting in `pending` is swapped out in
//     place (it keeps that queue position), and an older one on screen is cut
//     short — the newer one takes over the active slot at once. Nothing else
//     moves: a different caption waiting in `pending` still waits, now behind the
//     newer version — and, if it is an event caption, no longer than it would
//     have: the newer version then takes over the old one's remaining time on
//     screen (`keepSchedule`) instead of starting a fresh one, so a burst of order
//     switches never holds back, say, an invasion warning. With nothing waiting,
//     or only a first-use hint (events outrank hints), it gets a full lifetime.
//     Captions without a key are untouched by this rule.

import type { CaptionKey } from './onboarding-captions.js';

export type CaptionSource = 'event' | 'first-use';

export interface CaptionRequest {
  text: string;
  /** Screen-pixel center for the caption Text. */
  x: number;
  y: number;
  source: CaptionSource;
  /** First-use hint id — present iff source === 'first-use'. Drives coalescing
   *  and the mark-shown-on-display persistence in UIScene. */
  hintId?: string;
  /** One-shot caption key — present iff source === 'event' AND the caption was
   *  produced by a one-shot trigger (checkAndTrigger), which marks the key BEFORE
   *  the request reaches this queue. If the request is dropped on
   *  overflow, UIScene un-marks this key so the caption can re-fire (it never
   *  displayed). Absent for recurring captions, which don't dedup on `triggered`. */
  captionKey?: CaptionKey;
  /** #372 — full-opacity hold (ms) between the fade-in and fade-out; absent:
   *  CAPTION_HOLD_MS. For a long caption that must be read (the army warning). */
  holdMs?: number;
  /** #378 — a caption that is the latest version of a message: it replaces an
   *  older caption with the same key, on screen or pending, instead of queueing
   *  behind it (see the policy above). Absent: an ordinary caption. */
  supersedeKey?: string;
}

/** Default full-opacity hold of a caption (ms), between its 300 ms fade-in and
 *  400 ms fade-out. */
export const CAPTION_HOLD_MS = 800;
/** Caption fade-in and fade-out durations (ms). */
export const CAPTION_FADE_IN_MS = 300;
export const CAPTION_FADE_OUT_MS = 400;

/** How long (ms) `req` holds at full opacity. */
export function captionHoldMs(req: CaptionRequest): number {
  return req.holdMs ?? CAPTION_HOLD_MS;
}

/**
 * #372 — the least full-opacity hold (ms) a long-hold caption keeps when it
 * gives way: enough to read two lines, which the default 800 ms is not.
 */
export const CAPTION_YIELD_FLOOR_MS = 2000;

/**
 * #372 — a long-hold caption (hold > CAPTION_HOLD_MS) gives way once an event
 * caption (not a first-use hint) waits behind it: it keeps only what CAPTION_YIELD_FLOOR_MS would have
 * left after `heldMs` at full opacity, so what waits (a one-shot, or owed raid
 * news / the rampage warning, whose owed windows assume short captions) is held
 * back ~1.2 s longer than behind a default caption, not ~3.2 s. Returns that
 * remaining hold (ms, >= 0), or null when `req` is not long-hold (never yields).
 */
export function yieldedHoldMs(req: CaptionRequest, heldMs: number): number | null {
  const hold = captionHoldMs(req);
  if (hold <= CAPTION_HOLD_MS) return null;
  return Math.max(0, Math.min(hold, CAPTION_YIELD_FLOOR_MS) - heldMs);
}

/**
 * #378 — the fade-in (ms) of a caption that starts at opacity `fromAlpha` (0, or
 * that of the older version it replaced): only the rest of the way up, at the
 * usual rate, and at least 1 ms (a tween needs a duration).
 */
export function captionFadeInMs(fromAlpha: number): number {
  const a = Math.max(0, Math.min(1, fromAlpha));
  return Math.max(1, Math.round(CAPTION_FADE_IN_MS * (1 - a)));
}

/** Total visible lifetime (ms) of `req`: fade-in + hold + fade-out. */
export function captionTotalMs(req: CaptionRequest): number {
  return CAPTION_FADE_IN_MS + captionHoldMs(req) + CAPTION_FADE_OUT_MS;
}

export interface CaptionQueueState {
  /** The request currently displaying (its tween is in flight), or null. */
  active: CaptionRequest | null;
  /** The single queued request waiting for `active` to finish, or null. */
  pending: CaptionRequest | null;
}

export function createCaptionQueueState(): CaptionQueueState {
  return { active: null, pending: null };
}

/**
 * #290 PR 6 / #350: may a recurring caption (raid news, the spider-rampage
 * warning) enter the queue now? Only when the queue is fully idle. Taking the
 * single pending slot behind an active caption would make an arriving one-shot
 * event (rally, queen damage, onboarding) overflow and be dropped for good, so
 * recurring news waits instead (callers go
 * through recurring-captions.ts offerRecurringCaption).
 */
export function recurringCaptionMayEnter(state: CaptionQueueState): boolean {
  return state.active === null && state.pending === null;
}

/**
 * Outcome of admitting a request. Exactly one of begin/queued/coalesced/dropped
 * describes the incoming request; `droppedFirstUse`, when set, is a previously-
 * pending first-use that the incoming event evicted (UIScene clears any
 * mark/marking for it — though since it never began displaying, nothing was
 * marked).
 */
export interface AdmitResult {
  /** The request should start displaying NOW (UIScene begins its tween, and —
   *  if first-use — marks it shown). */
  begin?: CaptionRequest;
  /** The request was parked in `pending`. */
  queued?: CaptionRequest;
  /** A duplicate first-use was folded into an existing one. */
  coalesced?: boolean;
  /** The request was rejected (overflow). */
  dropped?: CaptionRequest;
  /** A pending first-use evicted by an incoming higher-priority event. */
  droppedFirstUse?: CaptionRequest;
  /** #378 — the on-screen caption the incoming one (same supersedeKey) cut short:
   *  `begin` (the newer version) takes its place on screen. */
  replacedActive?: CaptionRequest;
  /** #378 — with `replacedActive`: a different EVENT caption is waiting in
   *  `pending`, so the newer version keeps the old one's remaining time on screen
   *  (UIScene swaps the words on the same Text, its fades and hold running on)
   *  rather than starting a fresh lifetime that would hold that event back longer.
   *  A waiting first-use hint does not get this: events outrank hints. */
  keepSchedule?: boolean;
  /** #378 — the pending caption the incoming one (same supersedeKey) replaced in
   *  place (`queued` is the newer version). It never displayed. */
  replacedPending?: CaptionRequest;
}

function sameFirstUse(a: CaptionRequest | null, b: CaptionRequest): boolean {
  return (
    a !== null && a.source === 'first-use' && b.source === 'first-use' && a.hintId === b.hintId
  );
}

/**
 * Admit a request into the queue, mutating `state`. Returns what UIScene should
 * do with it. Never throws.
 */
export function admitCaption(state: CaptionQueueState, req: CaptionRequest): AdmitResult {
  // Nothing on screen → display immediately.
  if (state.active === null) {
    state.active = req;
    return { begin: req };
  }

  // #378 — a newer version of the caption on screen cuts it short and takes its
  // place (an older version pending too is superseded); a newer version of the
  // pending caption replaces it in place.
  const key = req.supersedeKey;
  if (key !== undefined) {
    if (state.active.supersedeKey === key) {
      const result: AdmitResult = { begin: req, replacedActive: state.active };
      state.active = req;
      if (state.pending?.supersedeKey === key) {
        result.replacedPending = state.pending;
        state.pending = null;
      }
      if (state.pending?.source === 'event') result.keepSchedule = true;
      return result;
    }
    if (state.pending?.supersedeKey === key) {
      const replaced = state.pending;
      state.pending = req;
      return { queued: req, replacedPending: replaced };
    }
  }

  // Coalesce a duplicate first-use against whatever is active or already pending
  // (Codex R2): the same hint must never queue twice.
  if (
    req.source === 'first-use' &&
    (sameFirstUse(state.active, req) || sameFirstUse(state.pending, req))
  ) {
    return { coalesced: true };
  }

  // Free pending slot → park it.
  if (state.pending === null) {
    state.pending = req;
    return { queued: req };
  }

  // Pending is occupied. Event outranks a pending first-use: evict it.
  if (req.source === 'event' && state.pending.source === 'first-use') {
    const evicted = state.pending;
    state.pending = req;
    return { queued: req, droppedFirstUse: evicted };
  }

  // Otherwise overflow — drop the incoming request (an incoming first-use loses
  // to any occupied slot; a second event loses to the first event already
  // queued, preserving order).
  return { dropped: req };
}

/**
 * Mark the active caption finished and promote the pending one. Returns the
 * request that should now begin displaying (if any).
 */
export function completeCaption(state: CaptionQueueState): { begin?: CaptionRequest } {
  state.active = state.pending;
  state.pending = null;
  return state.active ? { begin: state.active } : {};
}

/** Drop a pending FIRST-USE entry (used by "Reset first-use hints" so a queued
 *  first-use does not surface after its persisted flag was cleared). A pending
 *  EVENT caption is left intact: event captions are marked-triggered BEFORE they
 *  reach the queue and this path does not untrigger them, so dropping one would
 *  suppress it for the rest of the round (Codex PR #218). Does not touch the
 *  active caption, which is mid-fade and allowed to finish. */
export function clearPendingFirstUse(state: CaptionQueueState): void {
  if (state.pending?.source === 'first-use') state.pending = null;
}
