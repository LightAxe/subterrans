// src/render/boot-overlay-layout.ts
// Phaser-free canvas-local geometry for the boot-time overlays (SavePrompt,
// GameOver, and the new-game screen). Extracted from ui-scene.ts (#240) so
// Playwright specs — which run in Node and crash if they import ui-scene.ts (it
// transitively imports Phaser, which touches `window` at module load) — can import
// these coordinates from ONE source of truth instead of hand-duplicating them.
//
// LAYOUT DISCIPLINE NOTE (#213 / #238): the SavePrompt / GameOver rects below are
// canvas-tied absolute rects relocated VERBATIM from ui-scene.ts (they were
// already module-scope constants there on main). #240 was a pure decoupling
// refactor with a zero-coordinate-change invariant, so it did not convert them.
// Making them pure functions of `LayoutContext` (like pause-menu-layout.ts) is
// #238's tracked scope ("residual fixed-canvas geometry") — the save-prompt rects
// in particular are NOT cleanly centered (x=300 → button-center 360, not
// canvas-center 400), so their reflow anchors are a deliberate #238 design
// decision, not a mechanical rewrite. Do not add NEW canvas-tied constants here.
//
// The new-game screen (#304) below follows the current discipline instead: every
// canvas-RELATIVE value (the column's horizontal centering, the stack's vertical
// centering) derives from `layout.w` / `layout.h`; canvas-INDEPENDENT sizes (row
// heights, gaps, the button size) stay plain constants. The opponent section at
// the bottom of this file (Jev opponent beta, #304 items 3–4) is laid out INSIDE
// the slot the stack hands back, so it inherits that discipline for free.

import type { LayoutContext } from './layout.js';
import type { WorldState } from '../sim/types.js';

/** Canvas-local rect for the SavePrompt "Continue" button. */
export const SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 } as const;
/** Canvas-local rect for the SavePrompt "New Game" button. */
export const SAVE_PROMPT_NEW_GAME_RECT = { x: 300, y: 320, w: 120, h: 32 } as const;
/** Canvas-local rect for the GameOver "Restart" button. */
export const GAME_OVER_RESTART_RECT = { x: 300, y: 345, w: 120, h: 32 } as const;

// ---------------------------------------------------------------------------
// #304 — new-game screen
//
// Options first, one Start button last. The screen is a vertical STACK of
// sections, centered as a group on the canvas (the pause menu's arrangement):
//
//   title      "New Game" + a one-line subtitle
//   difficulty a "Difficulty" caption + three radio-style rows (Easy / Normal /
//              Hard), each carrying a plain-language line about what it changes
//   opponent   a SLOT this build leaves empty (height 0 → omitted from the stack).
//              The Jev opponent picker (PR #298) inserts its section here by
//              passing the height it needs; nothing else about the stack moves.
//   start      the single "Start game" button + the "Enter also starts" hint
//
// Only Start (or Enter) begins a round — clicking a difficulty row just moves
// the selection. Rects are exported through tests/helpers/geometry.ts so the
// Playwright specs click the real buttons without inlining a pixel.
// ---------------------------------------------------------------------------

/** The difficulty tier vocabulary (CONTEXT.md → "Difficulty"). Same literal
 *  union the sim stores on WorldState; re-exported here so the Phaser-free
 *  consumers (tests/helpers/geometry.ts, the specs) don't reach into sim/. */
export type Difficulty = WorldState['difficulty'];

/** Row order on the screen, top to bottom. Matches the sim's [Easy, Normal,
 *  Hard] triplet indexing so `DIFFICULTY_TIERS.indexOf(d)` is the tier index. */
export const DIFFICULTY_TIERS: readonly Difficulty[] = ['Easy', 'Normal', 'Hard'] as const;

/** Rect shape shared by the overlay geometry helpers. */
export interface BootOverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A text anchor (the Phaser Text origin is documented per field below). */
export interface BootOverlayPoint {
  x: number;
  y: number;
}

/** Design width of the content column, centered on the canvas. A layout
 *  narrower than this (plus the side gutters) shrinks the column instead of
 *  overflowing — see {@link newGameColumnW}. */
export const NEW_GAME_COLUMN_MAX_W = 620;
/** Minimum gutter between the column and the canvas edge on a narrow layout. */
export const NEW_GAME_COLUMN_MIN_INSET = 16;
/** Minimum inset from the canvas top when the stack is taller than the canvas
 *  (a stack that no longer centers is clamped here rather than pushed off-top). */
export const NEW_GAME_STACK_MIN_TOP = 8;

/** Title section: the title line, then the subtitle line beneath it. */
export const NEW_GAME_TITLE_H = 44;
export const NEW_GAME_SUBTITLE_H = 22;
/** Vertical gap between adjacent sections of the stack. */
export const NEW_GAME_SECTION_GAP = 20;

/** Difficulty section: a caption row ("Difficulty"), then the three tier rows. */
export const NEW_GAME_CAPTION_H = 22;
export const DIFFICULTY_ROW_H = 52;
export const DIFFICULTY_ROW_GAP = 8;

/** Inner geometry of one difficulty row, measured from the row's left edge:
 *  the radio glyph's center, the tier name, and the description column. */
export const DIFFICULTY_ROW_RADIO_X = 22;
export const DIFFICULTY_ROW_RADIO_R = 7;
export const DIFFICULTY_ROW_NAME_X = 40;
export const DIFFICULTY_ROW_DESC_X = 116;
export const DIFFICULTY_ROW_PAD_RIGHT = 14;

/** Start section: the button, then the keyboard hint beneath it. */
export const NEW_GAME_START_W = 220;
export const NEW_GAME_START_H = 44;
export const NEW_GAME_START_HINT_H = 22;

/** Sections of the stack, in render order. `opponent` is the slot the Jev
 *  branch fills; on main it has no height and is omitted from the stack. */
export type NewGameSectionId = 'title' | 'difficulty' | 'opponent' | 'start';

export interface NewGameScreenOptions {
  /** Height the opponent section needs, in canvas pixels. 0 / omitted (this
   *  build) leaves the slot out of the stack entirely — no phantom gap. */
  opponentSectionH?: number;
}

/** Every rect / anchor the new-game screen draws. */
export interface NewGameScreenLayout {
  /** The whole centered stack (all sections + gaps). */
  stack: BootOverlayRect;
  /** "New Game". Text origin (0.5, 0.5). */
  title: BootOverlayPoint;
  /** One-line framing under the title. Origin (0.5, 0.5). */
  subtitle: BootOverlayPoint;
  /** "Difficulty" caption. Origin (0, 0), at the column's left edge. */
  difficultyCaption: BootOverlayPoint;
  /** The three radio-style tier rows, keyed by tier. Each spans the column. */
  difficultyRows: Record<Difficulty, BootOverlayRect>;
  /** The opponent slot. `h` is exactly `opponentSectionH` (0 on this build);
   *  x/w span the column, y is where the section's content starts — which, for
   *  an empty slot, is where the Start section starts instead. */
  opponentSlot: BootOverlayRect;
  /** "Start game" button, centered in the column. */
  startButton: BootOverlayRect;
  /** "Enter also starts" hint. Origin (0.5, 0.5). */
  startHint: BootOverlayPoint;
}

/** Inner anchors of one difficulty row (see the DIFFICULTY_ROW_* constants). */
export interface DifficultyRowInner {
  /** Radio glyph center. */
  radio: BootOverlayPoint;
  /** Tier name. Text origin (0, 0.5). */
  name: BootOverlayPoint;
  /** Description column: text origin (0, 0.5), word-wrapped to `w`. */
  desc: BootOverlayPoint & { w: number };
}

/** Width of the content column for this layout — the design width, or the
 *  canvas minus the gutters when that is narrower. */
export function newGameColumnW(layout: LayoutContext): number {
  return Math.max(0, Math.min(NEW_GAME_COLUMN_MAX_W, layout.w - 2 * NEW_GAME_COLUMN_MIN_INSET));
}

/** Inner anchors of a radio-style row (radio glyph, name, description column),
 *  derived purely from its rect; `descX` is where the description column starts,
 *  measured from the row's left edge. Shared by the difficulty rows and the
 *  opponent rows, which differ only in that offset and in their height. */
function radioRowInner(row: BootOverlayRect, descX: number): DifficultyRowInner {
  const midY = row.y + row.h / 2;
  return {
    radio: { x: row.x + DIFFICULTY_ROW_RADIO_X, y: midY },
    name: { x: row.x + DIFFICULTY_ROW_NAME_X, y: midY },
    desc: {
      x: row.x + descX,
      y: midY,
      w: Math.max(0, row.w - descX - DIFFICULTY_ROW_PAD_RIGHT),
    },
  };
}

/** Inner anchors of a difficulty row, derived purely from its rect. */
export function difficultyRowInner(row: BootOverlayRect): DifficultyRowInner {
  return radioRowInner(row, DIFFICULTY_ROW_DESC_X);
}

/** Height of the difficulty section (caption + rows). */
function difficultySectionH(): number {
  const n = DIFFICULTY_TIERS.length;
  return NEW_GAME_CAPTION_H + n * DIFFICULTY_ROW_H + (n - 1) * DIFFICULTY_ROW_GAP;
}

/** Lay the sections out as a vertical stack, top to bottom, centered on the
 *  canvas as a group. Returns each section's top Y plus the stack's total
 *  height. A section with zero height is left out — no gap is spent on it, and
 *  its y is simply where the next present section starts (i.e. where it WOULD
 *  have started), so a consumer that reads it anyway gets a sane anchor. */
function stackSections(
  sections: ReadonlyArray<{ id: NewGameSectionId; h: number }>,
  layout: LayoutContext,
): { top: number; totalH: number; y: Record<NewGameSectionId, number> } {
  const present = sections.filter((s) => s.h > 0);
  const totalH =
    present.reduce((sum, s) => sum + s.h, 0) +
    Math.max(0, present.length - 1) * NEW_GAME_SECTION_GAP;
  const top = Math.max(NEW_GAME_STACK_MIN_TOP, (layout.h - totalH) / 2);
  const y: Record<NewGameSectionId, number> = {
    title: top,
    difficulty: top,
    opponent: top,
    start: top,
  };
  let cursor = top;
  for (const s of sections) {
    y[s.id] = cursor;
    if (s.h > 0) cursor += s.h + NEW_GAME_SECTION_GAP;
  }
  return { top, totalH, y };
}

/** Compute every rect / anchor of the new-game screen for this layout. */
export function newGameScreenLayout(
  layout: LayoutContext,
  opts: NewGameScreenOptions = {},
): NewGameScreenLayout {
  const columnW = newGameColumnW(layout);
  const columnX = (layout.w - columnW) / 2;
  const centerX = layout.w / 2;
  const opponentH = Math.max(0, opts.opponentSectionH ?? 0);

  const sections: ReadonlyArray<{ id: NewGameSectionId; h: number }> = [
    { id: 'title', h: NEW_GAME_TITLE_H + NEW_GAME_SUBTITLE_H },
    { id: 'difficulty', h: difficultySectionH() },
    { id: 'opponent', h: opponentH },
    { id: 'start', h: NEW_GAME_START_H + NEW_GAME_START_HINT_H },
  ];
  const { top, totalH, y } = stackSections(sections, layout);

  const rowsTop = y.difficulty + NEW_GAME_CAPTION_H;
  const difficultyRows = {} as Record<Difficulty, BootOverlayRect>;
  DIFFICULTY_TIERS.forEach((tier, i) => {
    difficultyRows[tier] = {
      x: columnX,
      y: rowsTop + i * (DIFFICULTY_ROW_H + DIFFICULTY_ROW_GAP),
      w: columnW,
      h: DIFFICULTY_ROW_H,
    };
  });

  const startW = Math.min(NEW_GAME_START_W, columnW);
  return {
    stack: { x: columnX, y: top, w: columnW, h: totalH },
    title: { x: centerX, y: y.title + NEW_GAME_TITLE_H / 2 },
    subtitle: { x: centerX, y: y.title + NEW_GAME_TITLE_H + NEW_GAME_SUBTITLE_H / 2 },
    difficultyCaption: { x: columnX, y: y.difficulty },
    difficultyRows,
    opponentSlot: { x: columnX, y: y.opponent, w: columnW, h: opponentH },
    startButton: { x: centerX - startW / 2, y: y.start, w: startW, h: NEW_GAME_START_H },
    startHint: { x: centerX, y: y.start + NEW_GAME_START_H + NEW_GAME_START_HINT_H / 2 },
  };
}

// ---------------------------------------------------------------------------
// #304 items 3–4 (Jev opponent beta) — the opponent section
//
// Fills the `opponent` slot of the stack above on a build whose Jev proxy
// endpoint is configured. Top to bottom:
//
//   caption   "Opponent" (the Difficulty caption's twin)
//   rows      two radio-style rows — "Standard AI" / "Jev (beta)" — each with a
//             ONE-line description (single line by design; the rows are shorter
//             than the two-line difficulty rows)
//   jev       ONLY while the Jev row is selected: a caption line ("Custom
//             instructions for Jev, your opponent", with the n/300 counter
//             right after it), the standing-orders preset buttons spanning the
//             column, and the free-text rect a DOM <textarea> is positioned over.
//
// The section's height therefore depends on the picker's state. A caller asks
// `opponentSectionH` for it, passes that as `opponentSectionH` to
// newGameScreenLayout (the stack re-centres around the taller section), and
// then lays the section out inside the `opponentSlot` that comes back with
// `opponentSectionLayout` — or uses `newGameScreenWithOpponent`, which does
// both. A build with NO endpoint has no section at all (height 0, layout
// null): the screen is then exactly main's, pixel for pixel.
//
// Height budget: main's stack is 366 px tall. Keeping NEW_GAME_STACK_MIN_TOP
// clear at BOTH ends of the shipping 592 px canvas leaves
// 592 − 2·8 − 366 − NEW_GAME_SECTION_GAP = 190 px for the fully expanded
// section, and the constants below sum to exactly that (a test pins it). The
// textarea is the compromise: 46 px shows two lines of a preset's three, and
// the box scrolls — a taller box would push the stack off the canvas.
// ---------------------------------------------------------------------------

/** The opponent vocabulary as the screen offers it (OpponentConfig['kind']
 *  in render/opponent-config.ts; re-declared here so this module stays free of
 *  the orders/config imports and Phaser-free consumers need only this file). */
export type OpponentKind = 'rules' | 'jev';

/** Row order on the screen, top to bottom. */
export const OPPONENT_KINDS: readonly OpponentKind[] = ['rules', 'jev'] as const;

/** Opponent rows: one line of 14 px name + 12 px description, so shorter than
 *  the two-line difficulty rows. The radio glyph and the name share the
 *  difficulty rows' offsets; the description column starts further right
 *  because "Standard AI" is wider than any tier name. */
export const OPPONENT_ROW_H = 30;
export const OPPONENT_ROW_GAP = 6;
export const OPPONENT_ROW_DESC_X = 146;

/** Jev options (drawn only while the Jev row is selected), measured down from
 *  the last opponent row: a gap, the caption line, the preset row, a gap, the
 *  free-text rect. Presets divide the column evenly with JEV_PRESET_GAP between
 *  them, so adding a preset re-divides the same span instead of overflowing. */
export const JEV_OPTIONS_GAP = 8;
export const JEV_OPTIONS_CAPTION_H = 18;
/** Gap between the caption's rendered text and the n/300 counter on the same
 *  line. The counter follows the caption (a render-time measure of the drawn
 *  text) rather than sitting at the column's right edge, where it would land
 *  on the HUD's view-toggle button showing through the translucent scrim. */
export const JEV_COUNTER_GAP = 12;
export const JEV_PRESET_H = 24;
export const JEV_PRESET_GAP = 8;
export const JEV_PRESET_ROW_GAP = 6;
export const JEV_TEXTAREA_H = 46;

/** What decides the section's shape. */
export interface OpponentSectionOptions {
  /** False on a build with no Jev proxy endpoint: no section at all. */
  jevAvailable: boolean;
  /** True while the Jev row is selected: the Jev options are laid out too. */
  jevSelected: boolean;
  /** `JEV_ORDERS_PRESETS.length`, passed in so this module stays free of the
   *  orders vocabulary (and so the row re-divides if a preset is ever added). */
  presetCount: number;
}

/** The Jev options block (present only while the Jev row is selected). */
export interface JevOptionsLayout {
  /** "Custom instructions for Jev, your opponent". Text origin (0, 0). The
   *  n/300 counter follows it on the same line, JEV_COUNTER_GAP after the
   *  drawn caption's width (measured at render time). */
  caption: BootOverlayPoint;
  /** Preset buttons, index-aligned with JEV_ORDERS_PRESETS, spanning the column. */
  presetButtons: BootOverlayRect[];
  /** Free-text rect. A DOM <textarea> is positioned over it at runtime. */
  textarea: BootOverlayRect;
}

/** Every rect / anchor the opponent section draws, inside its slot. */
export interface OpponentSectionLayout {
  /** "Opponent" caption. Origin (0, 0), at the column's left edge. */
  caption: BootOverlayPoint;
  /** The two radio-style rows, keyed by kind. Each spans the column. */
  rows: Record<OpponentKind, BootOverlayRect>;
  /** The Jev options, or null while the Standard AI row is selected. */
  jev: JevOptionsLayout | null;
}

function opponentRowsH(): number {
  const n = OPPONENT_KINDS.length;
  return n * OPPONENT_ROW_H + (n - 1) * OPPONENT_ROW_GAP;
}

function jevOptionsH(): number {
  return (
    JEV_OPTIONS_GAP + JEV_OPTIONS_CAPTION_H + JEV_PRESET_H + JEV_PRESET_ROW_GAP + JEV_TEXTAREA_H
  );
}

/** Height the opponent section needs for `opts` — what to pass as
 *  `opponentSectionH` to newGameScreenLayout. 0 when Jev is unavailable, so the
 *  stack omits the slot entirely (no phantom gap). */
export function opponentSectionH(opts: OpponentSectionOptions): number {
  if (!opts.jevAvailable) return 0;
  return NEW_GAME_CAPTION_H + opponentRowsH() + (opts.jevSelected ? jevOptionsH() : 0);
}

/** Inner anchors of an opponent row, derived purely from its rect. */
export function opponentRowInner(row: BootOverlayRect): DifficultyRowInner {
  return radioRowInner(row, OPPONENT_ROW_DESC_X);
}

/** Lay the opponent section out inside `slot` (the `opponentSlot` of a
 *  newGameScreenLayout computed with `opponentSectionH(opts)`). Null when Jev
 *  is unavailable — there is no section to draw. Every value is relative to the
 *  slot, so the section moves with the stack and never learns the canvas size. */
export function opponentSectionLayout(
  slot: BootOverlayRect,
  opts: OpponentSectionOptions,
): OpponentSectionLayout | null {
  if (!opts.jevAvailable) return null;
  const rowsTop = slot.y + NEW_GAME_CAPTION_H;
  const rows = {} as Record<OpponentKind, BootOverlayRect>;
  OPPONENT_KINDS.forEach((kind, i) => {
    rows[kind] = {
      x: slot.x,
      y: rowsTop + i * (OPPONENT_ROW_H + OPPONENT_ROW_GAP),
      w: slot.w,
      h: OPPONENT_ROW_H,
    };
  });

  let jev: JevOptionsLayout | null = null;
  if (opts.jevSelected) {
    const captionY = rowsTop + opponentRowsH() + JEV_OPTIONS_GAP;
    const presetsY = captionY + JEV_OPTIONS_CAPTION_H;
    const n = Math.max(0, opts.presetCount);
    const presetW = n > 0 ? Math.max(0, (slot.w - (n - 1) * JEV_PRESET_GAP) / n) : 0;
    const presetButtons: BootOverlayRect[] = [];
    for (let i = 0; i < n; i++) {
      presetButtons.push({
        x: slot.x + i * (presetW + JEV_PRESET_GAP),
        y: presetsY,
        w: presetW,
        h: JEV_PRESET_H,
      });
    }
    jev = {
      caption: { x: slot.x, y: captionY },
      presetButtons,
      textarea: {
        x: slot.x,
        y: presetsY + JEV_PRESET_H + JEV_PRESET_ROW_GAP,
        w: slot.w,
        h: JEV_TEXTAREA_H,
      },
    };
  }

  return { caption: { x: slot.x, y: slot.y }, rows, jev };
}

/** The whole screen for a Jev-capable build in one call: the stack sized for
 *  the section `opts` describes, plus the section laid out in its slot (null
 *  when Jev is unavailable — the stack is then main's, unchanged). The single
 *  entry point ui-scene.ts draws from and tests/helpers/geometry.ts clicks by. */
export function newGameScreenWithOpponent(
  layout: LayoutContext,
  opts: OpponentSectionOptions,
): { screen: NewGameScreenLayout; opponent: OpponentSectionLayout | null } {
  const screen = newGameScreenLayout(layout, { opponentSectionH: opponentSectionH(opts) });
  return { screen, opponent: opponentSectionLayout(screen.opponentSlot, opts) };
}
