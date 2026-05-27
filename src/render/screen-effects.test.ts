// screen-effects.test.ts — S6 smoke tests for the screen-effects module.
//
// Verifies constants export at expected values and that inferFlashDirection
// returns the correct screen edge for directional inputs.
// triggerScreenEdgeFlash and triggerQueenDamagePulse are Phaser-dependent;
// they are not tested here (render-only, tested manually per the S6 plan).

import { describe, it, expect } from 'vitest';
import {
  SCREEN_EDGE_FLASH_DURATION_MS,
  QUEEN_DAMAGE_PULSE_DURATION_MS,
  QUEEN_DAMAGE_SUPPRESS_TICKS,
  inferFlashDirection,
} from './screen-effects.js';

describe('screen-effects constants', () => {
  it('SCREEN_EDGE_FLASH_DURATION_MS is 2000', () => {
    expect(SCREEN_EDGE_FLASH_DURATION_MS).toBe(2000);
  });

  it('QUEEN_DAMAGE_PULSE_DURATION_MS is 200', () => {
    expect(QUEEN_DAMAGE_PULSE_DURATION_MS).toBe(200);
  });

  it('QUEEN_DAMAGE_SUPPRESS_TICKS is 40', () => {
    expect(QUEEN_DAMAGE_SUPPRESS_TICKS).toBe(40);
  });
});

describe('inferFlashDirection', () => {
  // Queen at (10, 10); entrance at various positions

  it('entrance directly to the right → "right"', () => {
    expect(inferFlashDirection(10, 10, 20, 10)).toBe('right');
  });

  it('entrance directly to the left → "left"', () => {
    expect(inferFlashDirection(10, 10, 0, 10)).toBe('left');
  });

  it('entrance directly below → "bottom"', () => {
    expect(inferFlashDirection(10, 10, 10, 20)).toBe('bottom');
  });

  it('entrance directly above → "top"', () => {
    expect(inferFlashDirection(10, 10, 10, 0)).toBe('top');
  });

  it('diagonal: larger dx than dy → horizontal axis wins', () => {
    // dx=10, dy=3 → right
    expect(inferFlashDirection(0, 0, 10, 3)).toBe('right');
  });

  it('diagonal: larger dy than dx → vertical axis wins', () => {
    // dx=3, dy=10 → bottom
    expect(inferFlashDirection(0, 0, 3, 10)).toBe('bottom');
  });

  it('equal |dx| and |dy| → horizontal wins (dx >= dy branch)', () => {
    // dx=5, dy=5 → right (Math.abs(dx) >= Math.abs(dy))
    expect(inferFlashDirection(0, 0, 5, 5)).toBe('right');
  });

  it('left diagonal: larger |dx| negative → "left"', () => {
    expect(inferFlashDirection(10, 5, 2, 6)).toBe('left');
  });

  it('top diagonal: larger |dy| negative → "top"', () => {
    expect(inferFlashDirection(5, 10, 6, 2)).toBe('top');
  });
});
