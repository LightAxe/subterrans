// src/render/opponent-copy.test.ts
// Pins the opponent section's strings (issue #304 items 3–4 — the caption over
// the free-text box is an acceptance criterion verbatim) and guards the one
// property the layout relies on: each row's description fits its single line.
import { describe, it, expect } from 'vitest';
import {
  JEV_ORDERS_CAPTION,
  JEV_ORDERS_PLACEHOLDER,
  NEW_GAME_OPPONENT_CAPTION,
  OPPONENT_ROW_COPY,
} from './opponent-copy.js';
import {
  DIFFICULTY_ROW_PAD_RIGHT,
  NEW_GAME_COLUMN_MAX_W,
  OPPONENT_KINDS,
  OPPONENT_ROW_DESC_X,
} from './boot-overlay-layout.js';

/** Widest advance a 12 px monospace glyph gets in the browsers we ship to
 *  (Menlo / Consolas / DejaVu Sans Mono all sit at 0.60–0.62 em; 0.625 em is
 *  the ceiling). The rows are one line tall, so a description that would wrap
 *  at this advance is a layout bug, not a copy nit. */
const MAX_MONO_12PX_ADVANCE = 7.5;

describe('opponent copy (#304 items 3–4)', () => {
  it('names the section and the two rows as the issue asks', () => {
    expect(NEW_GAME_OPPONENT_CAPTION).toBe('Opponent');
    expect(OPPONENT_ROW_COPY.rules.name).toBe('Standard AI');
    expect(OPPONENT_ROW_COPY.jev.name).toBe('Jev (beta)');
    expect(OPPONENT_ROW_COPY.rules.desc).toBe('The built-in rule-based enemy colony.');
    expect(OPPONENT_ROW_COPY.jev.desc).toBe(
      "TypeSafe's Jev model plays the enemy; you can instruct it.",
    );
  });

  it('captions the free-text box "Custom instructions for Jev, your opponent"', () => {
    expect(JEV_ORDERS_CAPTION).toBe('Custom instructions for Jev, your opponent');
    expect(JEV_ORDERS_PLACEHOLDER).toBe('Tell Jev how to play (optional)');
  });

  it('every row description fits its single-line description column', () => {
    const columnW = NEW_GAME_COLUMN_MAX_W - OPPONENT_ROW_DESC_X - DIFFICULTY_ROW_PAD_RIGHT;
    const maxChars = Math.floor(columnW / MAX_MONO_12PX_ADVANCE);
    for (const kind of OPPONENT_KINDS) {
      const { desc } = OPPONENT_ROW_COPY[kind];
      expect(desc.length, `${kind}: "${desc}"`).toBeLessThanOrEqual(maxChars);
      expect(desc).not.toContain('\n');
    }
  });
});
