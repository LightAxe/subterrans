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
  queenStoresRect,
  HUD_STATS_COLORS,
  HUD_STATS_LAYOUT,
} from './hud-stats.js';
import { antActivityPanelRect } from './ant-activity.js';
import { buildHudLayout, captionWrapWidth, CAPTION_PAD_X } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';
import type { HudStats } from './hud-stats.js';
import { createWorldState } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { allocateEntityId } from '../sim/types.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import {
  STARVATION_GRACE_TICKS,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  COMBAT_HP_QUEEN,
  QUEEN_HP_HOME,
} from '../sim/constants.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { QUEEN_HUNGER } from '../sim/hunger.js';
import {
  setPoolFoodForTest,
  setMealsUntilStarvationForTest,
  addChamberForTest,
} from '../sim/food/food-test-utils.js';

function setupWorld(): { world: WorldState; colony: ColonyRecord; queenId: number } {
  const world = createWorldState(64);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId: 1,
    posX: 0,
    posY: 0,
    task: AntTask.Idle,
    hp: COMBAT_HP_QUEEN,
  });
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
    world.ants.alive[queenId] = 0; // HUD fixture: stage a dead slot, not a sim death
    const s = computeHudStats(world, colony);
    expect(s.antCount).toBe(4);
    expect(s.queenAlive).toBe(false);
  });

  it('foodDisplay converts from fixed-point to human units', () => {
    const { world, colony } = setupWorld();
    setPoolFoodForTest(world, colony, 10 << FP_SHIFT);
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
    addChamberForTest(world, colony, {
      chamberId: 9001,
      chamberType: ChamberType.FoodStorage,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    addChamberForTest(world, colony, {
      chamberId: 9002,
      chamberType: ChamberType.FoodStorage,
      posX: 10,
      posY: 10,
      width: 3,
      height: 3,
    });
    const s = computeHudStats(world, colony);
    const expected = (BASE_FOOD_STORAGE_CAPACITY + 2 * FOOD_CHAMBER_CAPACITY) >> FP_SHIFT;
    expect(s.foodCapacity).toBe(expected);
  });

  // #375 — the bar is the queen's HP. From V66 starvation drains her HP, so hunger
  // alone never moves it.
  it('queenHealthPct = 100 at full HP and fed', () => {
    const { world, colony, queenId } = setupWorld();
    setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, STARVATION_GRACE_TICKS);
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
  });

  // #400 (V71): her max HP where she stands — COMBAT_HP_QUEEN on the surface (the
  // fixture's queen, before she founds her nest), QUEEN_HP_HOME in her nest.
  const pctOf = (hp: number, max: number): number => Math.round((hp * 100) / max);

  it('queenHealthPct is HP / her max HP on the surface (#375: a wounded queen does not read 100)', () => {
    const { world, colony, queenId } = setupWorld();
    setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, STARVATION_GRACE_TICKS);
    world.ants.hp[queenId] = 6;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(pctOf(6, COMBAT_HP_QUEEN));
    world.ants.hp[queenId] = 15;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(pctOf(15, COMBAT_HP_QUEEN));
    world.ants.hp[queenId] = COMBAT_HP_QUEEN - 1;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(
      pctOf(COMBAT_HP_QUEEN - 1, COMBAT_HP_QUEEN),
    );
  });

  it('#400: in her nest the bar is out of QUEEN_HP_HOME, so it drops from the first blow', () => {
    const { world, colony, queenId } = setupWorld();
    world.ants.zone[queenId] = Zone.Underground; // currentGridColonyId is her own (initAnt)
    setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, STARVATION_GRACE_TICKS);
    world.ants.hp[queenId] = QUEEN_HP_HOME;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
    world.ants.hp[queenId] = QUEEN_HP_HOME - 5; // one fighter's home-ground blow
    expect(computeHudStats(world, colony).queenHealthPct).toBe(
      pctOf(QUEEN_HP_HOME - 5, QUEEN_HP_HOME),
    );
    expect(computeHudStats(world, colony).queenHealthPct).toBeLessThan(100);
    // Coming home raises the max but does not heal: her surface HP reads below full.
    world.ants.hp[queenId] = COMBAT_HP_QUEEN;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(
      pctOf(COMBAT_HP_QUEEN, QUEEN_HP_HOME),
    );
    // Inside an enemy nest she would be away (never happens; the rule is colony-blind).
    world.ants.currentGridColonyId[queenId] = 2;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
  });

  it('V66: hunger alone does not move the bar (only the HP it drains does)', () => {
    const { world, colony, queenId } = setupWorld();
    setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, 5);
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
    world.ants.hp[queenId] = 12;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(pctOf(12, COMBAT_HP_QUEEN));
  });

  it('queenHealthPct clamps to [0, 100]', () => {
    const { world, colony, queenId } = setupWorld();
    setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, STARVATION_GRACE_TICKS * 5);
    world.ants.hp[queenId] = COMBAT_HP_QUEEN * 2;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(100);
    world.ants.hp[queenId] = -4;
    expect(computeHudStats(world, colony).queenHealthPct).toBe(0);
  });

  it('queenHealthPct = 0 when queen is dead, even at full HP', () => {
    const { world, colony, queenId } = setupWorld();
    setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, STARVATION_GRACE_TICKS);
    world.ants.alive[queenId] = 0; // HUD fixture: stage a dead slot, not a sim death
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

describe('queenStoresRect (#413 — the "Waiting for stores" strip)', () => {
  const stats = { x: 8, y: 8, w: 200, h: 24 };
  const { gapY, h, textInset } = HUD_STATS_LAYOUT.queenStores;

  it('sits just under the stats rect, left-aligned with it, without touching it', () => {
    const r = queenStoresRect(stats, 150);
    expect(r.x).toBe(stats.x);
    expect(r.y).toBe(stats.y + stats.h + gapY);
    expect(r.y).toBeGreaterThan(stats.y + stats.h - 1);
    expect(r.h).toBe(h);
  });

  it('is as wide as the text plus its padding (a fractional width rounds up)', () => {
    expect(queenStoresRect(stats, 150).w).toBe(150 + 2 * textInset);
    expect(queenStoresRect(stats, 150.2).w).toBe(151 + 2 * textInset);
  });

  // A little over the ~5.4 px a char of the line's 9px monospace
  // (HUD_STATS_LAYOUT.queenStores.fontSize; storage-hint.spec.ts measures the strip the
  // real renderer draws).
  const CHAR_W = 5.5;

  it('a three-digit line ("Waiting for stores: 100/108") ends left of the widest top caption', () => {
    expect(HUD_STATS_LAYOUT.queenStores.fontSize).toBe('9px');
    // GameScene centres top captions at (w/2, 60).
    const hud = buildHudLayout(DEFAULT_LAYOUT);
    const cx = DEFAULT_LAYOUT.w / 2;
    const captionLeft = cx - (captionWrapWidth(cx, 60, hud) + 2 * CAPTION_PAD_X) / 2;
    const r = queenStoresRect(hud.STATS, 27 * CHAR_W);
    expect(r.x + r.w).toBeLessThanOrEqual(captionLeft);
  });

  it('lies under the ant-activity popup, which UIScene hides it behind', () => {
    const r = queenStoresRect(stats, 150);
    const panel = antActivityPanelRect(stats);
    expect(r.x).toBeGreaterThanOrEqual(panel.x);
    expect(r.x + r.w).toBeLessThanOrEqual(panel.x + panel.w);
    expect(r.y + r.h).toBeGreaterThan(panel.y);
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
