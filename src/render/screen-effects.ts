// screen-effects.ts — S6: full-screen and screen-edge visual cues.
//
// Render-side only. All effects use Phaser camera/scene APIs.
// No sim state is read or mutated here.

/** Duration (ms) for the screen-edge invasion flash before it fully fades. */
export const SCREEN_EDGE_FLASH_DURATION_MS = 2000;

/** Duration (ms) for the full-screen queen damage pulse (camera.flash). */
export const QUEEN_DAMAGE_PULSE_DURATION_MS = 200;

/** Ticks to suppress queen damage pulse at round start (2 sim-seconds at 20 Hz). */
export const QUEEN_DAMAGE_SUPPRESS_TICKS = 40;

export type FlashDirection = 'top' | 'bottom' | 'left' | 'right';

/**
 * Trigger a faint red rectangle flash on the screen edge corresponding to
 * the direction of an incoming invasion. Fades out over SCREEN_EDGE_FLASH_DURATION_MS.
 *
 * @param scene     Phaser Scene (for add.graphics + tweens).
 * @param direction Which screen edge to flash.
 * @param canvasW   Canvas width in pixels.
 * @param canvasH   Canvas height in pixels.
 */
export function triggerScreenEdgeFlash(
  scene: Phaser.Scene,
  direction: FlashDirection,
  canvasW: number,
  canvasH: number,
): void {
  const THICKNESS = 20;
  const gfx = scene.add.graphics();
  gfx.setScrollFactor(0); // pin to viewport — graphics default to world coords
  gfx.setDepth(50);
  gfx.fillStyle(0xff0000, 0.25);

  if (direction === 'top') {
    gfx.fillRect(0, 0, canvasW, THICKNESS);
  } else if (direction === 'bottom') {
    gfx.fillRect(0, canvasH - THICKNESS, canvasW, THICKNESS);
  } else if (direction === 'left') {
    gfx.fillRect(0, 0, THICKNESS, canvasH);
  } else {
    gfx.fillRect(canvasW - THICKNESS, 0, THICKNESS, canvasH);
  }

  scene.tweens.add({
    targets: gfx,
    alpha: 0,
    duration: SCREEN_EDGE_FLASH_DURATION_MS,
    ease: 'Linear',
    onComplete: () => {
      gfx.destroy();
    },
  });
}

/**
 * Trigger a brief full-screen red flash using Phaser's built-in camera.flash().
 * Idempotent: Phaser ignores overlapping flash calls.
 *
 * @param camera Phaser main camera.
 */
export function triggerQueenDamagePulse(camera: Phaser.Cameras.Scene2D.Camera): void {
  camera.flash(QUEEN_DAMAGE_PULSE_DURATION_MS, 255, 0, 0, true);
}

/**
 * Determine which screen edge corresponds to the direction from the queen
 * chamber toward the threatened entrance.
 *
 * @param queenTileX Queen chamber center tile X.
 * @param queenTileY Queen chamber center tile Y.
 * @param entranceTileX Invasion entrance tile X.
 * @param entranceTileY Invasion entrance tile Y.
 */
export function inferFlashDirection(
  queenTileX: number,
  queenTileY: number,
  entranceTileX: number,
  entranceTileY: number,
): FlashDirection {
  const dx = entranceTileX - queenTileX;
  const dy = entranceTileY - queenTileY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'bottom' : 'top';
}
