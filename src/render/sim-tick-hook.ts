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
 *   4. the prevState snapshot for render interpolation.
 */
export function beforeSimTick(
  world: WorldState,
  aiColonyIds: readonly ColonyId[],
  rampageCaption: RampageCaptionState,
  viewerColonyId: ColonyId,
  prevState: WorldState,
  queenDanger: QueenDangerState,
): void {
  for (const aiCid of aiColonyIds) runAIController(world, aiCid);
  noteRampageThreat(rampageCaption, world, viewerColonyId, prevState);
  noteQueenDangerTick(queenDanger, world, viewerColonyId);
  copyWorldState(world, prevState);
}
