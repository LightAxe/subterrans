// sim-tick-hook.ts — what GameScene runs before every sim tick (the game loop's
// onBeforeTick), kept out of the Phaser scene so it can be tested under Node.
//
// The game loop runs up to MAX_CATCHUP_TICKS ticks in one render frame (4x speed,
// a stalled frame), and GameScene's per-frame checks see only the world as the
// last of them left it. Anything that must not miss a state lasting a single tick
// is observed here instead, once per tick, on the world as the previous tick left
// it (with the per-frame check covering the frame's last tick). Before the
// interpolation snapshot is re-taken it still holds the world before that tick,
// so a state seen only mid-tick can be read from the pair (the rampage warning:
// recurring-captions.ts rampageThreatenedViewerLastTick).
//
// Render-side: reads the world (the AI controller only enqueues commands, as
// before), writes only render state and the interpolation snapshot.

import { copyWorldState, type WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { runAIController } from './ai-controller.js';
import { noteRampageThreat, type RampageCaptionState } from './recurring-captions.js';
import { noteQueenDangerTick, type QueenDangerState } from './queen-danger.js';
import { noteEnemyQueenWoundTick, type EnemyQueenWoundState } from './enemy-queen-wound.js';
import { noteCounterAttackTick, type CounterAttackCaptionState } from './counter-attack-caption.js';
import type { ArmyWarningState } from './army-warning.js';
import { noteStoresFillingTick, type StoresFillingCaptionState } from './stores-filling-caption.js';
import type { StorageHintState } from './storage-hint.js';

/** The render-side caption states `beforeSimTick` advances on every sim tick. */
export interface BeforeTickCaptions {
  readonly rampage: RampageCaptionState;
  readonly queenDanger: QueenDangerState;
  readonly enemyQueenWound: EnemyQueenWoundState;
  readonly counterAttack: CounterAttackCaptionState;
  readonly storesFilling: StoresFillingCaptionState;
  /** Read for whether an army warning's wave is under way (#435), when the
   *  stores-filling caption stays quiet. */
  readonly armyWarning: ArmyWarningState;
  /** Read for the storage hint's last offer, which the stores-filling caption follows. */
  readonly storageHint: StorageHintState;
}

/**
 * Before each sim tick, in order:
 *   1. every AI colony's controller (its commands are enqueued before the drain);
 *   2. #397 — the rampage warning's threat check (noteRampageThreat) on the world as
 *      the last tick left it, so a threat to `viewerColonyId` that lasts one tick
 *      inside a multi-tick frame, not its last (a camp that a chase divert ends a
 *      tick later), still owes the warning; and, with `prevState` still the world
 *      before that tick, on the threat as that tick's rampage shelter saw it (an
 *      entrance it opened, by a spider it then moved out of reach);
 *   3. #416 review — the queen-danger tracker's look at `viewerColonyId`'s queen
 *      (noteQueenDangerTick): it decides that tick's harm and re-arm on the tick's own
 *      end state, so the outcome does not depend on how many ticks the frame runs
 *      (GameScene's frame step only presents what was decided);
 *   4. #427 — the same per-tick look at the viewer's opponent's queen for "Their
 *      queen is wounded!" (noteEnemyQueenWoundTick): the caption and its re-arm are
 *      decided on each tick's own end state;
 *   5. (playtest 4) the counter-attack caption's follow-up look
 *      (noteCounterAttackTick): after its "train more fighters" copy, the Assault copy
 *      is owed the first tick the viewer's army is ready, decided on that tick's own
 *      end state;
 *   6. (economy captions) the stores-filling caption's look at the viewer's colony
 *      (noteStoresFillingTick), so its dwell and cooldown run on world ticks; with the
 *      storage hint's last offer (`captions.storageHint`), which it does not follow
 *      within its cooldown, and the army warning (`captions.armyWarning`), during whose
 *      wave it stays quiet (#435);
 *   7. the prevState snapshot for render interpolation.
 */
export function beforeSimTick(
  world: WorldState,
  aiColonyIds: readonly ColonyId[],
  viewerColonyId: ColonyId,
  prevState: WorldState,
  captions: BeforeTickCaptions,
): void {
  for (const aiCid of aiColonyIds) runAIController(world, aiCid);
  noteRampageThreat(captions.rampage, world, viewerColonyId, prevState);
  noteQueenDangerTick(captions.queenDanger, world, viewerColonyId);
  noteEnemyQueenWoundTick(captions.enemyQueenWound, world, viewerColonyId);
  noteCounterAttackTick(captions.counterAttack, world, viewerColonyId);
  noteStoresFillingTick(
    captions.storesFilling,
    world,
    viewerColonyId,
    captions.storageHint.lastOfferedTick,
    captions.armyWarning,
  );
  copyWorldState(world, prevState);
}
