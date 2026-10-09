// jev-enemy-controller.ts — the Jev opponent: a render-layer policy that drives
// the enemy Colony through the player command surface, sitting beside the
// rule-based ai-controller.ts.
//
// Shape of one round:
//   phase 'opening' — run the code-owned nest planner (jev-opening.ts) until
//                     Queen + Nursery + first FoodStorage are PLACED. That is a
//                     couple of ticks, not a couple of thousand: the chambers
//                     are committed as pending and the colony's one digger
//                     excavates them in the background, right through the live
//                     phase. Handing off on "placed" rather than "built" is what
//                     gives Jev the opening minutes of the round instead of
//                     making it watch a build order play itself out.
//   phase 'live'    — every AI_DIG_INTERVAL ticks, mark frontier tiles in the
//                     direction Jev last chose; every `beatTicks` ticks (twice
//                     that at 4×, so a beat is never under 2.5 s of wall clock
//                     after the last: beatPaceFactor), fire ONE request
//                     describing the world in words. The proxy builds the
//                     beat's questions from that state and answers them.
//                     `digDirection` starts at 'hold' precisely so the one
//                     digger finishes the planned nest before Jev spends it on a
//                     frontier; Jev can change that on any beat. Frontier marks
//                     can never collide with a pending footprint either way:
//                     `digFrontier` only returns Solid tiles and PlaceChamber
//                     already flipped every footprint tile to Marked.
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
// endpoint. So the very first `onBeforeTick` call mints the proxy session — the
// cheapest request there is, and one the round needs anyway — and, while still
// in the opening, repeats every `beatTicks` ticks until one succeeds, then stops
// (normal beats take over at handoff as before). A failed mint counts as a
// failed beat through the same `consecutiveFailures` counter as a real beat, so
// a dead endpoint now falls back to the rule-based AI ~15 s into the round
// instead of after handoff. A probe never stashes a decision and never counts
// toward `beats`; the session it leaves behind is the one the first real beat
// uses, and the client re-mints on its own once that session expires or the
// proxy retires it.
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
import { AntTask, ChamberType, RaidType } from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import { rallyEnemyEntrance } from '../sim/raid-order.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { pileSlotById, pileTileX, pileTileY } from '../sim/food/food-api.js';
import { AI_DIG_INTERVAL, AI_DIG_MARK_BUDGET, runAIController } from './ai-controller.js';
import { MS_PER_TICK } from '../platform/game-loop.js';
import { JevCommandLedger } from './jev-commands.js';
import { buildCandidates, computeFacts, digFrontier, manhattan } from './jev-candidates.js';
import { decodeAnswers, encodeBeat } from './jev-encode.js';
import {
  createJevOpeningState,
  isOpeningPlanned,
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
 * Playtest 5 (#436) — the least wall clock (ms) between two beats. The proxy refuses a
 * beat that comes within 2 s of the session's last one (`too_fast`, the Lambda's
 * MIN_BEAT_INTERVAL_MS) and counts it as a failed beat here. 100 ticks is 5 s at 1×
 * and 2.5 s at 2×, but 1.25 s at 4×, so every other beat was refused. 2.5 s between
 * SENDS leaves 0.5 s for the two requests' arrival times at the proxy to differ by
 * (network jitter, a cold start on the first); a beat that still lands inside 2 s is
 * one failed beat, reset by the next success, so it takes three such in a row to
 * fall back.
 */
export const JEV_MIN_BEAT_WALL_MS = 2500;

/**
 * How many default beat intervals one beat spans at game speed `speed` (1, 2 or 4)
 * so that a beat is never less than JEV_MIN_BEAT_WALL_MS of wall clock after the last:
 * 1 at 1× (5 s) and 2× (2.5 s), 2 at 4× (200 ticks, 2.5 s). Measured against the
 * DEFAULT beat (JEV_DEFAULT_BEAT_TICKS), so a custom `beatTicks` (a test knob) is only
 * scaled at the speeds that need it. The per-session beat budget (320) then lasts at
 * least 13 minutes of wall clock at any speed before the client re-mints.
 */
export function beatPaceFactor(speed: number): number {
  const wallMs = (JEV_DEFAULT_BEAT_TICKS * MS_PER_TICK) / Math.max(1, speed);
  return Math.max(1, Math.ceil(JEV_MIN_BEAT_WALL_MS / wallMs));
}
/**
 * Consecutive failed beats before the rule-based AI takes over for the round.
 * A failed readiness probe counts as one, same as a failed real beat.
 */
export const JEV_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Playtest 5 (#436) — the muster. Jev's `assault` used to move the rally to their door
 * the beat it was first given, when only 2–4 fighters existed (Balanced switches to
 * "mostly fighters" on the same beat); the rest trickled in as they were drafted, and
 * the median onset was 3 Jev fighters against 11 defenders. Mustered (the rally held
 * on our own entrance until at least JEV_MUSTER_MIN_FIGHTERS fighters exist and
 * JEV_MUSTER_HOME_PCT of them are home), onset became 14–18 against 7–9, and at
 * colony parity the queen-kill rate rose from 31–47 % to 58–59 % (RESULTS.md B1
 * rule 4; reference: the JEV_MUSTER scratch knob, 14 / 80 %). Those rates were
 * measured on the scratch knob, which differs in two details: it counted every
 * underground fighter as home (here one inside an enemy nest is away) and bypassed
 * the muster only with the rally on the exact assault tile (here on any opponent
 * entrance). The refresh's re-measurement is in the jev-v74 handback notes.
 */
export const JEV_MUSTER_MIN_FIGHTERS = 14;
/** Share of our fighters (percent) that must be home before a mustered assault goes. */
export const JEV_MUSTER_HOME_PCT = 80;
/** A fighter on the surface within this many tiles (Manhattan) of our entrance — the
 *  first open one, where guard_home rallies (a Jev colony has one) — is home. */
export const JEV_MUSTER_HOME_RADIUS_TILES = 12;

/**
 * Our fighters, and how many of them are home: underground in our own nest, or on the
 * surface within JEV_MUSTER_HOME_RADIUS_TILES of `home` (our entrance, where
 * `guard_home` rallies them). A fighter still inside an enemy nest is away.
 * "Fighters" are what the sim calls the army (aiFighterCount): every living ant of
 * the colony on the Fighting task, wherever it is.
 */
export function musterCount(
  world: WorldState,
  colonyId: ColonyId,
  home: { readonly x: number; readonly y: number },
): { fighters: number; home: number } {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return { fighters: 0, home: 0 };
  const a = world.ants;
  let fighters = 0;
  let atHome = 0;
  for (const id of colony.workers) {
    if (a.alive[id] !== 1 || a.task[id] !== AntTask.Fighting) continue;
    fighters += 1;
    if (a.zone[id] === Zone.Underground) {
      if (a.currentGridColonyId[id] === colonyId) atHome += 1;
    } else if (
      manhattan(a.posX[id]! >> FP_SHIFT, a.posY[id]! >> FP_SHIFT, home.x, home.y) <=
      JEV_MUSTER_HOME_RADIUS_TILES
    ) {
      atHome += 1;
    }
  }
  return { fighters, home: atHome };
}

/**
 * The posture to apply for Jev's answer `asked`. Only `assault` is ever changed: while
 * our rally is not already on an opponent entrance (an assault under way follows
 * Jev's answers as given, including a retarget to another of their entrances), it is
 * held as `guard_home` — the rally on our own entrance, so the army gathers there —
 * until at least JEV_MUSTER_MIN_FIGHTERS fighters exist and at least
 * JEV_MUSTER_HOME_PCT % of them are home (musterCount). A colony that cannot raise
 * that many fighters therefore guards instead of trickling into their nest. Pure read.
 */
export function musteredPosture(
  world: WorldState,
  colonyId: ColonyId,
  asked: PostureKey,
  cands: CandidateSet,
): PostureKey {
  if (asked !== 'assault') return asked;
  const guard = cands.posture.guard_home;
  const colony = world.colonies[colonyId];
  // buildCandidates offers `assault` only beside `guard_home`; without it there is
  // nowhere to gather, so the answer stands.
  if (guard === undefined || guard.tile === null || colony === undefined) return asked;
  if (rallyEnemyEntrance(world, colony) !== null) return asked;
  const { fighters, home } = musterCount(world, colonyId, guard.tile);
  const mustered =
    fighters >= JEV_MUSTER_MIN_FIGHTERS && home * 100 >= fighters * JEV_MUSTER_HOME_PCT;
  return mustered ? asked : 'guard_home';
}

/**
 * Haiku-vs-Jev test (2026-10-09) — a stalled assault comes home. An assault Jev
 * launched ran until Jev itself called it off; when it stalled, every newly drafted
 * fighter trickled into the enemy nest one at a time and died. This is the client-side
 * safety net: JEV_ASSAULT_STALL_TICKS (60 s at 10 ticks/s) with no progress after
 * engaging ⇒ come home. Jev itself calls a failing assault off after about a minute;
 * this enforces it for any model.
 */
export const JEV_ASSAULT_STALL_TICKS = 600;
/** A fighter on the surface within this many tiles (Manhattan) of the assault's target
 *  entrance (the rally tile) is engaged; so is any fighter underground in their nest. */
export const JEV_ASSAULT_ENGAGE_RADIUS_TILES = 12;

/**
 * Has the assault made contact? True when any living fighter of `colonyId` is inside
 * the `opponentId` nest (underground on its grid), or on the surface within
 * JEV_ASSAULT_ENGAGE_RADIUS_TILES of `rally` (the target entrance). No stall clock
 * runs before contact: an army still walking over is not a stalled one. Pure read.
 */
export function assaultEngaged(
  world: WorldState,
  colonyId: ColonyId,
  opponentId: ColonyId,
  rally: { readonly x: number; readonly y: number },
): boolean {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return false;
  const a = world.ants;
  for (const id of colony.workers) {
    if (a.alive[id] !== 1 || a.task[id] !== AntTask.Fighting) continue;
    if (a.zone[id] === Zone.Underground) {
      if (a.currentGridColonyId[id] === opponentId) return true;
    } else if (
      manhattan(a.posX[id]! >> FP_SHIFT, a.posY[id]! >> FP_SHIFT, rally.x, rally.y) <=
      JEV_ASSAULT_ENGAGE_RADIUS_TILES
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The tick of the newest `combat_kill` by `killer` of one of `victim`'s ants within the
 * last JEV_ASSAULT_STALL_TICKS, or null. Scans the event log from the end and stops at
 * the first event older than the window, so it is cheap. Pure read.
 */
export function newestAssaultKillTick(
  world: WorldState,
  killer: ColonyId,
  victim: ColonyId,
): number | null {
  const since = world.tick - JEV_ASSAULT_STALL_TICKS;
  for (let i = world.events.length - 1; i >= 0; i--) {
    const ev = world.events[i]!;
    if (ev.tick < since) break;
    if (
      ev.type === 'combat_kill' &&
      ev.payload.killer.colonyId === killer &&
      ev.payload.victim.colonyId === victim
    ) {
      return ev.tick;
    }
  }
  return null;
}

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
  /** The game speed multiplier right now (1, 2 or 4), read every tick to pace the
   *  beats (beatPaceFactor). Default: 1×. */
  readonly speed?: () => number;
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
  /**
   * 'hold' until Jev's first beat says otherwise. The opening hands off with the
   * nest merely PLACED, so at handoff the colony's single digger still has the
   * whole planned nest in front of it — the default keeps the cadence executor
   * from marking a frontier that would compete with it for that digger.
   */
  digDirection: DigDirection = 'hold';
  currentPosture: PostureKey = 'recall';
  /** Stalled assaults called home by the safety net (diagnostic). */
  assaultRecalls = 0;

  private readonly client: JevClient;
  private readonly orders: string;
  private readonly beatTicks: number;
  private readonly buckets: BucketMode;
  private readonly maxConsecutiveFailures: number;
  private readonly onFallback: (() => void) | undefined;
  private readonly speed: () => number;

  private readonly opening: JevOpeningState = createJevOpeningState();
  private consecutiveFailures = 0;
  private inFlight = false;
  private stashed: StashedDecision | null = null;
  private prevFacts: RawFacts | null = null;
  private fallbackNotified = false;
  /** The tick the last beat was sent on (null: none yet this round). */
  private lastBeatTick: number | null = null;
  /** The guard_home tile of the last candidate set applied: where a stalled assault goes. */
  private lastGuardTile: { x: number; y: number } | null = null;
  /**
   * The stall watch of the assault under way, null while none is. Not saved: a
   * controller created from a save restarts tracking, which only delays a recall by
   * up to JEV_ASSAULT_STALL_TICKS.
   */
  private assaultWatch: {
    engagedTick: number | null;
    lastProgressTick: number;
    lastQueenHp: number;
  } | null = null;

  constructor(opts: JevEnemyControllerOptions) {
    this.seats = opts.seats;
    this.client = opts.client;
    this.orders = opts.orders;
    this.beatTicks = opts.beatTicks ?? JEV_DEFAULT_BEAT_TICKS;
    // Playtest 5 (#436): fine buckets by default. Coarse could not see the ¾ storage
    // rule (`high` was 60–90 %) or an army bigger than 3 (`many` was ≥ 4); every fine
    // label is in the proxy's vocabulary, and the spike's judgment test passed on it.
    this.buckets = opts.buckets ?? 'fine';
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? JEV_MAX_CONSECUTIVE_FAILURES;
    this.onFallback = opts.onFallback;
    this.speed = opts.speed ?? (() => 1);
  }

  /** Called from the game loop's `onBeforeTick` seam. Synchronous by contract. */
  onBeforeTick(world: WorldState): void {
    // Classify what last tick's pushes actually did (diagnostic only).
    this.ledger.settle(world);

    const colony = world.colonies[this.seats.mySeat];
    if (colony === undefined || colony.defeated) return;

    if (this.status === 'jev' && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.status = 'fallback';
      // #400 (V71): a spider priority now lasts until called off, and the rule-based
      // AI never gives or calls one off, so a priority Jev gave would outlive Jev.
      if (world.spiderPriorityColonyId === this.seats.mySeat) {
        this.issueSpiderPriority(world, false);
      }
      // Playtest 5 review: nor may a rally Jev gave — above all an Assault rally on
      // the opponent's door, which would keep feeding every fighter the ratio drafts
      // into their nest with nobody directing it. The rules AI has set no rally of
      // its own yet (Jev drove this seat), and sets its own from here on; a rally it
      // queues this same tick drains after this one.
      if (colony.rallyPoint !== null) {
        const cmd: ClearRallyPointCommand = {
          type: 'ClearRallyPoint',
          colonyId: this.seats.mySeat,
          issuedAtTick: world.tick,
        };
        this.ledger.issue(world, cmd);
      }
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

    // Readiness probe (a session mint): the first onBeforeTick call ever sends
    // one regardless of phase; while still in the opening it repeats on the beat
    // cadence until one succeeds, then stops (see the file header for why).
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
      if (isOpeningPlanned(world, this.seats.mySeat)) {
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

    this.watchAssault(world, colony);

    if (world.tick % AI_DIG_INTERVAL === 0) this.executeDig(world);
    if (this.beatDue(world.tick) && !this.inFlight) this.startBeat(world);
  }

  /**
   * A beat goes out on every `beatTicks × beatPaceFactor(speed)`-tick boundary, and
   * never fewer ticks than that after the last one: at 4× that is every 200 ticks,
   * and a switch to 4× right after a 1× beat waits for the next boundary that is far
   * enough on (playtest 5, #436; see JEV_MIN_BEAT_WALL_MS).
   */
  private beatDue(tick: number): boolean {
    const pace = this.beatTicks * beatPaceFactor(this.speed());
    if (tick % pace !== 0) return false;
    return this.lastBeatTick === null || tick - this.lastBeatTick >= pace;
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
    this.lastBeatTick = world.tick;
    this.beats += 1;
    this.inFlight = true;
    void this.client
      .beat(enc.state)
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
   * Fire the one-off readiness probe: mint the proxy session. Reuses the exact
   * in-flight/failure path a real beat uses — a rejection is one failed beat —
   * but it never decodes an answer, never stashes a Decision, and never counts
   * toward `beats`.
   */
  private startProbe(): void {
    this.probe = 'pending';
    this.inFlight = true;
    void this.client
      .mintSession()
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

  /**
   * Haiku-vs-Jev test (2026-10-09): the stalled-assault safety net, run every live
   * tick. While an Assault raid sits on their door: no stall clock before a fighter
   * makes contact (assaultEngaged); after it, progress is a drop in their queen's HP
   * or a kill of one of their ants (newestAssaultKillTick), and JEV_ASSAULT_STALL_TICKS
   * without either sends the army home — to the guard tile if one is known, else the
   * rally is cleared — exactly as applyDecision would for those postures. The rally is
   * then no longer on their door, so Jev's next `assault` answer goes back through the
   * muster and the army regroups at home before going again; there is no extra
   * cooldown.
   */
  private watchAssault(world: WorldState, colony: ColonyRecord): void {
    const { mySeat, opponentSeat } = this.seats;
    const target = rallyEnemyEntrance(world, colony);
    if (colony.raidType !== RaidType.Assault || target === null || colony.rallyPoint === null) {
      this.assaultWatch = null;
      return;
    }
    const opp = world.colonies[opponentSeat];
    if (opp === undefined || !isAlive(world.ants, opp.queenEntityId)) return; // round is ending
    const qhp = world.ants.hp[opp.queenEntityId]!;
    const watch = (this.assaultWatch ??= {
      engagedTick: null,
      lastProgressTick: world.tick,
      lastQueenHp: qhp,
    });
    if (qhp < watch.lastQueenHp) watch.lastProgressTick = world.tick;
    watch.lastQueenHp = qhp;

    if (watch.engagedTick === null) {
      const rally = { x: colony.rallyPoint.tileX, y: colony.rallyPoint.tileY };
      if (!assaultEngaged(world, mySeat, opponentSeat, rally)) return;
      watch.engagedTick = world.tick;
      watch.lastProgressTick = world.tick;
    }
    if (world.tick - watch.lastProgressTick < JEV_ASSAULT_STALL_TICKS) return;

    const killTick = newestAssaultKillTick(world, mySeat, opponentSeat);
    if (killTick !== null) {
      watch.lastProgressTick = killTick;
      return;
    }

    if (this.lastGuardTile !== null) {
      const cmd: SetRallyPointCommand = {
        type: 'SetRallyPoint',
        colonyId: mySeat,
        tileX: this.lastGuardTile.x,
        tileY: this.lastGuardTile.y,
        issuedAtTick: world.tick,
      };
      this.ledger.issue(world, cmd);
      this.currentPosture = 'guard_home';
    } else {
      const cmd: ClearRallyPointCommand = {
        type: 'ClearRallyPoint',
        colonyId: mySeat,
        issuedAtTick: world.tick,
      };
      this.ledger.issue(world, cmd);
      this.currentPosture = 'recall';
    }
    this.assaultWatch = null;
    this.assaultRecalls += 1;
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

    // Playtest 5 (#436): an `assault` is mustered first (musteredPosture) and, once
    // it goes, is an Assault raid — fighters ignore food and go for the queen. Every
    // other rally carries no raid type (Loot), as before; on our own entrance or a
    // pile it never applies.
    const posture = musteredPosture(world, colonyId, d.posture, cands);
    this.lastGuardTile = cands.posture.guard_home?.tile ?? null;
    const pc = cands.posture[posture];
    if (pc !== undefined) {
      const raidType = posture === 'assault' ? RaidType.Assault : undefined;
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
        colony.rallyPoint.tileY !== pc.tile.y ||
        (raidType !== undefined && colony.raidType !== raidType)
      ) {
        const cmd: SetRallyPointCommand = {
          type: 'SetRallyPoint',
          colonyId,
          tileX: pc.tile.x,
          tileY: pc.tile.y,
          ...(raidType !== undefined ? { raidType } : {}),
          issuedAtTick: tick,
        };
        this.ledger.issue(world, cmd);
      }
      // Haiku-vs-Jev test (2026-10-09): what Jev is told it is doing. The rally is
      // `guard_home` while an assault musters, but reporting that sent Jev
      // `current_posture: guard_home` next beat, which a stateless model cannot tell
      // from guarding, and most answers then cancelled the muster. So a muster in
      // progress reports `assault` (the rally on the world is unchanged). Side effect:
      // decodeAnswers' fallback for an invalid or failed posture answer is
      // `facts.currentPosture`, so such an answer now keeps the muster going.
      this.currentPosture =
        d.posture === 'assault' && posture === 'guard_home' ? 'assault' : posture;
    }

    this.digDirection = d.dig;

    const fp = cands.foodPriority[d.foodPriority];
    if (fp !== undefined && fp.pileId !== colony.priorityFoodPileId) {
      // MarkFoodPile TOGGLES in tick.ts: marking a different pile selects it,
      // re-marking the currently-priority pile clears it. So "no priority" is
      // expressed by re-marking the pile that is currently priority.
      let tile = fp.tile;
      if (fp.pileId === null) {
        const slot =
          colony.priorityFoodPileId === null ? -1 : pileSlotById(world, colony.priorityFoodPileId);
        tile = slot < 0 ? null : { x: pileTileX(world, slot), y: pileTileY(world, slot) };
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

    // #400 (V71): a spider priority lasts until it is called off or the spider dies;
    // the sim no longer ends it with the encounter. Jev is only asked about the
    // spider while it is near, so when this beat did not ask, a priority Jev gave is
    // called off: otherwise every surface fighter would keep chasing the spider
    // across the map for the rest of its life.
    const wantSpider = cands.spiderPriority === null ? false : d.spiderPriority;
    if (wantSpider !== null && wantSpider !== (world.spiderPriorityColonyId === colonyId)) {
      this.issueSpiderPriority(world, wantSpider);
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

  private issueSpiderPriority(world: WorldState, isPriority: boolean): void {
    const cmd: MarkSpiderPriorityCommand = {
      type: 'MarkSpiderPriority',
      colonyId: this.seats.mySeat,
      isPriority,
      issuedAtTick: world.tick,
    };
    this.ledger.issue(world, cmd);
  }
}
