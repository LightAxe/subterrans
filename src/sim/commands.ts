// src/sim/commands.ts
// SimCommand discriminated union and command queue constants.
// Phase 5 union is NoOpCommand only; Phase 6 expands to 4-variant union.
// Phase 7 adds 3 variants: CancelDigMark, PlaceChamber, DesignateEntrance.

import type { ColonyId, BehaviorRatio } from './colony/colony-store.js';
import type { AIState, WorldState } from './types.js';
import type { ChamberType } from './enums.js';

export interface SimCommandBase {
  readonly issuedAtTick: number; // tick-stamped per PRD §5
}

export interface NoOpCommand extends SimCommandBase {
  readonly type: 'NoOp';
}

/** PRD §7g — player-issued behavior ratio change for a colony. */
export interface SetBehaviorRatioCommand extends SimCommandBase {
  readonly type: 'SetBehaviorRatio';
  readonly colonyId: ColonyId;
  readonly ratio: BehaviorRatio;
}

/** PRD §7g — player marks a tile for digging. Tile coordinates are integer, not fixed-point. */
export interface MarkDigTileCommand extends SimCommandBase {
  readonly type: 'MarkDigTile';
  readonly colonyId: ColonyId;
  readonly tileX: number;
  readonly tileY: number;
}

/** PRD §7g — player marks a food pile location. Tile coordinates are integer, not fixed-point. */
export interface MarkFoodPileCommand extends SimCommandBase {
  readonly type: 'MarkFoodPile';
  readonly colonyId: ColonyId;
  readonly tileX: number;
  readonly tileY: number;
}

/** PRD §3b — player cancels a previously-marked dig tile. */
export interface CancelDigMarkCommand extends SimCommandBase {
  readonly type: 'CancelDigMark';
  readonly colonyId: ColonyId;
  readonly tileX: number;
  readonly tileY: number;
}

/** PRD §3e — player places a chamber at a tunnel end. */
export interface PlaceChamberCommand extends SimCommandBase {
  readonly type: 'PlaceChamber';
  readonly colonyId: ColonyId;
  readonly chamberType: ChamberType;
  readonly anchorTileX: number; // top-left tile X (accepted Phase 3 PRD command shape)
  readonly anchorTileY: number; // top-left tile Y
}

/** PRD §3g — player designates a new nest entrance from the surface. */
export interface DesignateEntranceCommand extends SimCommandBase {
  readonly type: 'DesignateEntrance';
  readonly colonyId: ColonyId;
  readonly surfaceTileX: number;
  readonly surfaceTileY: number;
}

/** PRD §4 / SURF-04 — player sets a rally point at a surface tile for fight-assigned ants. */
export interface SetRallyPointCommand extends SimCommandBase {
  readonly type: 'SetRallyPoint';
  readonly colonyId: ColonyId;
  readonly tileX: number;
  readonly tileY: number;
}

/** PRD §4 / SURF-04 — player clears the existing rally point for a colony. */
export interface ClearRallyPointCommand extends SimCommandBase {
  readonly type: 'ClearRallyPoint';
  readonly colonyId: ColonyId;
}

/**
 * S2 / V17 — snapshot of one AIStateRecord pushed to commandQueue by runAIController
 * every tick in the V17 path. tick() applies it so the snapshot analyzer's replay-only
 * path (which never calls runAIController) produces bit-identical world.aiState.
 * operationFighterIds is serialized as number[] (JSON-safe; reconstructed as Int32Array
 * in the handler).
 */
export interface SyncAIStateCommand extends SimCommandBase {
  readonly type: 'SyncAIState';
  readonly colonyId: ColonyId;
  readonly state: AIState;
  readonly enteredTick: number;
  readonly probeCount: number;
  readonly lastProbeEndTick: number;
  readonly invasionStartTick: number;
  readonly invasionRallyTileX: number;
  readonly invasionRallyTileY: number;
  readonly recoveryEndTick: number;
  readonly operationKind: 'None' | 'Probe' | 'Invasion';
  readonly operationStartTick: number;
  readonly operationTargetTileX: number;
  readonly operationTargetTileY: number;
  readonly operationFighterIds: readonly number[];
  readonly operationFighterCount: number;
  readonly operationStartFighterCount: number;
  readonly operationAttackerDeaths: number;
  readonly operationDefenderDeaths: number;
}

/** S3 — a colony marks the spider as a priority target; fighters route toward it. */
export interface MarkSpiderPriorityCommand extends SimCommandBase {
  readonly type: 'MarkSpiderPriority';
  readonly colonyId: number;
  readonly isPriority: boolean;
}

/**
 * S2 / V19 — AI controller signals a probe or invasion entry by pushing this command
 * instead of mutating world.aiState directly. tick() applies it via setAIRallyOperation,
 * keeping all world.aiState writes inside the sim layer (ADR-0007).
 */
export interface StartAIOperationCommand extends SimCommandBase {
  readonly type: 'StartAIOperation';
  readonly colonyId: ColonyId;
  readonly kind: 'Probe' | 'Invasion';
  readonly rallyTileX: number;
  readonly rallyTileY: number;
  readonly fighterIds: readonly number[];
}

export type SimCommand =
  | NoOpCommand
  | SetBehaviorRatioCommand
  | MarkDigTileCommand
  | MarkFoodPileCommand
  | CancelDigMarkCommand
  | PlaceChamberCommand
  | DesignateEntranceCommand
  | SetRallyPointCommand
  | ClearRallyPointCommand
  | SyncAIStateCommand
  | StartAIOperationCommand
  | MarkSpiderPriorityCommand;

export const MAX_COMMANDS_PER_TICK = 64; // PRD §5 line 680 — FIFO silent-drop beyond cap

/**
 * #230 — the single sanctioned `commandQueue.push` chokepoint. EVERY producer
 * (player input via enqueueCommand, the render AI controller, and sim self-emits)
 * routes through here so the queue has one provenance seam for Phase 7 netcode. A
 * lint rule (eslint.config.ts) bans raw `world.commandQueue.push` everywhere else.
 *
 * Returns a boolean that always resolves `true` today — it reserves the Phase-7
 * reject signature (per-producer budgets / an ack channel) without implementing it,
 * so no caller yet needs to handle a refusal. Pure pass-through: byte-identical replay.
 */
export function pushCommand(world: WorldState, cmd: SimCommand): boolean {
  // eslint-disable-next-line no-restricted-syntax -- the single sanctioned commandQueue.push chokepoint (#230)
  world.commandQueue.push(cmd);
  return true;
}
