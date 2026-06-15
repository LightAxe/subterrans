// src/render/command-ghosts.ts — Stage 3a (Command Legibility, issue #18).
//
// Ghost delta = the player-attributable NET difference between the projected world
// and the committed world (Codex R2-12 / R3-6). It is what the preview overlay draws
// in the state-2 "queued" treatment (dashed + low-alpha on the committed look). NOT
// "every queued command" — the projection already hides rejected + net-zero sequences.
//
// Per-field ownership (no command provenance needed from one projection): per-colony
// state (grid marks, pending chambers, rally) is player-attributable on the PLAYER's
// views — AI commands touch the AI colony, and underground ghosts are player-colony-
// gated at the draw site. The lone GLOBAL field (spiderPriorityColonyId) is attributed
// to the player only when the LAST MarkSpiderPriority in FIFO order is a player command
// (Codex R4-5 — a later non-player writer supersedes an earlier player one).

import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import type { WorldState } from '../sim/types.js';

/** Shape of a `world.pendingChambers` value (derived; avoids a cross-module type import). */
type PendingChamber = NonNullable<WorldState['pendingChambers'][string]>;

export interface TileRef {
  readonly tileX: number;
  readonly tileY: number;
}

export interface GhostDelta {
  /** Tiles the queue will newly mark (Solid→Marked): proto-blue. */
  readonly pendingMarks: readonly TileRef[];
  /** Tiles the queue will un-mark (committed Marked→Solid): pending-removal. */
  readonly pendingRemovals: readonly TileRef[];
  /** Chambers the queue will newly place: dashed wavy ghost. */
  readonly ghostChambers: readonly PendingChamber[];
  /** Committed-pending chambers the queue will cancel: pending-removal footprint. */
  readonly removedChambers: readonly PendingChamber[];
  /** Pending rally change for the player colony (the projected rally), if it differs. */
  readonly pendingRally: TileRef | null;
  /**
   * The committed rally tile a queued ClearRallyPoint will remove (committed had one,
   * projection does not), or null if the rally is not being cleared. Carries the tile so
   * the overlay can draw a removal-tinted marker where the committed crosshair still sits.
   */
  readonly rallyCleared: TileRef | null;
  /** Player-attributed pending spider-priority state, or null if unchanged/not-player. */
  readonly pendingSpiderPriority: boolean | null;
  /**
   * The food-pile tile the player's queue will newly prioritize for the PLAYER colony
   * (projected priorityFoodPileId differs from committed AND resolves to a live pile), or
   * null when the priority is unchanged, cleared, or the pile no longer exists. Carries the
   * tile so the surface overlay can mark it without re-resolving the id → pile lookup.
   */
  readonly pendingFoodMark: TileRef | null;
  /**
   * The committed-priority food-pile tile a queued MarkFoodPile will stop prioritizing
   * (committed had a pile, projection clears it or redirects to a different pile), or null
   * when the committed priority is unchanged. Carries the committed pile's tile so the
   * surface overlay can draw a removal-tinted cue where the committed marker still sits
   * (draw-surface paints the committed marker until resume). Symmetric with rallyCleared.
   */
  readonly foodMarkCleared: TileRef | null;
  /**
   * Surface tiles where the player has queued a DesignateEntrance (present in the projected
   * colony's entrances but not the committed colony's) — drawn as a dashed entrance glyph
   * (plan §B12; ship-review LOW: a queued entrance was previously not ghosted at all).
   */
  readonly pendingEntrances: readonly TileRef[];
}

const EMPTY: GhostDelta = {
  pendingMarks: [],
  pendingRemovals: [],
  ghostChambers: [],
  removedChambers: [],
  pendingRally: null,
  rallyCleared: null,
  pendingSpiderPriority: null,
  pendingFoodMark: null,
  foodMarkCleared: null,
  pendingEntrances: [],
};

function keyOf(c: PendingChamber): string {
  return `${c.colonyId}:${c.anchorTileX}:${c.anchorTileY}`;
}

/**
 * Compute the player-attributable ghost delta. When `projection === world` (empty
 * queue alias) there is nothing pending — returns the shared EMPTY delta.
 */
export function computeGhostDelta(world: WorldState, projection: WorldState): GhostDelta {
  if (projection === world) return EMPTY;

  // --- dig marks / removals: drive candidate tiles off the player's queued dig
  //     commands (small), classify net state via projection-vs-world (Codex R2-12). ---
  const pendingMarks: TileRef[] = [];
  const pendingRemovals: TileRef[] = [];
  const seen = new Set<number>();
  const wGrid = world.undergroundGrids[PLAYER_COLONY_ID];
  const pGrid = projection.undergroundGrids[PLAYER_COLONY_ID];
  if (wGrid && pGrid) {
    for (const cmd of world.commandQueue) {
      if (
        (cmd.type !== 'MarkDigTile' && cmd.type !== 'CancelDigMark') ||
        cmd.colonyId !== PLAYER_COLONY_ID
      ) {
        continue;
      }
      // Defensive bounds (ship-review LOW): live player input is pre-validated, but a tampered save
      // could carry an off-grid coord — ugGet does no bounds check (would wrap rows), and the dedup
      // key packs tileX into the low digits (k = tileY*100000 + tileX), so an off-grid coord could
      // ALIAS an in-bounds key. Check bounds BEFORE touching the dedup set so only valid tiles occupy
      // it (else a poisoned off-grid key would silently drop a legitimate tile's ghost).
      if (cmd.tileX < 0 || cmd.tileY < 0 || cmd.tileX >= wGrid.width || cmd.tileY >= wGrid.height) {
        continue;
      }
      const k = cmd.tileY * 100000 + cmd.tileX;
      if (seen.has(k)) continue;
      seen.add(k);
      const wState = ugGet(wGrid, cmd.tileX, cmd.tileY);
      const pState = ugGet(pGrid, cmd.tileX, cmd.tileY);
      if (wState === pState) continue; // net no-op (e.g. mark then cancel)
      if (pState === UndergroundTileState.Marked && wState === UndergroundTileState.Solid) {
        pendingMarks.push({ tileX: cmd.tileX, tileY: cmd.tileY });
      } else if (pState === UndergroundTileState.Solid && wState === UndergroundTileState.Marked) {
        pendingRemovals.push({ tileX: cmd.tileX, tileY: cmd.tileY });
      }
    }
  }

  // --- chambers: keyed diff of pendingChambers (player colony) ---
  const ghostChambers: PendingChamber[] = [];
  const removedChambers: PendingChamber[] = [];
  const wKeys = new Set<string>();
  for (const key in world.pendingChambers) {
    const c = world.pendingChambers[key]!;
    if (c.colonyId === PLAYER_COLONY_ID) wKeys.add(keyOf(c));
  }
  const pKeys = new Set<string>();
  for (const key in projection.pendingChambers) {
    const c = projection.pendingChambers[key]!;
    if (c.colonyId !== PLAYER_COLONY_ID) continue;
    pKeys.add(keyOf(c));
    if (!wKeys.has(keyOf(c))) ghostChambers.push(c);
  }
  for (const key in world.pendingChambers) {
    const c = world.pendingChambers[key]!;
    if (c.colonyId === PLAYER_COLONY_ID && !pKeys.has(keyOf(c))) removedChambers.push(c);
  }

  // --- rally (per-colony, player) ---
  const wRally = world.colonies[PLAYER_COLONY_ID]?.rallyPoint ?? null;
  const pRally = projection.colonies[PLAYER_COLONY_ID]?.rallyPoint ?? null;
  let pendingRally: TileRef | null = null;
  let rallyCleared: TileRef | null = null;
  if (
    pRally !== null &&
    (wRally === null || wRally.tileX !== pRally.tileX || wRally.tileY !== pRally.tileY)
  ) {
    pendingRally = { tileX: pRally.tileX, tileY: pRally.tileY };
    // Re-point (ship-review LOW): the OLD committed crosshair is going away — tint a removal
    // cue at it too (draw-surface still draws the committed crosshair until resume).
    if (wRally !== null) rallyCleared = { tileX: wRally.tileX, tileY: wRally.tileY };
  } else if (pRally === null && wRally !== null) {
    rallyCleared = { tileX: wRally.tileX, tileY: wRally.tileY };
  }

  // --- food mark (per-colony, player): the projected priority pile, resolved to its
  //     tile, when the queue newly sets/redirects it (committed id differs). A toggle-off
  //     (projected null) or a redirect to a now-depleted pile leaves pendingFoodMark null.
  //     foodMarkCleared is the symmetric removal cue (committed pile going away on a
  //     toggle-off OR re-direct), resolved off the COMMITTED world so the tile is the one
  //     draw-surface still paints as marked until resume. ---
  const wFood = world.colonies[PLAYER_COLONY_ID]?.priorityFoodPileId ?? null;
  const pFood = projection.colonies[PLAYER_COLONY_ID]?.priorityFoodPileId ?? null;
  let pendingFoodMark: TileRef | null = null;
  let foodMarkCleared: TileRef | null = null;
  if (pFood !== null && pFood !== wFood) {
    for (const pile of projection.foodPiles) {
      if (pile.foodPileId === pFood) {
        pendingFoodMark = { tileX: pile.tileX, tileY: pile.tileY };
        break;
      }
    }
  }
  if (wFood !== null && wFood !== pFood) {
    for (const pile of world.foodPiles) {
      if (pile.foodPileId === wFood) {
        foodMarkCleared = { tileX: pile.tileX, tileY: pile.tileY };
        break;
      }
    }
  }

  // --- spider priority (GLOBAL): attribute by the LAST MarkSpiderPriority writer ---
  let pendingSpiderPriority: boolean | null = null;
  if (world.spiderPriorityColonyId !== projection.spiderPriorityColonyId) {
    let lastWriterIsPlayer = false;
    let found = false;
    for (let i = world.commandQueue.length - 1; i >= 0; i--) {
      const cmd = world.commandQueue[i]!;
      if (cmd.type === 'MarkSpiderPriority') {
        lastWriterIsPlayer = cmd.colonyId === PLAYER_COLONY_ID;
        found = true;
        break;
      }
    }
    if (found && lastWriterIsPlayer) {
      pendingSpiderPriority = projection.spiderPriorityColonyId === PLAYER_COLONY_ID;
    }
  }

  // --- entrances (per-colony, player): designations queued but not yet committed (plan §B12) ---
  const pendingEntrances: TileRef[] = [];
  const wEnt = world.colonies[PLAYER_COLONY_ID]?.entrances ?? [];
  const pEnt = projection.colonies[PLAYER_COLONY_ID]?.entrances ?? [];
  if (pEnt.length > wEnt.length) {
    const wEntKeys = new Set(wEnt.map((e) => `${e.surfaceTileX}:${e.surfaceTileY}`));
    for (const e of pEnt) {
      if (!wEntKeys.has(`${e.surfaceTileX}:${e.surfaceTileY}`)) {
        pendingEntrances.push({ tileX: e.surfaceTileX, tileY: e.surfaceTileY });
      }
    }
  }

  return {
    pendingMarks,
    pendingRemovals,
    ghostChambers,
    removedChambers,
    pendingRally,
    rallyCleared,
    pendingSpiderPriority,
    pendingFoodMark,
    foodMarkCleared,
    pendingEntrances,
  };
}
