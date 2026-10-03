// onboarding-captions.ts — S6: first-occurrence caption registry (light onboarding).
//
// Tracks which of the first-occurrence captions have fired this session.
// 'queenDamage' is re-armed by GameScene once the queen recovers (#375,
// queen-danger.ts), so it shows once per danger spell rather than once per session.
// 'foodStorageNeeded' (#395) is re-armed the same way once storage covers the egg
// reserve again (storage-hint.ts).
// All state is render-side; nothing persists to WorldState or saves.
// Reset on every new round (including same-seed rematch) so each session
// starts fresh (Q6 DEFAULT_ACCEPTED).

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
  | 'foodStorageNeeded'
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
  // #395 (V70): storage cannot hold the egg reserve (storage-hint.ts). The text for a
  // colony with no Food Storage chamber; one with a larder already is told its stores
  // are full (#413, storage-hint.ts STORAGE_FULL_HINT_TEXT, under this same key).
  foodStorageNeeded: 'Build a Food Storage chamber so your queen can lay eggs.',
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
 * a dropped caption carries a key so the trigger re-fires on the next occurrence,
 * and (#395) for a retryable caption evicted from the pending slot.
 * GameScene also calls it for 'queenDamage' once the queen recovers (#375,
 * queen-danger.ts), so that caption shows once per danger spell, and for
 * 'foodStorageNeeded' once storage covers the egg reserve again (#395,
 * storage-hint.ts).
 *
 * Recurring captions (e.g. spiderRampage) never populate `triggered`, so calling
 * this for one of them is a harmless no-op.
 */
export function untrigger(key: CaptionKey): void {
  triggered.delete(key);
}

/**
 * #395 — true for a one-shot key whose source offers its caption again every frame
 * until it shows: 'foodStorageNeeded' (storage-hint.ts advanceStorageHint asks
 * checkAndTrigger each frame while storage blocks the queen). UIScene admits such a
 * caption as `retryable` (caption-queue.ts), so any event caption that is not
 * retryable takes the pending slot from it and it simply comes back. Every other
 * key fires once per trigger, so a caption dropped for it could be lost for good.
 */
export function captionKeyRetries(key: CaptionKey): boolean {
  return key === 'foodStorageNeeded';
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
// Caption text outside the one-shot registry
// ---------------------------------------------------------------------------
//
// #397 — no WorldState event is mapped to caption text here any more. The
// spider-rampage warning, the last one that was (on each spider_rampage_start),
// is a recurring caption: offerOwedRampageCaption (recurring-captions.ts) shows it once per
// hungry spell, owed from world state while the rampage threatens the viewing
// colony, not on each rampage start (every chase divert restarts the sim's
// rampage). It reads its text with captionText.
//
// #394 — the one-shot invasion caption ('The enemy is attacking your hive.', on
// the first invasion_start only) is gone: the army warning (enemy-gathering.ts)
// announces every invasion wave instead, naming the threatened entrance — read
// from world state, with the AI's invasion_start only as its fallback.
//
// The other captions (dig, chamber, spider, foodMark, rally, rallyRaid,
// spiderPriority, queenDamage, queenStarvation, foodStorageNeeded,
// autosaveFailed) are one-shots and go through checkAndTrigger.

/**
 * A caption's text, without consulting or marking the one-shot `triggered` map:
 * for a recurring caption ('spiderRampage'), which comes once per hungry spell
 * rather than once per session. It returns the text on every call.
 */
export function captionText(key: CaptionKey): string {
  return CAPTION_TEXTS[key];
}
