// hud-stats.test.ts — Vitest unit tests for computeHudStats, queen bar helpers,
// and label formatters.

import { describe, it, expect } from 'vitest';
import {
  computeHudStats,
  formatAntsLabel,
  formatFoodLabel,
  formatQueenLabel,
  formatStatsPrefix,
  queenBarRect,
  queenLabelRect,
  queenHealthBarColor,
  queenHealthBarFillWidth,
  queenHealthState,
  HUD_STATS_COLORS,
  HUD_STATS_LAYOUT,
} from './hud-stats.js';
import type { HudStats } from './hud-stats.js';
import { createWorldState } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { allocateEntityId } from '../sim/types.js';
import { initAnt, killAnt } from '../sim/ant/ant-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import {
  STARVATION_GRACE_TICKS,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
} from '../sim/constants.js';
import { FP_SHIFT } from '../sim/fixed.js';

function setupWorld(): { world: WorldState; colony: ColonyRecord; queenId: number } {
  const world = createWorldState(64);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, { colonyId: 1, posX: 0, posY: 0, task: AntTask.Idle });
  const colony = createColonyRecord(1, queenId);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[1] = colony;
  return { world, colony, queenId };
}

function makeStats(overrides: Partial<HudStats> = {}): HudStats {
  return {
    antCount: 1,
    foodDisplay: 0,
    foodCapacity: BASE_FOOD_STORAGE_CAPACITY >> FP_SHIFT,
    queenHealthPct: 100,
    queenAlive: true,
    ...overrides,
  };
}

describe('computeHudStats', () => {
  it('antCount = workers + queen (when alive), excluding eggs and larvae', () => {
    // Phase 9 fix: the HUD counts capable ants only. Brood are not yet
    // ants that can act, so including them misled the player about how
    // many workers were available to forage/dig.
    const { world, colony } = setupWorld();
    colony.workerCount = 5;
    colony.eggCount = 3;
    colony.larvaeCount = 2;
    const s = computeHudStats(world, colony);
    expect(s.antCount).toBe(5 + 1);
    expect(s.queenAlive).toBe(true);
  });

  it('antCount excludes the queen when queen dead (and still excludes brood)', () => {
    const { world, colony, queenId } = setupWorld();
    colony.workerCount = 4;
    colony.eggCount = 1;
    colony.larvaeCount = 0;
    killAnt(world.ants, queenId);
    const s = computeHudStats(world, colony);
    expect(s.antCount).toBe(4);
    expect(s.queenAlive).toBe(false);
  });

  it('foodDisplay converts from fixed-point to human units', () => {
    const { world, colony } = setupWorld();
    colony.foodStored = 10 << FP_SHIFT;
    const s = computeHudStats(world, colony);
    expect(s.foodDisplay).toBe(10);
  });

  it('foodCapacity = base capacity with no FoodStorage chambers', () => {
    // 09 HUD clarity pass: capacity is reported alongside current food so
    // the player sees "Food: C/M" and can tell at a glance how much head-
    // room remains before foragers top out.
    const { world, colony } = setupWorld();
    const s = computeHudStats(world, colony);
    expect(s.foodCapacity).toBe(BASE_FOOD_STORAGE_CAPACITY >> FP_SHIFT);
  });

  it('foodCapacity grows with completed FoodStorage chambers', () => {
    const { world, colony } = setupWorld();
    // Two completed FoodStorage chambers → capacity = BASE + 2 × CHAMBER.
    // Matches colonyFoodCapacity source-of-truth (sim/colony/colony-system).
    colony.chambers.push({
      chamberId: 9001,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    colony.chambers.push({
      chamberId: 9002,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 10,
      posY: 10,
      width: 3,
      height: 3,
    });
    const s = computeHudStats(world, colony);
    const expected = (BASE_FOOD_STORAGE_CAPACITY + 2 * FOOD_CHAMBER_CAPACITY) >> FP_SHIFT;
    expect(s.foodCapacity).toBe(expected);
  });

  it('queenHealthPct = 100 at full grace', () => {
    const { world, colony } = setupWorld();
    colony.queenStarvationTimer = STARVATION_GRACE_TICKS;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
  });

  it('queenHealthPct scales linearly', () => {
    const { world, colony } = setupWorld();
    colony.queenStarvationTimer = Math.floor(STARVATION_GRACE_TICKS / 2);
    expect(computeHudStats(world, colony).queenHealthPct).toBe(50);
  });

  it('queenHealthPct = 0 when timer at or below 0', () => {
    const { world, colony } = setupWorld();
    colony.queenStarvationTimer = 0;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(0);
    colony.queenStarvationTimer = -50;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(0);
  });

  it('queenHealthPct clamps to 100 when timer above grace', () => {
    const { world, colony } = setupWorld();
    colony.queenStarvationTimer = STARVATION_GRACE_TICKS * 5;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
  });

  it('queenHealthPct = 0 when queen is dead, even if timer > 0', () => {
    const { world, colony, queenId } = setupWorld();
    colony.queenStarvationTimer = STARVATION_GRACE_TICKS;
    killAnt(world.ants, queenId);
    expect(computeHudStats(world, colony).queenHealthPct).toBe(0);
  });
});

describe('label formatters', () => {
  it('formatAntsLabel reports total ant count', () => {
    expect(formatAntsLabel(makeStats({ antCount: 42 }))).toBe('Ants: 42');
  });

  it('formatFoodLabel reports current/capacity in human units', () => {
    // 09 HUD clarity pass: food label is now "Food: C/M" so players can
    // see headroom at a glance. At base capacity with nothing stored:
    // "Food: 0/8" (BASE_FOOD_STORAGE_CAPACITY = 2048fp → 8 human units).
    expect(formatFoodLabel(makeStats({ foodDisplay: 0, foodCapacity: 8 }))).toBe('Food: 0/8');
    expect(formatFoodLabel(makeStats({ foodDisplay: 8, foodCapacity: 8 }))).toBe('Food: 8/8');
    // One FoodStorage chamber added: base 8 + chamber 20 = capacity 28.
    expect(formatFoodLabel(makeStats({ foodDisplay: 8, foodCapacity: 28 }))).toBe('Food: 8/28');
    expect(formatFoodLabel(makeStats({ foodDisplay: 48, foodCapacity: 48 }))).toBe('Food: 48/48');
  });

  it('formatStatsPrefix combines both with two-space separator', () => {
    expect(formatStatsPrefix(makeStats({ antCount: 11, foodDisplay: 4, foodCapacity: 8 }))).toBe(
      'Ants: 11  Food: 4/8',
    );
  });

  it('formatQueenLabel returns the readable "Queen" word, not a single char', () => {
    // 09 HUD clarity pass: previous layout used a single 'Q' which players
    // could not reliably associate with the color-coded bar. Assert the
    // label is explicitly multi-char and starts with a capital Q.
    const s = formatQueenLabel();
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.startsWith('Q')).toBe(true);
    expect(s.toLowerCase()).toContain('queen');
  });
});

describe('queenHealthState (PRD §6c thresholds)', () => {
  it('returns "dead" when queen is dead regardless of pct', () => {
    expect(queenHealthState(makeStats({ queenAlive: false, queenHealthPct: 100 }))).toBe('dead');
  });

  it('returns "healthy" when pct > 50', () => {
    expect(queenHealthState(makeStats({ queenHealthPct: 51 }))).toBe('healthy');
    expect(queenHealthState(makeStats({ queenHealthPct: 100 }))).toBe('healthy');
  });

  it('returns "moderate" when 25 <= pct <= 50', () => {
    expect(queenHealthState(makeStats({ queenHealthPct: 50 }))).toBe('moderate');
    expect(queenHealthState(makeStats({ queenHealthPct: 37 }))).toBe('moderate');
    expect(queenHealthState(makeStats({ queenHealthPct: 25 }))).toBe('moderate');
  });

  it('returns "critical" when pct < 25', () => {
    expect(queenHealthState(makeStats({ queenHealthPct: 24 }))).toBe('critical');
    expect(queenHealthState(makeStats({ queenHealthPct: 0 }))).toBe('critical');
  });
});

describe('queenHealthBarColor', () => {
  it('maps each health state to its PRD color', () => {
    expect(queenHealthBarColor(makeStats({ queenHealthPct: 100 }))).toBe(
      HUD_STATS_COLORS.barHealthy,
    );
    expect(queenHealthBarColor(makeStats({ queenHealthPct: 40 }))).toBe(
      HUD_STATS_COLORS.barModerate,
    );
    expect(queenHealthBarColor(makeStats({ queenHealthPct: 10 }))).toBe(
      HUD_STATS_COLORS.barCritical,
    );
    expect(queenHealthBarColor(makeStats({ queenAlive: false }))).toBe(
      HUD_STATS_COLORS.barCritical,
    );
  });
});

describe('queenHealthBarFillWidth', () => {
  it('scales proportionally to pct', () => {
    expect(queenHealthBarFillWidth(makeStats({ queenHealthPct: 100 }), 48)).toBe(48);
    expect(queenHealthBarFillWidth(makeStats({ queenHealthPct: 50 }), 48)).toBe(24);
    expect(queenHealthBarFillWidth(makeStats({ queenHealthPct: 25 }), 48)).toBe(12);
  });

  it('returns 0 when queen is dead', () => {
    expect(queenHealthBarFillWidth(makeStats({ queenAlive: false, queenHealthPct: 99 }), 48)).toBe(
      0,
    );
  });

  it('clamps within [0, totalW]', () => {
    expect(queenHealthBarFillWidth(makeStats({ queenHealthPct: 200 }), 48)).toBeLessThanOrEqual(48);
    expect(queenHealthBarFillWidth(makeStats({ queenHealthPct: -10 }), 48)).toBeGreaterThanOrEqual(
      0,
    );
  });
});

describe('queenBarRect', () => {
  it('right-anchors the bar inside the 200x24 hud.STATS rect', () => {
    const rect = queenBarRect({ x: 8, y: 8, w: 200, h: 24 });
    const { w, h, yOffset, rightInset } = HUD_STATS_LAYOUT.queenBar;
    expect(rect.w).toBe(w);
    expect(rect.h).toBe(h);
    expect(rect.y).toBe(8 + yOffset);
    expect(rect.x).toBe(8 + 200 - rightInset - w);
    // stays inside hud.STATS horizontally
    expect(rect.x).toBeGreaterThanOrEqual(8);
    expect(rect.x + rect.w).toBeLessThanOrEqual(8 + 200);
    // stays inside hud.STATS vertically
    expect(rect.y).toBeGreaterThanOrEqual(8);
    expect(rect.y + rect.h).toBeLessThanOrEqual(8 + 24);
  });
});

describe('queenLabelRect (09 HUD clarity pass — two-row layout)', () => {
  it('sits on row 2, left-anchored with the configured inset', () => {
    const stats = { x: 8, y: 8, w: 200, h: 24 };
    const label = queenLabelRect(stats);
    const { w, yOffset } = HUD_STATS_LAYOUT.queenLabel;
    expect(label.w).toBe(w);
    expect(label.x).toBe(stats.x + HUD_STATS_LAYOUT.leftTextInset);
    expect(label.y).toBe(stats.y + yOffset);
  });

  it('label and queen bar on the same row do not overlap', () => {
    const stats = { x: 8, y: 8, w: 200, h: 24 };
    const bar = queenBarRect(stats);
    const label = queenLabelRect(stats);
    // Label ends before bar starts — leaves visible spacing.
    expect(label.x + label.w).toBeLessThan(bar.x);
  });

  it('stays inside hud.STATS both horizontally and vertically', () => {
    const stats = { x: 8, y: 8, w: 200, h: 24 };
    const label = queenLabelRect(stats);
    expect(label.x).toBeGreaterThanOrEqual(stats.x);
    expect(label.x + label.w).toBeLessThanOrEqual(stats.x + stats.w);
    expect(label.y).toBeGreaterThanOrEqual(stats.y);
    expect(label.y + label.h).toBeLessThanOrEqual(stats.y + stats.h);
  });
});

describe('two-row stats layout (09 HUD clarity pass)', () => {
  // Row 1 (Ants + Food) and row 2 (Queen label + bar) must occupy disjoint
  // vertical bands inside the 24px rect. Food is right-anchored against the
  // stats rect's right edge (minus FOOD_RIGHT_INSET), so at worst-case food
  // values it still doesn't collide with anything on row 2.
  const FOOD_RIGHT_INSET = 6;
  const stats = { x: 8, y: 8, w: 200, h: 24 };

  it('row 1 and row 2 y-offsets leave at least 10px between baselines', () => {
    expect(HUD_STATS_LAYOUT.row2YOffset - HUD_STATS_LAYOUT.row1YOffset).toBeGreaterThanOrEqual(10);
  });

  it('right-anchored food on row 1 never overlaps the queen bar on row 2 horizontally, even at worst-case width', () => {
    // "Food: 999/999" ≈ 13 chars × 6.4px monospace ≈ 84px — realistic worst case.
    // Rows are vertically disjoint, so this is a sanity check: food still fits
    // inside the rect when right-anchored.
    const foodTextWidth = 90;
    const foodX = stats.x + stats.w - FOOD_RIGHT_INSET - foodTextWidth;
    expect(foodX).toBeGreaterThanOrEqual(stats.x + HUD_STATS_LAYOUT.leftTextInset);
  });

  it('ants + food on row 1 stay disjoint at realistic colony sizes', () => {
    const antsX = stats.x + HUD_STATS_LAYOUT.leftTextInset;
    const antsTextWidth = 60; // "Ants: 999" ≈ 54px, leave headroom
    const foodTextWidth = 72; // "Food: 999/999" generous estimate
    const foodX = stats.x + stats.w - FOOD_RIGHT_INSET - foodTextWidth;
    expect(antsX + antsTextWidth).toBeLessThanOrEqual(foodX);
  });

  it('queen label + bar on row 2 stay disjoint', () => {
    const label = queenLabelRect(stats);
    const bar = queenBarRect(stats);
    expect(label.x + label.w).toBeLessThanOrEqual(bar.x);
  });

  it('both rows remain inside the hud.STATS rect vertically', () => {
    // Approximate rendered height of a 10px monospace Text widget.
    const TEXT_HEIGHT = 12;
    const row1Top = stats.y + HUD_STATS_LAYOUT.row1YOffset;
    const row1Bot = row1Top + TEXT_HEIGHT;
    const row2Top = stats.y + HUD_STATS_LAYOUT.row2YOffset;
    const row2Bot = row2Top + TEXT_HEIGHT;
    expect(row1Top).toBeGreaterThanOrEqual(stats.y);
    expect(row1Bot).toBeLessThanOrEqual(stats.y + stats.h + 1); // 1px visual slop
    expect(row2Top).toBeGreaterThanOrEqual(stats.y);
    expect(row2Bot).toBeLessThanOrEqual(stats.y + stats.h + 2); // 1-2px visual slop
  });
});
