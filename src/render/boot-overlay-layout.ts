// src/render/boot-overlay-layout.ts
// Phaser-free canvas-local rects for the boot-time overlays (SavePrompt,
// GameOver, DifficultySelect). Extracted from ui-scene.ts (#240) so Playwright
// specs — which run in Node and crash if they import ui-scene.ts (it transitively
// imports Phaser, which touches `window` at module load) — can import these
// coordinates from ONE source of truth instead of hand-duplicating them.
// ui-scene.ts re-exports them to preserve its public surface; values unchanged.
//
// LAYOUT DISCIPLINE NOTE (#213 / #238): these are canvas-tied absolute rects
// relocated VERBATIM from ui-scene.ts (they were already module-scope constants
// there on main). #240 is a pure decoupling refactor with a zero-coordinate-change
// invariant, so it does not convert them. Making them pure functions of
// `LayoutContext` (like pause-menu-layout.ts) is #238's tracked scope ("residual
// fixed-canvas geometry") — the save-prompt rects in particular are NOT cleanly
// centered (x=300 → button-center 360, not canvas-center 400), so their reflow
// anchors are a deliberate #238 design decision, not a mechanical rewrite. Do not
// add NEW canvas-tied constants here; the conversion happens in #238.

/** Canvas-local rect for the SavePrompt "Continue" button. */
export const SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 } as const;
/** Canvas-local rect for the SavePrompt "New Game" button. */
export const SAVE_PROMPT_NEW_GAME_RECT = { x: 300, y: 320, w: 120, h: 32 } as const;
/** Canvas-local rect for the GameOver "Restart" button. */
export const GAME_OVER_RESTART_RECT = { x: 300, y: 345, w: 120, h: 32 } as const;
/** Canvas-local rects for the DifficultySelect buttons (Easy / Normal / Hard). */
export const DIFFICULTY_EASY_RECT = { x: 180, y: 260, w: 140, h: 40 } as const;
export const DIFFICULTY_NORMAL_RECT = { x: 330, y: 260, w: 140, h: 40 } as const;
export const DIFFICULTY_HARD_RECT = { x: 480, y: 260, w: 140, h: 40 } as const;
