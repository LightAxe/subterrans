// onboarding-captions.ts — S6: first-occurrence caption registry (light onboarding).
//
// Tracks which of the 10 first-occurrence captions have fired this session.
// All state is render-side; nothing persists to WorldState or saves.
// Reset on every new round (including same-seed rematch) so each session
// starts fresh (Q6 DEFAULT_ACCEPTED).

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
  dig:             'Your workers will excavate the marked tile.',
  chamber:         'Chambers give workers and brood a purpose. This one is a [Chamber Type].',
  spider:          'A spider is hunting your ants. Use fighters to protect your queen.',
  foodMark:        'Your foragers will prioritize this pile.',
  rally:           'Fighters will converge here.',
  spiderPriority:  'Your fighters are engaging the spider.',
  aiInvading:      'The enemy is attacking your hive.',
  spiderRampage:   'The spider has gone hungry and is in the tunnels.',
  queenDamage:     'Your queen is in danger.',
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
