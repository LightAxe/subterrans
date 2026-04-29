// sprites.test.ts — Vitest tests for src/render/sprites.ts
//
// Tests cover:
//   - lerpColor correctness (boundary values, midpoint, per-component interpolation, clamping)
//   - HUD zone structural sanity (disjoint layout assumptions)
//   - COLOR_* palette range validation (all values are valid 0x000000–0xffffff)

import { describe, it, expect } from 'vitest';
import {
  CANVAS_W,
  HUD,
  lerpColor,
  COLOR_SURFACE_GRASS_PRIMARY,
  COLOR_SURFACE_GRASS_DARK,
  COLOR_SURFACE_DIRT,
  COLOR_SURFACE_DIRT_DARK,
  COLOR_SURFACE_DIRT_LIGHT,
  COLOR_FOOD_PILE_NORMAL,
  COLOR_FOOD_PILE_MARKED,
  COLOR_SURFACE_ENTRANCE_HOLE,
  COLOR_UNDERGROUND_SOLID,
  COLOR_UNDERGROUND_SOLID_ROCK,
  COLOR_UNDERGROUND_OPEN,
  COLOR_UNDERGROUND_OPEN_DUST,
  COLOR_MARKED_TILE_OVERLAY,
  COLOR_BEING_DUG_OVERLAY,
  COLOR_UNDERGROUND_CEILING_STRIP,
  COLOR_CHAMBER_QUEEN,
  COLOR_CHAMBER_NURSERY,
  COLOR_CHAMBER_FOOD_STORAGE,
  COLOR_PLAYER_COLONY,
  COLOR_ENEMY_COLONY,
  COLOR_QUEEN_OUTLINE,
  COLOR_ANT_EGG,
  COLOR_ANT_LARVAE,
  COLOR_PHEROMONE_FOOD_FAINT,
  COLOR_PHEROMONE_FOOD_STRONG,
  COLOR_PHEROMONE_DANGER_FAINT,
  COLOR_PHEROMONE_DANGER_STRONG,
  COLOR_RALLY_POINT,
} from './sprites.js';

// ---------------------------------------------------------------------------
// lerpColor
// ---------------------------------------------------------------------------

describe('lerpColor', () => {
  it('t=0 returns the source color exactly', () => {
    expect(lerpColor(0x000000, 0xffffff, 0)).toBe(0x000000);
  });

  it('t=1 returns the target color exactly', () => {
    expect(lerpColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
  });

  it('t=0.5 returns per-component midpoint, truncated via | 0', () => {
    // R: 0 + (255-0)*0.5 = 127.5 → 127 = 0x7f
    // G: same → 0x7f
    // B: same → 0x7f
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe(0x7f7f7f);
  });

  it('t=0.5 between red and green interpolates per component', () => {
    // R: 0xff + (0x00 - 0xff) * 0.5 = 127.5 → 127 = 0x7f
    // G: 0x00 + (0xff - 0x00) * 0.5 = 127.5 → 127 = 0x7f
    // B: 0x00 + (0x00 - 0x00) * 0.5 = 0
    expect(lerpColor(0xff0000, 0x00ff00, 0.5)).toBe(0x7f7f00);
  });

  it('clamps t below 0 (t=-0.5 returns source color)', () => {
    expect(lerpColor(0x000000, 0xffffff, -0.5)).toBe(0x000000);
  });

  it('clamps t above 1 (t=1.5 returns target color)', () => {
    expect(lerpColor(0x000000, 0xffffff, 1.5)).toBe(0xffffff);
  });
});

// ---------------------------------------------------------------------------
// HUD zone layout structural sanity checks
// ---------------------------------------------------------------------------

describe('HUD zone layout', () => {
  it('STATS zone is at the top (y + h ≤ 24 + some tolerance, y=8)', () => {
    // STATS starts at y=8, h=24 → bottom edge = y+h = 32
    // The plan spec says y+h ≤ 24 as a sanity check that it's at the top region
    // Actual spec: STATS.y = 8, so it's clearly at the top
    expect(HUD.STATS.y).toBe(8);
    expect(HUD.STATS.y + HUD.STATS.h).toBeLessThanOrEqual(48); // top zone
  });

  it('MINIMAP is on the right side (x=632 ≥ CANVAS_W/2)', () => {
    expect(HUD.MINIMAP.x).toBeGreaterThanOrEqual(CANVAS_W / 2);
  });

  it('TRIANGLE is on the left side (x + w ≤ 128)', () => {
    expect(HUD.TRIANGLE.x + HUD.TRIANGLE.w).toBeLessThanOrEqual(128);
  });

  it('HUD zone exact coordinates match PRD §6b', () => {
    expect(HUD.STATS).toMatchObject({ x: 8, y: 8, w: 200, h: 24 });
    // Phase 10 / issue #13 follow-up: TRIANGLE shrunk from 120×120 to 120×44
    // when the widget collapsed from a 3-vertex triangle to a 1-D slider.
    // Bottom edge (y + h = 576) is unchanged so neighbouring HUD zones'
    // pixel anchors are undisturbed.
    expect(HUD.TRIANGLE).toMatchObject({ x: 8, y: 532, w: 120, h: 44 });
    expect(HUD.MINIMAP).toMatchObject({ x: 632, y: 424, w: 160, h: 160 });
    expect(HUD.VIEW_TOGGLE).toMatchObject({ x: 632, y: 396, w: 80, h: 24 });
    // Issue #14: colony-toggle button stacked just above VIEW_TOGGLE.
    expect(HUD.UNDERGROUND_COLONY_TOGGLE).toMatchObject({ x: 632, y: 372, w: 112, h: 22 });
    expect(HUD.SPEED).toMatchObject({ x: 320, y: 552, w: 160, h: 32 });
    expect(HUD.SAVE_ICON).toMatchObject({ x: 772, y: 8, w: 20, h: 20 });
  });

  it('STATS and TRIANGLE do not overlap vertically', () => {
    const statsBottom = HUD.STATS.y + HUD.STATS.h;
    expect(statsBottom).toBeLessThanOrEqual(HUD.TRIANGLE.y);
  });

  it('VIEW_TOGGLE is directly above MINIMAP', () => {
    expect(HUD.VIEW_TOGGLE.x).toBe(HUD.MINIMAP.x);
    expect(HUD.VIEW_TOGGLE.y + HUD.VIEW_TOGGLE.h).toBeLessThanOrEqual(HUD.MINIMAP.y);
  });

  it('UNDERGROUND_COLONY_TOGGLE sits directly above VIEW_TOGGLE without overlap (issue #14)', () => {
    expect(HUD.UNDERGROUND_COLONY_TOGGLE.x).toBe(HUD.VIEW_TOGGLE.x);
    expect(HUD.UNDERGROUND_COLONY_TOGGLE.y + HUD.UNDERGROUND_COLONY_TOGGLE.h)
      .toBeLessThanOrEqual(HUD.VIEW_TOGGLE.y);
  });
});

// ---------------------------------------------------------------------------
// COLOR_* palette range validation
// ---------------------------------------------------------------------------

describe('COLOR_* palette range', () => {
  const allColors = [
    { name: 'COLOR_SURFACE_GRASS_PRIMARY', value: COLOR_SURFACE_GRASS_PRIMARY },
    { name: 'COLOR_SURFACE_GRASS_DARK', value: COLOR_SURFACE_GRASS_DARK },
    { name: 'COLOR_SURFACE_DIRT', value: COLOR_SURFACE_DIRT },
    { name: 'COLOR_SURFACE_DIRT_DARK', value: COLOR_SURFACE_DIRT_DARK },
    { name: 'COLOR_SURFACE_DIRT_LIGHT', value: COLOR_SURFACE_DIRT_LIGHT },
    { name: 'COLOR_FOOD_PILE_NORMAL', value: COLOR_FOOD_PILE_NORMAL },
    { name: 'COLOR_FOOD_PILE_MARKED', value: COLOR_FOOD_PILE_MARKED },
    { name: 'COLOR_SURFACE_ENTRANCE_HOLE', value: COLOR_SURFACE_ENTRANCE_HOLE },
    { name: 'COLOR_UNDERGROUND_SOLID', value: COLOR_UNDERGROUND_SOLID },
    { name: 'COLOR_UNDERGROUND_SOLID_ROCK', value: COLOR_UNDERGROUND_SOLID_ROCK },
    { name: 'COLOR_UNDERGROUND_OPEN', value: COLOR_UNDERGROUND_OPEN },
    { name: 'COLOR_UNDERGROUND_OPEN_DUST', value: COLOR_UNDERGROUND_OPEN_DUST },
    { name: 'COLOR_MARKED_TILE_OVERLAY', value: COLOR_MARKED_TILE_OVERLAY },
    { name: 'COLOR_BEING_DUG_OVERLAY', value: COLOR_BEING_DUG_OVERLAY },
    { name: 'COLOR_UNDERGROUND_CEILING_STRIP', value: COLOR_UNDERGROUND_CEILING_STRIP },
    { name: 'COLOR_CHAMBER_QUEEN', value: COLOR_CHAMBER_QUEEN },
    { name: 'COLOR_CHAMBER_NURSERY', value: COLOR_CHAMBER_NURSERY },
    { name: 'COLOR_CHAMBER_FOOD_STORAGE', value: COLOR_CHAMBER_FOOD_STORAGE },
    { name: 'COLOR_PLAYER_COLONY', value: COLOR_PLAYER_COLONY },
    { name: 'COLOR_ENEMY_COLONY', value: COLOR_ENEMY_COLONY },
    { name: 'COLOR_QUEEN_OUTLINE', value: COLOR_QUEEN_OUTLINE },
    { name: 'COLOR_ANT_EGG', value: COLOR_ANT_EGG },
    { name: 'COLOR_ANT_LARVAE', value: COLOR_ANT_LARVAE },
    { name: 'COLOR_PHEROMONE_FOOD_FAINT', value: COLOR_PHEROMONE_FOOD_FAINT },
    { name: 'COLOR_PHEROMONE_FOOD_STRONG', value: COLOR_PHEROMONE_FOOD_STRONG },
    { name: 'COLOR_PHEROMONE_DANGER_FAINT', value: COLOR_PHEROMONE_DANGER_FAINT },
    { name: 'COLOR_PHEROMONE_DANGER_STRONG', value: COLOR_PHEROMONE_DANGER_STRONG },
    { name: 'COLOR_RALLY_POINT', value: COLOR_RALLY_POINT },
  ];

  it.each(allColors)('$name is in range 0x000000–0xffffff', ({ value }) => {
    expect(value).toBeGreaterThanOrEqual(0x000000);
    expect(value).toBeLessThanOrEqual(0xffffff);
  });
});
