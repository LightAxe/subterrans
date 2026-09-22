// src/sim/commands.ts
// SimCommand discriminated union and command queue constants.
// Phase 5 union is NoOpCommand only; Phase 6 expands to 4-variant union.
// Phase 7 adds 3 variants: CancelDigMark, PlaceChamber, DesignateEntrance.

import type { ColonyId, BehaviorRatio } from './colony/colony-store.js';
import type { AIState, WorldState } from './types.js';
import type { ChamberType } from './enums.js';

/**
 * #230 — provenance of a queued command, stamped by pushCommand. Phase 7 netcode
 * will BROADCAST 'player' input, ASSIGN AUTHORITY for 'ai' policy output, and
 * LOCALLY REGENERATE (never broadcast) 'sim' self-emits. Pure metadata today — no
 * handler branches on it, so replay ignores it and it needs no simVersion bump.
 */
export type CommandOrigin = 'player' | 'ai' | 'sim';

export interface SimCommandBase {
  readonly issuedAtTick: number; // tick-stamped per PRD §5
  /** #230 — stamped by pushCommand; ABSENT on pre-provenance logs. Kept optional
   *  forever (old inputLogs must keep loading) and non-readonly (only pushCommand
   *  writes it, post-construction). */
  origin?: CommandOrigin;
  /** #296 — the tick on which the platform loop drained this command out of the
   *  queue, i.e. the tick `tick()` actually received it. Written by
   *  {@link stampDrainTick}, the drain-side twin of the push-side `origin` stamp
   *  above: `pushCommand` marks a command on the way INTO the queue,
   *  `stampDrainTick` marks the batch on the way OUT, and both live here because
   *  command metadata is only ever written from `src/sim/`. A recorded inputLog
   *  therefore carries the batch boundaries the sim saw, instead of forcing a
   *  replay to guess them from `issuedAtTick` (which is one tick early for sim
   *  self-emits). Pure metadata like `origin`: no handler branches on it, replay
   *  ignores it, no simVersion bump. ABSENT on logs recorded before this
   *  existed — see src/platform/input-log-replay.ts for the fallback. */
  drainTick?: number;
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
 * S2 / V17 — snapshot of one AIStateRecord. runAIController used to push one whenever a
 * field changed so the snapshot analyzer's tick()-only replay could reproduce
 * world.aiState. #258 retired that emission: advanceAIState, the StartAIOperation
 * handler and the combat death counters reproduce it unaided (pinned by
 * src/render/ai-controller-replay-parity.integration.test.ts). The variant and the
 * tick.ts pre-pass applier stay so inputLogs recorded before the retirement still
 * replay byte-identically. operationFighterIds is serialized as number[] (JSON-safe;
 * reconstructed as Int32Array in the handler).
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
 * C1 (V42) — the player sounds or clears the colony alarm ("recall to nest").
 * tick() ignores it below V42; `active` is validated as a boolean because
 * replayed/saved command objects are not schema-checked upstream.
 */
export interface SetColonyAlarmCommand extends SimCommandBase {
  readonly type: 'SetColonyAlarm';
  readonly colonyId: number;
  readonly active: boolean;
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
  | MarkSpiderPriorityCommand
  | SetColonyAlarmCommand;

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
export function pushCommand(world: WorldState, cmd: SimCommand, origin: CommandOrigin): boolean {
  cmd.origin = origin; // in-place stamp — allocation-free; every producer hands a freshly-built literal
  // eslint-disable-next-line no-restricted-syntax -- the single sanctioned commandQueue.push chokepoint (#230)
  world.commandQueue.push(cmd);
  return true;
}

/**
 * #296 — the drain-side twin of {@link pushCommand}'s `origin` stamp. Records,
 * on every command in a just-drained batch, the tick the simulation actually
 * received it on.
 *
 * It lives here rather than in the platform loop that calls it because command
 * METADATA is sim-owned: `pushCommand` is the only sanctioned writer on the way
 * into the queue, and this is the only sanctioned writer on the way out. A
 * drained command is still a simulation object — it is aliased from
 * `prevState.commandQueue`, since `copyWorldState` copies the queue with a
 * shallow `.slice()` — so `src/platform/` writing to it would be a boundary
 * violation (AGENTS.md: platform "must not mutate WorldState or any nested
 * simulation store"). Exposing the operation here keeps the caller honest and
 * the write inside `src/sim/`.
 *
 * Same properties as `origin`, for the same reason: pure metadata, no tick
 * handler branches on it, it never reaches serialized state (a command sitting
 * in `commandQueue` has by definition not been drained, so the stamp cannot
 * appear in a snapshot's queue), replay ignores it, and it needs no
 * `simVersion` bump.
 *
 * The ARRAY is not modified — only each element's `drainTick` field is — so a
 * `readonly` batch is accepted and the platform loop can hand over the result
 * of `commandQueue.splice(0)` directly. In-place like the `origin` stamp: no
 * allocation on a per-tick path.
 */
export function stampDrainTick(cmds: readonly SimCommand[], drainTick: number): void {
  for (const c of cmds) c.drainTick = drainTick;
}
