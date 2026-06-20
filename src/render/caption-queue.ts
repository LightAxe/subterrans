// caption-queue.ts — Stage 3b controls rework (issue #18, component #3).
//
// The ONE caption-admission policy that ALL callers route through (existing
// event captions, onboarding-captions, and the new first-use hints) so two
// captions can never paint on top of each other (Codex R1#8/R2). Pure + Phaser-
// free: UIScene owns the Phaser Text/tween + the timing; this module owns only
// the "what happens to this request" decision, so the policy is unit-testable.
//
// Policy (locked in the grill):
//   - The currently-displaying caption is NEVER preempted (it finishes its fade).
//   - Pending capacity = 1.
//   - Event captions outrank first-use hints.
//   - A duplicate first-use (same hintId already active OR pending) is coalesced
//     — never queued twice.
//   - On overflow the first-use is dropped before an event caption: an incoming
//     event replaces a pending first-use; an incoming first-use is dropped when
//     anything is already pending.
//   - A dropped/coalesced first-use is NOT reported as "begun", so UIScene never
//     marks it shown and it can re-trigger later (Codex R1#9).

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
   *  produced by a one-shot trigger (checkAndTrigger/captionForEvent), which marks
   *  the key BEFORE the request reaches this queue. If the request is dropped on
   *  overflow, UIScene un-marks this key so the caption can re-fire (it never
   *  displayed). Absent for recurring captions, which don't dedup on `triggered`. */
  captionKey?: CaptionKey;
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

/** Drop any pending entry (used by "Reset hints" so a queued first-use does not
 *  surface after its persisted flag was cleared). Does not touch the active
 *  caption, which is mid-fade and allowed to finish. */
export function clearPending(state: CaptionQueueState): void {
  state.pending = null;
}
