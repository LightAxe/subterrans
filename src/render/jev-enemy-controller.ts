// jev-enemy-controller.ts — the Jev opponent: a render-layer policy that drives
// the enemy Colony through the player command surface, sitting beside the
// rule-based ai-controller.ts.
//
// Shape of one round:
//   phase 'opening' — replay the rule-based AI's own opening (jev-opening.ts)
//                     until Queen + Nursery + first FoodStorage are built.
//   phase 'live'    — every AI_DIG_INTERVAL ticks, mark frontier tiles in the
//                     direction Jev last chose; every `beatTicks` ticks, fire ONE
//                     request describing the world in words and asking for the
//                     next set of orders.
//
// The one structural rule: `onBeforeTick` is synchronous (the game loop's seam
// is), so the request is fire-and-forget. Its result is stashed by the promise
// handler and APPLIED on a later `onBeforeTick` — never inside the callback, so
// every world write still happens inside the tick seam. Candidates can go stale
// in that window (a food pile depletes, a frontier tile gets dug); tick.ts simply
// rejects the command, which the ledger records as `rejected`. That is the
// designed behavior, not an error path.
//
// Failure policy: any throw from the client — non-200, malformed body, network
// error, timeout — is one failed beat. Three consecutive failures flip `status`
// to 'fallback' permanently for the round: `onFallback()` fires once and
// `runAIController` takes over every tick. That works precisely because this
// controller never touches `world.aiState`, so the rule-based state machine has
// been quietly advancing in tick.ts the whole time and is ready to drive.
//
// Readiness probe: without one, the first request of any kind is the first live
// beat at handoff — 3-4 real minutes in, far too late to notice a dead
// endpoint. So the very first `onBeforeTick` call fires one lightweight probe
// (a single yes/no question whose answer is never read), and — while still in
// the opening — it repeats every `beatTicks` ticks until one succeeds, then
// stops (normal beats take over at handoff as before). A probe failure counts
// as a failed beat through the same `consecutiveFailures` counter as a real
// beat, so a dead endpoint now falls back to the rule-based AI ~15 s into the
// round instead of after handoff. A probe never stashes a decision and never
// counts toward `beats`.
//
// Wall-clock (`performance.now`, via the client's latency measurement) is fine
// here — this is the render layer. It would be a hard block in src/sim/.

import type { WorldState } from '../sim/types.js';
import type {
  ClearRallyPointCommand,
  MarkDigTileCommand,
  MarkFoodPileCommand,
  MarkSpiderPriorityCommand,
  PlaceChamberCommand,
  SetBehaviorRatioCommand,
  SetRallyPointCommand,
} from '../sim/commands.js';
import { ChamberType } from '../sim/enums.js';
import { AI_DIG_INTERVAL, AI_DIG_MARK_BUDGET, runAIController } from './ai-controller.js';
import { JevCommandLedger } from './jev-commands.js';
import { buildCandidates, computeFacts, digFrontier } from './jev-candidates.js';
import { decodeAnswers, encodeBeat, type JevQuestionMap } from './jev-encode.js';
import {
  createJevOpeningState,
  isHandoffComplete,
  runJevOpeningTick,
  type JevOpeningState,
} from './jev-opening.js';
import type { JevClient } from './jev-client.js';
import type {
  BucketMode,
  CandidateSet,
  Decision,
  DigDirection,
  PostureKey,
  RawFacts,
  Seats,
} from './jev-types.js';

/** Ticks between model beats. 100 ticks = 5 s at the fixed 20 Hz timestep. */
export const JEV_DEFAULT_BEAT_TICKS = 100;
/**
 * Consecutive failed beats before the rule-based AI takes over for the round.
 * A failed readiness probe counts as one, same as a failed real beat.
 */
export const JEV_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Readiness-probe payload: state carries no facts, and the one question is
 * shaped to pass the proxy's strict validation (only type/instructions/
 * criteria; ids matching `JEV_ID_PATTERN`). The answer is never read — only
 * whether the request itself succeeds matters.
 */
const JEV_PROBE_STATE: Record<string, unknown> = { probe: 'ping' };
const JEV_PROBE_QUESTIONS: JevQuestionMap = {
  ready: {
    type: 'noul',
    instructions: 'Reply yes.',
    criteria: { true: 'yes', false: 'no' },
  },
};

export type JevControllerStatus = 'jev' | 'fallback';

export interface JevEnemyControllerOptions {
  readonly seats: Seats;
  readonly client: JevClient;
  /** Standing orders; `''` sends no `standing_orders` field. */
  readonly orders: string;
  readonly beatTicks?: number;
  readonly buckets?: BucketMode;
  readonly maxConsecutiveFailures?: number;
  /** Fired exactly once, on the tick the controller gives up on Jev for this round. */
  readonly onFallback?: () => void;
}

interface StashedDecision {
  readonly decision: Decision;
  readonly candidates: CandidateSet;
}

export class JevEnemyController {
  readonly seats: Seats;
  readonly ledger = new JevCommandLedger();

  /** 'jev' until three consecutive beats fail; 'fallback' is sticky for the round. */
  status: JevControllerStatus = 'jev';
  phase: 'opening' | 'live' = 'opening';
  handoffTick: number | null = null;
  beats = 0;
  failedBeats = 0;
  /** Answers that were missing / mistyped / not a live candidate (diagnostic). */
  invalidAnswers = 0;
  lastLatencyMs: number | null = null;
  /**
   * Readiness probe state: null until the first `onBeforeTick` ever sends one,
   * 'pending' while it's in flight, then 'ok' or 'failed'. Once 'ok', no more
   * probes are sent for the round.
   */
  probe: 'pending' | 'ok' | 'failed' | null = null;
  digDirection: DigDirection = 'hold';
  currentPosture: PostureKey = 'recall';

  private readonly client: JevClient;
  private readonly orders: string;
  private readonly beatTicks: number;
  private readonly buckets: BucketMode;
  private readonly maxConsecutiveFailures: number;
  private readonly onFallback: (() => void) | undefined;

  private readonly opening: JevOpeningState = createJevOpeningState();
  private consecutiveFailures = 0;
  private inFlight = false;
  private stashed: StashedDecision | null = null;
  private prevFacts: RawFacts | null = null;
  private fallbackNotified = false;

  constructor(opts: JevEnemyControllerOptions) {
    this.seats = opts.seats;
    this.client = opts.client;
    this.orders = opts.orders;
    this.beatTicks = opts.beatTicks ?? JEV_DEFAULT_BEAT_TICKS;
    this.buckets = opts.buckets ?? 'coarse';
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? JEV_MAX_CONSECUTIVE_FAILURES;
    this.onFallback = opts.onFallback;
  }

  /** Called from the game loop's `onBeforeTick` seam. Synchronous by contract. */
  onBeforeTick(world: WorldState): void {
    // Classify what last tick's pushes actually did (diagnostic only).
    this.ledger.settle(world);

    const colony = world.colonies[this.seats.mySeat];
    if (colony === undefined || colony.defeated) return;

    if (this.status === 'jev' && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.status = 'fallback';
      if (!this.fallbackNotified) {
        this.fallbackNotified = true;
        this.onFallback?.();
      }
    }
    if (this.status === 'fallback') {
      // world.aiState was never touched, so the rule-based state machine picks up
      // mid-round exactly where tick.ts has been advancing it.
      runAIController(world, this.seats.mySeat);
      return;
    }

    // Readiness probe: the first onBeforeTick call ever sends one regardless of
    // phase; while still in the opening it repeats on the beat cadence until
    // one succeeds, then stops (see the file header for why).
    if (!this.inFlight) {
      if (this.probe === null) {
        this.startProbe();
      } else if (
        this.phase === 'opening' &&
        this.probe !== 'ok' &&
        world.tick % this.beatTicks === 0
      ) {
        this.startProbe();
      }
    }

    // Phase is derived from the world, not from a tick counter — a controller
    // created by bootFromSave lands in the right phase for the loaded save.
    if (this.phase === 'opening') {
      if (isHandoffComplete(world, this.seats.mySeat)) {
        this.phase = 'live';
        this.handoffTick = world.tick;
      } else {
        runJevOpeningTick(world, this.seats.mySeat, this.ledger, this.opening);
        return;
      }
    }

    // Apply whatever the last resolved beat decided. This is the ONLY place a
    // decision reaches the world.
    const stashed = this.stashed;
    if (stashed !== null) {
      this.stashed = null;
      this.applyDecision(world, stashed.decision, stashed.candidates);
    }

    if (world.tick % AI_DIG_INTERVAL === 0) this.executeDig(world);
    if (world.tick % this.beatTicks === 0 && !this.inFlight) this.startBeat(world);
  }

  /** Cadence executor: mark up to AI_DIG_MARK_BUDGET frontier tiles in the chosen direction. */
  private executeDig(world: WorldState): void {
    if (this.digDirection === 'hold') return;
    const tiles = digFrontier(world, this.seats.mySeat, this.digDirection);
    const n = Math.min(AI_DIG_MARK_BUDGET, tiles.length);
    for (let i = 0; i < n; i++) {
      const t = tiles[i]!;
      const cmd: MarkDigTileCommand = {
        type: 'MarkDigTile',
        colonyId: this.seats.mySeat,
        tileX: t.x,
        tileY: t.y,
        issuedAtTick: world.tick,
      };
      this.ledger.issue(world, cmd);
    }
  }

  /** Fire one beat. Never awaited — the result lands on a later tick seam. */
  private startBeat(world: WorldState): void {
    const facts = computeFacts(world, this.seats, this.currentPosture);
    if (facts === null) return;
    const cands = buildCandidates(world, this.seats, facts);
    const enc = encodeBeat(facts, cands, this.orders, this.buckets, this.prevFacts);
    this.prevFacts = facts;
    this.beats += 1;
    this.inFlight = true;
    void this.client
      .ask(enc.state, enc.questions)
      .then(
        (res) => {
          // `res.answers` came off the wire: decoding it must not be able to
          // take the page down. A throw in here is just another failed beat.
          try {
            const { decision, invalid } = decodeAnswers(res.answers, cands, facts);
            this.lastLatencyMs = res.latencyMs;
            this.invalidAnswers += invalid.length;
            this.stashed = { decision, candidates: cands };
            this.consecutiveFailures = 0;
          } catch {
            this.recordFailedBeat();
          }
        },
        () => {
          // Any rejection — non-200, timeout, network, non-JSON body — is one failed beat.
          this.recordFailedBeat();
        },
      )
      .finally(() => {
        this.inFlight = false;
      });
  }

  /**
   * Fire the one-off readiness probe. Reuses the exact in-flight/failure path
   * a real beat uses — a rejection is one failed beat — but it never decodes
   * an answer, never stashes a Decision, and never counts toward `beats`.
   */
  private startProbe(): void {
    this.probe = 'pending';
    this.inFlight = true;
    void this.client
      .ask(JEV_PROBE_STATE, JEV_PROBE_QUESTIONS)
      .then(
        (res) => {
          this.probe = 'ok';
          this.lastLatencyMs = res.latencyMs;
          this.consecutiveFailures = 0;
        },
        () => {
          this.probe = 'failed';
          this.recordFailedBeat();
        },
      )
      .finally(() => {
        this.inFlight = false;
      });
  }

  private recordFailedBeat(): void {
    this.failedBeats += 1;
    this.consecutiveFailures += 1;
  }

  /** Push ONLY what changes the colony's current setting (a re-push would be a no-op at best). */
  private applyDecision(world: WorldState, d: Decision, cands: CandidateSet): void {
    const colonyId = this.seats.mySeat;
    const colony = world.colonies[colonyId];
    if (colony === undefined) return;
    const tick = world.tick;

    const ratio = cands.ratio[d.ratio].ratio;
    if (colony.targetRatio.forage !== ratio.forage || colony.targetRatio.fight !== ratio.fight) {
      const cmd: SetBehaviorRatioCommand = {
        type: 'SetBehaviorRatio',
        colonyId,
        ratio: { ...ratio },
        issuedAtTick: tick,
      };
      this.ledger.issue(world, cmd);
    }

    const pc = cands.posture[d.posture];
    if (pc !== undefined) {
      if (pc.tile === null) {
        if (colony.rallyPoint !== null) {
          const cmd: ClearRallyPointCommand = {
            type: 'ClearRallyPoint',
            colonyId,
            issuedAtTick: tick,
          };
          this.ledger.issue(world, cmd);
        }
      } else if (
        colony.rallyPoint === null ||
        colony.rallyPoint.tileX !== pc.tile.x ||
        colony.rallyPoint.tileY !== pc.tile.y
      ) {
        const cmd: SetRallyPointCommand = {
          type: 'SetRallyPoint',
          colonyId,
          tileX: pc.tile.x,
          tileY: pc.tile.y,
          issuedAtTick: tick,
        };
        this.ledger.issue(world, cmd);
      }
      this.currentPosture = d.posture;
    }

    this.digDirection = d.dig;

    const fp = cands.foodPriority[d.foodPriority];
    if (fp !== undefined && fp.pileId !== colony.priorityFoodPileId) {
      // MarkFoodPile TOGGLES in tick.ts: marking a different pile selects it,
      // re-marking the currently-priority pile clears it. So "no priority" is
      // expressed by re-marking the pile that is currently priority.
      let tile = fp.tile;
      if (fp.pileId === null) {
        const cur = world.foodPiles.find((p) => p.foodPileId === colony.priorityFoodPileId);
        tile = cur === undefined ? null : { x: cur.tileX, y: cur.tileY };
      }
      if (tile !== null) {
        const cmd: MarkFoodPileCommand = {
          type: 'MarkFoodPile',
          colonyId,
          tileX: tile.x,
          tileY: tile.y,
          issuedAtTick: tick,
        };
        this.ledger.issue(world, cmd);
      }
    }

    if (d.spiderPriority !== null) {
      const ours = world.spiderPriorityColonyId === colonyId;
      if (d.spiderPriority !== ours) {
        const cmd: MarkSpiderPriorityCommand = {
          type: 'MarkSpiderPriority',
          colonyId,
          isPriority: d.spiderPriority,
          issuedAtTick: tick,
        };
        this.ledger.issue(world, cmd);
      }
    }

    if (d.expandStorage === true && cands.expandStorage !== null) {
      const cmd: PlaceChamberCommand = {
        type: 'PlaceChamber',
        colonyId,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: cands.expandStorage.anchor.x,
        anchorTileY: cands.expandStorage.anchor.y,
        issuedAtTick: tick,
      };
      this.ledger.issue(world, cmd);
    }
  }
}
