// src/render/boot-overlay-layout.ts
// Phaser-free canvas-local rects for the boot-time overlays (SavePrompt,
// GameOver, DifficultySelect). Extracted from ui-scene.ts (#240) so Playwright
// specs — which run in Node and crash if they import ui-scene.ts (it transitively
// imports Phaser, which touches `window` at module load) — can import these
// coordinates from ONE source of truth instead of hand-duplicating them.
// ui-scene.ts re-exports them to preserve its public surface; values unchanged.

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
