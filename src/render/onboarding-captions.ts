// onboarding-captions.ts — S6: first-occurrence caption registry (light onboarding).
//
// Tracks which of the 10 first-occurrence captions have fired this session.
// All state is render-side; nothing persists to WorldState or saves.
// Reset on every new round (including same-seed rematch) so each session
// starts fresh (Q6 DEFAULT_ACCEPTED).

import type { SimEvent } from '../sim/telemetry.js';

export type CaptionKey =
  | 'dig'
  | 'chamber'
  | 'spider'
  | 'foodMark'
  | 'rally'
  | 'spiderPriority'
  | 'aiInvading'
  | 'spiderRampage'
  | 'queenDamage'
  | 'queenStarvation';

const CAPTION_TEXTS: Record<CaptionKey, string> = {
  dig: 'Your workers will excavate the marked tile.',
  chamber: 'Chambers give workers and brood a purpose. This one is a [Chamber Type].',
  spider: 'A spider is hunting your ants. Use fighters to protect your queen.',
  foodMark: 'Your foragers will prioritize this pile.',
  rally: 'Fighters will converge here.',
  spiderPriority: 'Your fighters are engaging the spider.',
  aiInvading: 'The enemy is attacking your hive.',
  spiderRampage: 'The spider has gone hungry and is hunting on the surface.',
  queenDamage: 'Your queen is in danger.',
  queenStarvation: 'Your queen is growing hungry.',
};

// Exported so game-scene.ts can reset on round start.
export const triggered: Map<CaptionKey, boolean> = new Map();

export function resetCaptions(): void {
  triggered.clear();
}

/**
 * Check if a caption should fire for the first time this session.
 * Returns the text to display, or null if the caption already triggered.
 *
 * For the 'chamber' key, pass the chamber type name as `textOverride` to
 * substitute it into the "[Chamber Type]" placeholder.
 */
export function checkAndTrigger(key: CaptionKey, textOverride?: string): string | null {
  if (triggered.get(key)) return null;
  triggered.set(key, true);
  const base = CAPTION_TEXTS[key];
  if (textOverride !== undefined) {
    return base.replace('[Chamber Type]', textOverride);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Event → caption policy
// ---------------------------------------------------------------------------
//
// `captionForEvent` is the dispatch policy for captions driven by WorldState
// events (`world.events`). It is keyed by the event `type` string — NOT by a
// CaptionKey — so GameScene's event loop forwards each event type and shows
// whatever caption (if any) comes back. The recurring-vs-one-shot decision
// lives here rather than at the call site.
//
// Captions that are driven by world-state polling or input commands (dig,
// chamber, spider, foodMark, rally, spiderPriority, queenDamage,
// queenStarvation) are NOT events — they keep using checkAndTrigger directly.

// Recurring alerts re-fire their caption on EVERY occurrence of the event
// (e.g. every spider rampage, not just the first). These never consult the
// one-shot `triggered` map.
const RECURRING_EVENT_CAPTIONS = new Map<SimEvent['type'], CaptionKey>([
  ['spider_rampage_start', 'spiderRampage'],
]);

// One-shot onboarding events fire their caption once per session, then stay
// silent. They share the same `triggered` dedup as checkAndTrigger, so an
// event and any non-event trigger of the same CaptionKey suppress each other.
const ONE_SHOT_EVENT_CAPTIONS = new Map<SimEvent['type'], CaptionKey>([
  ['invasion_start', 'aiInvading'],
]);

/**
 * Map a WorldState event type to the caption that should display for it, or
 * null if the event has no caption (or a one-shot caption already fired).
 *
 * Recurring events (e.g. 'spider_rampage_start') return their caption on every
 * call; one-shot events (e.g. 'invasion_start') return their text once per
 * session then null. Unknown event types return null.
 */
export function captionForEvent(eventType: SimEvent['type']): string | null {
  const recurringKey = RECURRING_EVENT_CAPTIONS.get(eventType);
  if (recurringKey !== undefined) {
    return CAPTION_TEXTS[recurringKey];
  }
  const oneShotKey = ONE_SHOT_EVENT_CAPTIONS.get(eventType);
  if (oneShotKey !== undefined) {
    return checkAndTrigger(oneShotKey);
  }
  return null;
}
