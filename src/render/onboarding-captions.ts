// onboarding-captions.ts — S6: first-occurrence caption registry (light onboarding).
//
// Tracks which of the first-occurrence captions have fired this session.
// 'queenDamage' is re-armed by GameScene once the queen recovers (#375,
// queen-danger.ts), so it shows once per danger spell rather than once per session.
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
  | 'rallyRaid'
  | 'spiderPriority'
  | 'spiderRampage'
  | 'queenDamage'
  | 'queenStarvation'
  | 'autosaveFailed';

const CAPTION_TEXTS: Record<CaptionKey, string> = {
  dig: 'Your workers will excavate the marked tile.',
  chamber: 'Chambers give workers and brood a purpose. This one is a [Chamber Type].',
  spider: 'A spider is hunting your ants. Use fighters to protect your queen.',
  foodMark: 'Your foragers will prioritize this pile.',
  rally: 'Fighters will converge here.',
  // #290 PR 6: the rally is on an enemy's open entrance (raid-captions.ts).
  rallyRaid: 'Fighters will attack this nest and raid its larder when it is unguarded.',
  spiderPriority: 'Your fighters are engaging the spider.',
  spiderRampage: 'The spider has gone hungry and is hunting on the surface.',
  queenDamage: 'Your queen is in danger.',
  queenStarvation: 'Your queen is growing hungry.',
  autosaveFailed: 'Autosave failed — storage full or blocked.',
};

// Exported so game-scene.ts can reset on round start.
export const triggered: Map<CaptionKey, boolean> = new Map();

export function resetCaptions(): void {
  triggered.clear();
}

/**
 * Un-mark a one-shot caption key so it can fire again.
 *
 * checkAndTrigger marks a key the moment it hands back the text,
 * before the caption reaches the bounded caption queue. If the queue then DROPS
 * that caption on overflow it would never display yet stay marked 'already shown'
 * — losing a first-occurrence onboarding caption forever. UIScene calls this when
 * a dropped caption carries a key so the trigger re-fires on the next occurrence.
 * GameScene also calls it for 'queenDamage' once the queen recovers (#375,
 * queen-danger.ts), so that caption shows once per danger spell.
 *
 * Recurring captions (e.g. spiderRampage) never populate `triggered`, so calling
 * this for one of them is a harmless no-op.
 */
export function untrigger(key: CaptionKey): void {
  triggered.delete(key);
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
// `captionForEvent` is the text policy for captions driven by WorldState events
// (`world.events`). It is keyed by the event `type` string — NOT by a
// CaptionKey. GameScene's event loop hands each event to routeEventCaption
// (recurring-captions.ts), which decides when a caption shows; the only event
// with one is spider_rampage_start, whose text offerOwedRampageCaption takes
// from here.
//
// Captions that are driven by world-state polling or input commands (dig,
// chamber, spider, foodMark, rally, rallyRaid, spiderPriority, queenDamage,
// queenStarvation) are NOT events — they keep using checkAndTrigger directly.
//
// #394 — every event caption is now recurring. The one-shot invasion caption
// ('The enemy is attacking your hive.', on the first invasion_start only) is
// gone: the army warning (enemy-gathering.ts) announces every invasion wave
// instead, naming the threatened entrance, from world state rather than the AI's
// event.

// Recurring alerts re-fire their caption on EVERY occurrence of the event
// (e.g. every spider rampage, not just the first). These never consult the
// one-shot `triggered` map.
const RECURRING_EVENT_CAPTIONS = new Map<SimEvent['type'], CaptionKey>([
  ['spider_rampage_start', 'spiderRampage'],
]);

/**
 * Map a WorldState event type to the caption that should display for it, or
 * null if the event has no caption. Recurring events (e.g.
 * 'spider_rampage_start') return their caption on every call. Unknown event
 * types return null.
 */
export function captionForEvent(eventType: SimEvent['type']): string | null {
  const recurringKey = RECURRING_EVENT_CAPTIONS.get(eventType);
  return recurringKey === undefined ? null : CAPTION_TEXTS[recurringKey];
}
