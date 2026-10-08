// enemy-queen-wound.ts — #427: "Their queen is wounded!" once per wound spell.
//
// Since #415 the enemy queen heals at the ant rate (1 HP per 40 ticks while fed and
// safe, about 1½ minutes from near death to full), so a player who wounds her has
// time to finish her off. Playtest 4 found that never happened: the player could not
// see her HP. The enemy-nest view now draws her HP bar (draw-underground.ts); this
// caption tells a player who is looking elsewhere (the surface, the fight at her door)
// that she is down below half — from blows, or from a starvation drain (a queen that
// cannot eat loses HP too, health.ts / QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS).
//
// THE RULE. She is judged only in her nest — on her home ground (health.ts
// antOnHomeGround), where the enemy-nest view draws her bar — against her max HP there
// (antMaxHp: QUEEN_HP_HOME, 50; the rule is written for any max), with integer math:
//   - WOUNDED: below half her max HP (2 × hp < max; 24 or less of 50). That starts a
//     wound spell, if none is on; while one is on and the caption is armed, it fires
//     (checkAndTrigger marks it shown).
//   - HEALED: back to at least three quarters of her max HP (4 × hp ≥ 3 × max; 38 of
//     50). That ends the wound spell and re-arms the caption (untrigger).
//   - Between the two (25–37 of 50) nothing changes: a queen hovering at the half
//     line, healing a point and losing it again, stays in one spell.
// So it fires once per wound spell. Spam is bounded by the sim's healing: a new
// spell needs her to heal from below half to three quarters, at least 14 HP at
// 1 HP per QUEEN_HEAL_INTERVAL_TICKS, each only after HEAL_SAFE_TICKS without a blow
// (about 33 s of calm from 24 HP): no fight that keeps landing blows on her can
// re-raise it. A follow-up raid that finds her mostly healed (the playtest's came
// 90 s later, at 47/50) and wounds her again is a new spell, and is announced.
//
// It is about the viewing colony's opponent (ai-state.ts opponentColonyId: "their"
// queen). The game has no fog of war — the X toggle shows the enemy's nest, and her,
// at any time — and her HP is the stat her bar shows there, so the caption reveals a
// stat of an entity the player can already inspect at any time, nothing her bar does
// not. Before she founds her nest she stands on the surface, where no bar is drawn:
// no look there decides anything (a wound taken there is announced once she is home,
// if she is still below half then), and stepping off home ground, which lowers her
// max HP, can neither raise nor re-arm it.
//
// It DECIDES per sim tick and PRESENTS per render frame, as the queen-danger caption
// does since #418 (queen-danger.ts): a frame can run up to MAX_CATCHUP_TICKS ticks,
// and every tick's end state gets one look — sim-tick-hook.ts beforeSimTick looks
// before each tick (the world as the previous tick left it), and GameScene's frame
// step looks at the frame's last tick. The look decides the caption (or the re-arm)
// as of its own tick; the frame step presents what was decided. The rule reads only
// the queen's state at the look, so the decisions are the same however the ticks
// are batched (enemy-queen-wound.test.ts pins it against a per-tick model). One
// accepted exception, in the presentation, as queen-danger.ts has: whether it is armed
// lives in the one-shot registry, which is un-marked between looks for a caption that
// never displayed — by UIScene when the queue drops or evicts it, or withdraws it, and
// by GameScene when it holds it back (below) — so such a caption is offered again from
// the next look, for as long as her wound spell lasts (even once she has healed back
// to half), a retry whose timing follows the frames.
//
// Never while the round is over or paused: a look decides nothing once either queen
// is dead, and the frame step then presents nothing (an owed caption is dropped). Any
// other round end (a stalemate tiebreak, both queens alive) is covered by GameScene's
// GameOver gate: it runs the frame step only while Playing (not Paused, not GameOver),
// the game loop stops at the terminal tick, the sim ticks (and so the per-tick looks)
// not at all while paused, and UIScene admits no caption after the end screen
// (closeCaptions).
//
// In the caption queue it is RETRYABLE (onboarding-captions.ts captionKeyRetries):
// its look offers it again on every tick of her wound spell while it is armed, so if
// the queue drops it, or (waiting in the pending slot) an event caption evicts it,
// UIScene un-marks its key and it simply comes back — it never costs a one-shot
// caption its slot. Like the storage hint, it also gives way to a recurring caption
// still owed (the army or rampage warning, raid news: recurring-captions.ts), which
// can enter only an idle queue: while one is owed GameScene holds it back
// (advanceEnemyQueenWound's `holdBack`, which un-marks it to come back the same way)
// and withdraws it from the pending slot, so the owed caption comes first.
//
// Render-side session state only; nothing is saved. Pure + Phaser-free: GameScene
// owns the state (reset with the session) and calls advanceEnemyQueenWound each frame.

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { antMaxHp, antOnHomeGround } from '../sim/health.js';
import { opponentColonyId } from '../sim/ai-state.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';

/** Wounded: HP below WOUND_NUM / WOUND_DEN (½) of her max HP. */
export const WOUND_NUM = 1;
export const WOUND_DEN = 2;
/** Healed (the spell ends, the caption re-arms): HP at least HEALED_NUM / HEALED_DEN (¾) of her max HP. */
export const HEALED_NUM = 3;
export const HEALED_DEN = 4;

/** Where `hp` of `maxHp` stands against the rule. */
export type WoundLevel = 'wounded' | 'between' | 'healed';

/** `hp` of `maxHp`: wounded (below ½), healed (at least ¾), or between. Integer math. */
export function woundLevel(hp: number, maxHp: number): WoundLevel {
  if (hp * WOUND_DEN < maxHp * WOUND_NUM) return 'wounded';
  if (hp * HEALED_DEN >= maxHp * HEALED_NUM) return 'healed';
  return 'between';
}

export interface EnemyQueenWoundState {
  /** A wound spell is on: a look has seen her below half since one last saw her back
   *  to three quarters (see the header). */
  inSpell: boolean;
  /** Owed to the next frame step: the caption, decided at a look; null if none. */
  captionOwed: string | null;
}

export function createEnemyQueenWoundState(): EnemyQueenWoundState {
  return { inSpell: false, captionOwed: null };
}

/** What one look decided. */
export type WoundLook = 'caption' | 'rearm' | 'nothing';

/**
 * The rule for one look at her HP (see the header): a wounded queen starts a wound
 * spell; a healed one ends it and re-arms the caption (untrigger). While a spell is
 * on, the caption fires if it is armed (checkAndTrigger('enemyQueenWounded') — the
 * one-shot registry holds whether it is armed, and is un-marked for a caption that
 * never displayed, so that one is offered again for the rest of the spell). The
 * caption text, when decided, is owed to the next frame step.
 */
export function stepEnemyQueenWound(
  state: EnemyQueenWoundState,
  hp: number,
  maxHp: number,
): WoundLook {
  const level = woundLevel(hp, maxHp);
  if (level === 'healed') {
    state.inSpell = false;
    untrigger('enemyQueenWounded');
    return 'rearm';
  }
  if (level === 'wounded') state.inSpell = true;
  if (!state.inSpell) return 'nothing';
  const caption = checkAndTrigger('enemyQueenWounded');
  if (caption === null) return 'nothing';
  state.captionOwed = caption;
  return 'caption';
}

/**
 * The queen the viewing colony `viewerColonyId` would call "their queen" — its
 * opponent's — as an entity id, or null once either queen is dead or there is no
 * opponent.
 */
function theirLiveQueen(world: WorldState, viewerColonyId: ColonyId): number | null {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined || !isAlive(world.ants, viewer.queenEntityId)) return null;
  const oppId = opponentColonyId(world, viewerColonyId);
  const opp = oppId === null ? undefined : world.colonies[oppId];
  if (opp === undefined || !isAlive(world.ants, opp.queenEntityId)) return null;
  return opp.queenEntityId;
}

/**
 * One look at the opponent's queen in `world` (stepEnemyQueenWound), as of world.tick.
 * Decides nothing once the round is over (theirLiveQueen null), nor while she is off
 * her home ground (no bar is drawn for her there; see the header).
 */
function lookAtTheirQueen(
  state: EnemyQueenWoundState,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  const q = theirLiveQueen(world, viewerColonyId);
  if (q === null || !antOnHomeGround(world, q)) return;
  stepEnemyQueenWound(state, world.ants.hp[q] ?? 0, antMaxHp(world, q));
}

/**
 * sim-tick-hook.ts beforeSimTick's look before each sim tick, so every tick's end
 * state is decided on its own however many ticks the render frame runs.
 */
export function noteEnemyQueenWoundTick(
  state: EnemyQueenWoundState,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  lookAtTheirQueen(state, world, viewerColonyId);
}

/**
 * GameScene's per-frame step (only while Playing): one look at the frame's last tick,
 * then the caption the looks since the last frame decided, if any (cleared once
 * returned). Null once either queen is dead, dropping any caption still owed (any other
 * round end stops GameScene calling it).
 * `holdBack` (a recurring caption is owed, or there is no UIScene to show it): a
 * caption decided is not shown now but un-marked, so the next look offers it again
 * while her wound spell lasts.
 */
export function advanceEnemyQueenWound(
  state: EnemyQueenWoundState,
  world: WorldState,
  viewerColonyId: ColonyId,
  holdBack = false,
): string | null {
  if (theirLiveQueen(world, viewerColonyId) === null) {
    state.captionOwed = null;
    return null;
  }
  lookAtTheirQueen(state, world, viewerColonyId);
  const caption = state.captionOwed;
  state.captionOwed = null;
  if (caption !== null && holdBack) {
    untrigger('enemyQueenWounded');
    return null;
  }
  return caption;
}
