// src/render/boot-overlay-layout.test.ts
// #240 — pins (a) the extracted boot-overlay rects and (b) the layout-function
// outputs that tests/helpers/geometry.ts reads, to the exact literals the
// Playwright specs used to hard-duplicate. If a layout change shifts any of these,
// this fails in `verify` (fast) instead of only surfacing in a slow e2e run — and
// proves the decoupling was a pure refactor (the plan's "mapping table" as tests).
//
// #304 — the new-game screen is a pure function of the LayoutContext (a section
// stack). Its rects at the default layout are pinned the same way, and the stack
// invariants (order, spacing, centering, the empty opponent slot) are checked at
// a non-default layout too.
//
// Re-derives from the SRC layout modules (not the tests/ helper) so it stays within
// tsc's rootDir; the helper simply reads indices [1]/[2] etc. of these same outputs,
// and the helper→spec wiring is covered end-to-end by the Playwright run.
import { describe, it, expect } from 'vitest';
import {
  SAVE_PROMPT_CONTINUE_RECT,
  SAVE_PROMPT_NEW_GAME_RECT,
  GAME_OVER_RESTART_RECT,
  DIFFICULTY_TIERS,
  DIFFICULTY_ROW_H,
  DIFFICULTY_ROW_GAP,
  DIFFICULTY_ROW_DESC_X,
  DIFFICULTY_ROW_PAD_RIGHT,
  NEW_GAME_SECTION_GAP,
  NEW_GAME_CAPTION_H,
  NEW_GAME_STACK_MIN_TOP,
  NEW_GAME_START_H,
  NEW_GAME_START_HINT_H,
  NEW_GAME_TITLE_H,
  NEW_GAME_SUBTITLE_H,
  difficultyRowInner,
  newGameColumnW,
  newGameScreenLayout,
  OPPONENT_KINDS,
  OPPONENT_ROW_H,
  OPPONENT_ROW_GAP,
  OPPONENT_ROW_DESC_X,
  JEV_OPTIONS_GAP,
  JEV_OPTIONS_CAPTION_H,
  JEV_COUNTER_GAP,
  JEV_PRESET_H,
  JEV_PRESET_GAP,
  JEV_PRESET_ROW_GAP,
  JEV_TEXTAREA_H,
  newGameScreenWithOpponent,
  opponentRowInner,
  opponentSectionH,
  opponentSectionLayout,
  type BootOverlayRect,
  type OpponentSectionOptions,
} from './boot-overlay-layout.js';
import { JEV_ORDERS_PRESETS } from './jev-orders.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';
import { pauseMenuItems, type PauseMenuRenderContext } from './pause-menu-layout.js';
import { saveLoadDialogItems, type SaveLoadDialogContext } from './save-load-dialog-layout.js';
import { buildHudLayout } from './hud-layout.js';

// Same contexts tests/helpers/geometry.ts uses (playtrace off → 4-row main menu).
const MAIN: PauseMenuRenderContext = {
  saveLoadEnabled: true,
  currentPheromoneOverlay: false,
  currentHintStripVisible: true,
  currentSpeedMultiplier: 1,
  quitAndSurveyEnabled: false,
};
const DLG: SaveLoadDialogContext = {
  hasCompatibleSave: true,
  hasIncompatibleSave: false,
  confirming: { delete: false, newGame: false },
};

const overlaps = (a: BootOverlayRect, b: BootOverlayRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('#240 boot-overlay rects are frozen (moved out of ui-scene.ts)', () => {
  it('holds the three legacy boot-overlay rect values', () => {
    expect(SAVE_PROMPT_CONTINUE_RECT).toEqual({ x: 300, y: 280, w: 120, h: 32 });
    expect(SAVE_PROMPT_NEW_GAME_RECT).toEqual({ x: 300, y: 320, w: 120, h: 32 });
    expect(GAME_OVER_RESTART_RECT).toEqual({ x: 300, y: 345, w: 120, h: 32 });
  });
});

describe('#304 new-game screen at the default layout (what the specs click)', () => {
  const geo = newGameScreenLayout(DEFAULT_LAYOUT);

  it('pins the difficulty rows and the Start button', () => {
    // Stack height 366 → centered top 113; rows start under the 66 px title
    // block, the 20 px gap and the 22 px caption; Start sits one gap below Hard.
    expect(geo.stack).toEqual({ x: 90, y: 113, w: 620, h: 366 });
    expect(geo.difficultyRows.Easy).toEqual({ x: 90, y: 221, w: 620, h: 52 });
    expect(geo.difficultyRows.Normal).toEqual({ x: 90, y: 281, w: 620, h: 52 });
    expect(geo.difficultyRows.Hard).toEqual({ x: 90, y: 341, w: 620, h: 52 });
    expect(geo.startButton).toEqual({ x: 290, y: 413, w: 220, h: 44 });
    expect(geo.startHint).toEqual({ x: 400, y: 468 });
  });

  it('leaves the opponent slot empty (height 0) and spends no gap on it', () => {
    expect(geo.opponentSlot.h).toBe(0);
    const rowsBottom = geo.difficultyRows.Hard.y + geo.difficultyRows.Hard.h;
    expect(geo.startButton.y).toBe(rowsBottom + NEW_GAME_SECTION_GAP);
    // The empty slot's anchor is where it WOULD start — i.e. where Start starts.
    expect(geo.opponentSlot.y).toBe(geo.startButton.y);
    expect(geo.opponentSlot.x).toBe(geo.difficultyRows.Hard.x);
    expect(geo.opponentSlot.w).toBe(geo.difficultyRows.Hard.w);
  });

  it('centers the stack as a group and keeps it inside the canvas', () => {
    const { stack } = geo;
    expect(stack.y).toBeCloseTo((DEFAULT_LAYOUT.h - stack.h) / 2, 6);
    expect(stack.y).toBeGreaterThanOrEqual(NEW_GAME_STACK_MIN_TOP);
    expect(stack.y + stack.h).toBeLessThanOrEqual(DEFAULT_LAYOUT.h);
    expect(stack.x).toBe((DEFAULT_LAYOUT.w - stack.w) / 2);
    expect(geo.title.x).toBe(DEFAULT_LAYOUT.w / 2);
    expect(geo.startHint.x).toBe(DEFAULT_LAYOUT.w / 2);
  });

  it('the title and subtitle sit above the caption, which sits above the first row', () => {
    expect(geo.title.y).toBeLessThan(geo.subtitle.y);
    expect(geo.subtitle.y).toBeLessThan(geo.difficultyCaption.y);
    expect(geo.difficultyCaption.y + NEW_GAME_CAPTION_H).toBe(geo.difficultyRows.Easy.y);
    expect(geo.title.y).toBe(geo.stack.y + NEW_GAME_TITLE_H / 2);
    expect(geo.subtitle.y).toBe(geo.stack.y + NEW_GAME_TITLE_H + NEW_GAME_SUBTITLE_H / 2);
  });

  it('stacks the rows in tier order with a uniform gap and no overlap', () => {
    const rows = DIFFICULTY_TIERS.map((t) => geo.difficultyRows[t]);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.y).toBe(rows[i - 1]!.y + DIFFICULTY_ROW_H + DIFFICULTY_ROW_GAP);
      expect(overlaps(rows[i]!, rows[i - 1]!)).toBe(false);
    }
    for (const r of rows) expect(overlaps(r, geo.startButton)).toBe(false);
  });

  it('the Start hint hangs under the button at the bottom of the stack', () => {
    const buttonBottom = geo.startButton.y + geo.startButton.h;
    expect(geo.startHint.y).toBe(buttonBottom + NEW_GAME_START_HINT_H / 2);
    expect(buttonBottom + NEW_GAME_START_HINT_H).toBe(geo.stack.y + geo.stack.h);
    expect(geo.startButton.h).toBe(NEW_GAME_START_H);
  });

  it('row inner anchors: radio, name, then a description column to the right edge', () => {
    const row = geo.difficultyRows.Normal;
    const inner = difficultyRowInner(row);
    expect(inner.radio.y).toBe(row.y + row.h / 2);
    expect(inner.radio.x).toBeLessThan(inner.name.x);
    expect(inner.name.x).toBeLessThan(inner.desc.x);
    expect(inner.desc.x).toBe(row.x + DIFFICULTY_ROW_DESC_X);
    expect(inner.desc.w).toBe(row.w - DIFFICULTY_ROW_DESC_X - DIFFICULTY_ROW_PAD_RIGHT);
    expect(inner.desc.x + inner.desc.w).toBeLessThanOrEqual(row.x + row.w);
  });
});

describe('#304 new-game screen — the opponent slot and other layouts', () => {
  it('an opponent section slides in between Difficulty and Start, and the stack re-centers', () => {
    const h = 120;
    const geo = newGameScreenLayout(DEFAULT_LAYOUT, { opponentSectionH: h });
    const rowsBottom = geo.difficultyRows.Hard.y + geo.difficultyRows.Hard.h;
    expect(geo.opponentSlot).toEqual({
      x: geo.difficultyRows.Hard.x,
      y: rowsBottom + NEW_GAME_SECTION_GAP,
      w: geo.difficultyRows.Hard.w,
      h,
    });
    expect(geo.startButton.y).toBe(geo.opponentSlot.y + h + NEW_GAME_SECTION_GAP);
    const plain = newGameScreenLayout(DEFAULT_LAYOUT);
    expect(geo.stack.h).toBe(plain.stack.h + h + NEW_GAME_SECTION_GAP);
    expect(geo.stack.y).toBeCloseTo((DEFAULT_LAYOUT.h - geo.stack.h) / 2, 6);
  });

  it('a negative or zero opponent height means no slot, same as omitting it', () => {
    expect(newGameScreenLayout(DEFAULT_LAYOUT, { opponentSectionH: 0 })).toEqual(
      newGameScreenLayout(DEFAULT_LAYOUT),
    );
    expect(newGameScreenLayout(DEFAULT_LAYOUT, { opponentSectionH: -5 })).toEqual(
      newGameScreenLayout(DEFAULT_LAYOUT),
    );
  });

  it('a stack taller than the canvas clamps to the top inset instead of going off-top', () => {
    const geo = newGameScreenLayout(DEFAULT_LAYOUT, { opponentSectionH: 400 });
    expect(geo.stack.y).toBe(NEW_GAME_STACK_MIN_TOP);
  });

  it('re-centers horizontally and vertically on a different LayoutContext', () => {
    const wide = createLayoutContext(1200, 900);
    const geo = newGameScreenLayout(wide);
    expect(geo.stack.x).toBe((1200 - geo.stack.w) / 2);
    expect(geo.stack.y).toBe((900 - geo.stack.h) / 2);
    expect(geo.title.x).toBe(600);
    expect(geo.startButton.x + geo.startButton.w / 2).toBe(600);
  });

  it('a narrow layout shrinks the column (and the Start button) rather than overflowing', () => {
    const narrow = createLayoutContext(360, 640);
    expect(newGameColumnW(narrow)).toBe(360 - 32);
    const geo = newGameScreenLayout(narrow);
    for (const t of DIFFICULTY_TIERS) {
      const r = geo.difficultyRows[t];
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(360);
    }
    expect(geo.startButton.x).toBeGreaterThanOrEqual(0);
    expect(geo.startButton.x + geo.startButton.w).toBeLessThanOrEqual(360);
  });
});

describe('#240 layout functions equal the specs’ former inline literals', () => {
  it('pause-menu main rows (playtrace off → 4 rows): save-load [1], settings [2]', () => {
    const main = pauseMenuItems('main', MAIN, DEFAULT_LAYOUT);
    expect(main[1]!.rect).toEqual({ x: 240, y: 279, w: 320, h: 40 });
    expect(main[2]!.rect).toEqual({ x: 240, y: 329, w: 320, h: 40 });
  });

  it('settings-page rows (5 rows): pheromone [0], speed [3]', () => {
    const settings = pauseMenuItems('settings', MAIN, DEFAULT_LAYOUT);
    expect(settings[0]!.rect).toEqual({ x: 240, y: 204, w: 320, h: 40 });
    expect(settings[3]!.rect).toEqual({ x: 240, y: 354, w: 320, h: 40 });
  });

  it('save/load dialog rows: save-now [1], delete [2]', () => {
    const dlg = saveLoadDialogItems(DLG, DEFAULT_LAYOUT);
    expect(dlg[1]!.rect).toEqual({ x: 260, y: 220, w: 280, h: 36 });
    expect(dlg[2]!.rect).toEqual({ x: 260, y: 264, w: 280, h: 36 });
  });

  it('HUD view-toggle button', () => {
    expect(buildHudLayout(DEFAULT_LAYOUT).VIEW_TOGGLE).toEqual({ x: 632, y: 396, w: 80, h: 24 });
  });
});

// ---------------------------------------------------------------------------
// Jev opponent beta (#304 items 3–4) — the opponent section in the slot
// ---------------------------------------------------------------------------

const PRESET_COUNT = JEV_ORDERS_PRESETS.length;
const RULES: OpponentSectionOptions = {
  jevAvailable: true,
  jevSelected: false,
  presetCount: PRESET_COUNT,
};
const JEV: OpponentSectionOptions = { ...RULES, jevSelected: true };
const NONE: OpponentSectionOptions = { ...RULES, jevAvailable: false };

describe('opponent section — no Jev endpoint', () => {
  it('has no height and no layout, so the screen is exactly main’s', () => {
    expect(opponentSectionH(NONE)).toBe(0);
    expect(opponentSectionH({ ...NONE, jevSelected: true })).toBe(0);
    const { screen, opponent } = newGameScreenWithOpponent(DEFAULT_LAYOUT, NONE);
    expect(opponent).toBeNull();
    expect(screen).toEqual(newGameScreenLayout(DEFAULT_LAYOUT));
  });
});

describe('opponent section — Standard AI selected (collapsed)', () => {
  const { screen, opponent } = newGameScreenWithOpponent(DEFAULT_LAYOUT, RULES);
  const geo = opponent!;

  it('is a caption plus the two rows, filling the slot exactly', () => {
    const rowsH = 2 * OPPONENT_ROW_H + OPPONENT_ROW_GAP;
    expect(opponentSectionH(RULES)).toBe(NEW_GAME_CAPTION_H + rowsH);
    expect(screen.opponentSlot.h).toBe(opponentSectionH(RULES));
    expect(geo.caption).toEqual({ x: screen.opponentSlot.x, y: screen.opponentSlot.y });
    expect(geo.rows.rules.y).toBe(screen.opponentSlot.y + NEW_GAME_CAPTION_H);
    expect(geo.rows.jev.y).toBe(geo.rows.rules.y + OPPONENT_ROW_H + OPPONENT_ROW_GAP);
    const last = geo.rows.jev;
    expect(last.y + last.h).toBe(screen.opponentSlot.y + screen.opponentSlot.h);
    expect(geo.jev).toBeNull();
  });

  it('rows span the column, in OPPONENT_KINDS order, between Difficulty and Start', () => {
    for (const kind of OPPONENT_KINDS) {
      expect(geo.rows[kind].x).toBe(screen.difficultyRows.Hard.x);
      expect(geo.rows[kind].w).toBe(screen.difficultyRows.Hard.w);
      expect(geo.rows[kind].h).toBe(OPPONENT_ROW_H);
      expect(overlaps(geo.rows[kind], screen.difficultyRows.Hard)).toBe(false);
      expect(overlaps(geo.rows[kind], screen.startButton)).toBe(false);
    }
    const rowsBottom = screen.difficultyRows.Hard.y + screen.difficultyRows.Hard.h;
    expect(geo.rows.rules.y).toBeGreaterThan(rowsBottom);
    expect(geo.rows.jev.y + geo.rows.jev.h).toBeLessThan(screen.startButton.y);
    expect(overlaps(geo.rows.rules, geo.rows.jev)).toBe(false);
  });

  it('row inner anchors: radio, name, then a wider-offset description column', () => {
    const inner = opponentRowInner(geo.rows.jev);
    const difficulty = difficultyRowInner(screen.difficultyRows.Hard);
    expect(inner.radio.x).toBe(difficulty.radio.x);
    expect(inner.name.x).toBe(difficulty.name.x);
    expect(inner.radio.y).toBe(geo.rows.jev.y + geo.rows.jev.h / 2);
    expect(inner.desc.x).toBe(geo.rows.jev.x + OPPONENT_ROW_DESC_X);
    expect(inner.desc.x).toBeGreaterThan(difficulty.desc.x);
    expect(inner.desc.w).toBe(geo.rows.jev.w - OPPONENT_ROW_DESC_X - DIFFICULTY_ROW_PAD_RIGHT);
  });

  it('still centres the stack (it is not at the top clamp)', () => {
    expect(screen.stack.y).toBeGreaterThan(NEW_GAME_STACK_MIN_TOP);
    expect(screen.stack.y).toBeCloseTo((DEFAULT_LAYOUT.h - screen.stack.h) / 2, 6);
  });
});

describe('opponent section — Jev selected (expanded)', () => {
  const { screen, opponent } = newGameScreenWithOpponent(DEFAULT_LAYOUT, JEV);
  const geo = opponent!;
  const jev = geo.jev!;

  it('adds the Jev options below the rows and still fills the slot exactly', () => {
    const optionsH =
      JEV_OPTIONS_GAP + JEV_OPTIONS_CAPTION_H + JEV_PRESET_H + JEV_PRESET_ROW_GAP + JEV_TEXTAREA_H;
    expect(opponentSectionH(JEV)).toBe(opponentSectionH(RULES) + optionsH);
    expect(screen.opponentSlot.h).toBe(opponentSectionH(JEV));
    expect(jev.caption).toEqual({
      x: screen.opponentSlot.x,
      y: geo.rows.jev.y + geo.rows.jev.h + JEV_OPTIONS_GAP,
    });
    expect(JEV_COUNTER_GAP).toBeGreaterThan(0);
    expect(jev.presetButtons[0]!.y).toBe(jev.caption.y + JEV_OPTIONS_CAPTION_H);
    expect(jev.textarea.y).toBe(jev.presetButtons[0]!.y + JEV_PRESET_H + JEV_PRESET_ROW_GAP);
    expect(jev.textarea.y + jev.textarea.h).toBe(screen.opponentSlot.y + screen.opponentSlot.h);
    // The rows themselves are where the collapsed layout put them, relative to the slot.
    const collapsed = newGameScreenWithOpponent(DEFAULT_LAYOUT, RULES);
    expect(geo.rows.rules.y - screen.opponentSlot.y).toBe(
      collapsed.opponent!.rows.rules.y - collapsed.screen.opponentSlot.y,
    );
  });

  it('fits the shipping canvas with the top inset clear at BOTH ends (the 190 px budget)', () => {
    expect(opponentSectionH(JEV)).toBe(190);
    expect(screen.stack.y).toBeGreaterThanOrEqual(NEW_GAME_STACK_MIN_TOP);
    expect(screen.stack.y + screen.stack.h).toBeLessThanOrEqual(
      DEFAULT_LAYOUT.h - NEW_GAME_STACK_MIN_TOP,
    );
    // ...and the last thing drawn (the Start hint) is inside the canvas.
    expect(screen.startHint.y + NEW_GAME_START_HINT_H / 2).toBeLessThanOrEqual(DEFAULT_LAYOUT.h);
  });

  it('presets divide the column evenly, one per preset, spanning it exactly', () => {
    expect(jev.presetButtons).toHaveLength(PRESET_COUNT);
    expect(PRESET_COUNT).toBe(4); // Balanced / Aggressive / Turtle / Economy
    const first = jev.presetButtons[0]!;
    const last = jev.presetButtons[PRESET_COUNT - 1]!;
    expect(first.x).toBe(jev.textarea.x);
    expect(last.x + last.w).toBeCloseTo(jev.textarea.x + jev.textarea.w, 6);
    for (let i = 1; i < PRESET_COUNT; i++) {
      const prev = jev.presetButtons[i - 1]!;
      const cur = jev.presetButtons[i]!;
      expect(cur.x).toBeCloseTo(prev.x + prev.w + JEV_PRESET_GAP, 6);
      expect(cur.w).toBe(prev.w);
      expect(overlaps(prev, cur)).toBe(false);
    }
    // Any preset count re-divides the same span.
    for (const count of [1, 2, 3, 6]) {
      const g = opponentSectionLayout(screen.opponentSlot, { ...JEV, presetCount: count });
      const buttons = g!.jev!.presetButtons;
      expect(buttons).toHaveLength(count);
      expect(buttons[count - 1]!.x + buttons[count - 1]!.w).toBeCloseTo(
        jev.textarea.x + jev.textarea.w,
        6,
      );
    }
    expect(
      opponentSectionLayout(screen.opponentSlot, { ...JEV, presetCount: 0 })!.jev!.presetButtons,
    ).toEqual([]);
  });

  it('nothing in the section overlaps anything else on the screen', () => {
    const rects: BootOverlayRect[] = [
      ...DIFFICULTY_TIERS.map((t) => screen.difficultyRows[t]),
      ...OPPONENT_KINDS.map((k) => geo.rows[k]),
      ...jev.presetButtons,
      jev.textarea,
      screen.startButton,
    ];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!), `${i} vs ${j}`).toBe(false);
      }
    }
    // Reading order top to bottom: difficulty rows, opponent rows, options, Start.
    expect(geo.rows.rules.y).toBeGreaterThan(screen.difficultyRows.Hard.y);
    expect(jev.textarea.y).toBeGreaterThan(geo.rows.jev.y);
    expect(screen.startButton.y).toBeGreaterThan(jev.textarea.y + jev.textarea.h);
  });

  it('the difficulty rows and Start move (the stack re-centres) between the two states', () => {
    const collapsed = newGameScreenWithOpponent(DEFAULT_LAYOUT, RULES).screen;
    const grew = opponentSectionH(JEV) - opponentSectionH(RULES);
    expect(grew).toBeGreaterThan(0);
    // Everything above the section moves up; Start moves down. This is what
    // tests/helpers/geometry.ts exports two rect sets for.
    expect(screen.difficultyRows.Normal.y).toBeLessThan(collapsed.difficultyRows.Normal.y);
    expect(screen.startButton.y).toBeGreaterThan(collapsed.startButton.y);
  });

  it('reflows with the LayoutContext instead of a baked canvas size', () => {
    const wide = createLayoutContext(1200, 900);
    const w = newGameScreenWithOpponent(wide, JEV);
    expect(w.opponent!.rows.jev.x).toBe(w.screen.difficultyRows.Hard.x);
    expect(w.opponent!.jev!.textarea.x + w.opponent!.jev!.textarea.w / 2).toBe(600);
    expect(w.screen.stack.y).toBe((900 - w.screen.stack.h) / 2);
    for (const narrowW of [520, 480, 360, 320]) {
      const narrow = createLayoutContext(narrowW, 700);
      const n = newGameScreenWithOpponent(narrow, JEV);
      const all = [
        ...OPPONENT_KINDS.map((k) => n.opponent!.rows[k]),
        ...n.opponent!.jev!.presetButtons,
        n.opponent!.jev!.textarea,
      ];
      for (const r of all) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.w).toBeGreaterThan(0);
        expect(r.x + r.w).toBeLessThanOrEqual(narrowW);
      }
    }
  });
});
