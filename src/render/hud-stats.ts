// hud-stats.ts — Pure helpers for HUD-02 stats bar.
//
// Extracted from UIScene so the computation + layout can be unit-tested under
// Node without a Phaser scene. UIScene feeds these results into Text widgets
// and a Graphics bar in its update() pass.
//
// HUD-02 contract — PRD §6c (04-PRD-playable-game-loop.md:908):
//   - 200×24 rect at (8, 8) with semi-transparent dark background (0x000000, α=0.6)
//   - Ant count = workerCount + (queen alive ? 1 : 0)
//     Phase 9 fix: eggs + larvae are deliberately excluded. The player's mental
//     model of "how many ants do I have" is "how many can act right now" — brood
//     are incapable until they hatch and promote. Folding them in made the
//     headline number confidently wrong (e.g. "Ants: 20" while only 5 workers
//     could forage or dig). A separate brood indicator can be added later if
//     the information is worth restoring.
//   - Food stored = "current/capacity" in human units (09 HUD clarity pass).
//     current  = foodStored   >> FP_SHIFT
//     capacity = colonyFoodCapacity(colony) >> FP_SHIFT
//     Capacity grows as FoodStorage chambers complete, so the label doubles
//     as feedback for "did my new chamber take effect yet?".
//   - Queen health = visual bar derived from queenStarvationTimer / STARVATION_GRACE_TICKS
//     * green  when pct > 50  (healthy)
//     * yellow when 25 ≤ pct ≤ 50 (moderate)
//     * red    when pct < 25  (critical)
//     * dead queen renders empty bar in the critical color
//
// Layout note (09 HUD clarity pass): the row uses a two-row micro-layout inside
// the 24px rect. Row 1 = Ants (left) + Food (right-anchored). Row 2 = "Queen"
// label (left) + queen health bar (right-anchored). Two rows keep Food and
// Queen from ever fighting for the same horizontal budget — a single-row
// layout couldn't fit "Food: 999/999" plus "Queen" plus the bar at worst-case
// values inside 200px.

import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { STARVATION_GRACE_TICKS } from '../sim/constants.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/colony/colony-system.js';

export interface HudStats {
  antCount:       number;
  foodDisplay:    number;
  foodCapacity:   number;
  queenHealthPct: number;
  queenAlive:     boolean;
}

export type QueenHealthState = 'dead' | 'critical' | 'moderate' | 'healthy';

export const HUD_STATS_COLORS = {
  background:      0x000000,
  backgroundAlpha: 0.6,
  barTrack:        0x333333,
  barHealthy:      0x22bb44,
  barModerate:     0xddaa22,
  barCritical:     0xcc3322,
  antsTextCss:     '#ffffff',
  foodTextCss:     '#22bb44',
  queenLabelCss:   '#ffffff',
} as const;

export const HUD_STATS_LAYOUT = {
  // Two-row micro-layout inside HUD.STATS (200×24 at y=8). Row 1 carries
  // Ants+Food; row 2 carries the Queen label + health bar. yOffsets are
  // relative to HUD.STATS.y and chosen so the 10px Text widgets + the 6px
  // bar all sit inside the 24px rect.
  row1YOffset: 1,  // canvas y = 9
  row2YOffset: 13, // canvas y = 21
  leftTextInset: 4,
  queenBar: {
    w:          48,
    h:          6,
    yOffset:    16, // canvas y = 24 → bar spans y=24..30 (inside rect)
    rightInset: 6,
  },
  queenLabel: {
    // Restored to a readable "Queen" label (09 HUD clarity pass). The
    // single-char 'Q' was ambiguous enough that players couldn't tell which
    // stat the color-coded bar belonged to. Two-row layout makes space.
    text:       'Queen',
    w:          32, // 5 chars × ~6.4px monospace at 10px
    yOffset:    13, // matches row 2
  },
} as const;

export function computeHudStats(world: WorldState, colony: ColonyRecord): HudStats {
  const queenAlive  = isAlive(world.ants, colony.queenEntityId);
  const queenBit    = queenAlive ? 1 : 0;
  // Phase 9 fix: count capable ants only (workers + living queen). Eggs and
  // larvae are excluded because they cannot execute any task; folding them in
  // produced a "total headcount" the player read as "usable headcount".
  const antCount     = colony.workerCount + queenBit;
  // Issue #15: foodTotal sums the entrance pool (colony.foodStored) plus every
  // FoodStorage chamber's per-chamber foodStored — the HUD must show the
  // player the whole stash, not just the chamberless fallback bucket.
  const foodDisplay  = colonyFoodTotal(colony) >> FP_SHIFT;
  const foodCapacity = colonyFoodCapacity(colony) >> FP_SHIFT;

  let queenHealthPct = 0;
  if (queenAlive) {
    const raw = colony.queenStarvationTimer / STARVATION_GRACE_TICKS;
    const t   = raw < 0 ? 0 : (raw > 1 ? 1 : raw);
    queenHealthPct = Math.round(t * 100);
  }

  return { antCount, foodDisplay, foodCapacity, queenHealthPct, queenAlive };
}

export function formatAntsLabel(s: HudStats): string {
  return `Ants: ${s.antCount}`;
}

export function formatFoodLabel(s: HudStats): string {
  return `Food: ${s.foodDisplay}/${s.foodCapacity}`;
}

export function queenHealthState(s: HudStats): QueenHealthState {
  if (!s.queenAlive)       return 'dead';
  if (s.queenHealthPct > 50)  return 'healthy';
  if (s.queenHealthPct >= 25) return 'moderate';
  return 'critical';
}

export function queenHealthBarColor(s: HudStats): number {
  switch (queenHealthState(s)) {
    case 'healthy':  return HUD_STATS_COLORS.barHealthy;
    case 'moderate': return HUD_STATS_COLORS.barModerate;
    case 'dead':
    case 'critical': return HUD_STATS_COLORS.barCritical;
  }
}

export function queenHealthBarFillWidth(s: HudStats, totalW: number): number {
  if (!s.queenAlive) return 0;
  const w = Math.round((totalW * s.queenHealthPct) / 100);
  if (w < 0)      return 0;
  if (w > totalW) return totalW;
  return w;
}

export interface QueenBarRect { x: number; y: number; w: number; h: number; }

export function queenBarRect(statsRect: { x: number; y: number; w: number; h: number }): QueenBarRect {
  const { w, h, yOffset, rightInset } = HUD_STATS_LAYOUT.queenBar;
  return {
    x: statsRect.x + statsRect.w - rightInset - w,
    y: statsRect.y + yOffset,
    w,
    h,
  };
}

export interface QueenLabelRect { x: number; y: number; w: number; h: number; }

/**
 * queenLabelRect — placement for the "Queen" label on row 2 of the HUD stats
 * bar (09 HUD clarity pass). Left-anchored like Ants on row 1. The queen
 * health bar is right-anchored on the same row, so the label and bar read
 * as a horizontal unit without needing to overlap the Food total on row 1.
 */
export function queenLabelRect(statsRect: { x: number; y: number; w: number; h: number }): QueenLabelRect {
  const { w, yOffset } = HUD_STATS_LAYOUT.queenLabel;
  return {
    x: statsRect.x + HUD_STATS_LAYOUT.leftTextInset,
    y: statsRect.y + yOffset,
    w,
    h: 10,
  };
}

export function formatQueenLabel(): string {
  return HUD_STATS_LAYOUT.queenLabel.text;
}

/**
 * formatStatsPrefix — legacy helper retained for back-compat with any
 * test or caller that expected the combined "Ants: N  Food: N" string.
 * Prefer formatAntsLabel + formatFoodLabel, which are color-split per
 * PRD §6c (food gets its own green-tinted indicator).
 */
export function formatStatsPrefix(s: HudStats): string {
  return `${formatAntsLabel(s)}  ${formatFoodLabel(s)}`;
}
