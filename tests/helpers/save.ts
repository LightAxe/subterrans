// tests/helpers/save.ts — #399: load a world a spec built itself.
//
// A spec that needs the game in a particular state (a trail planted, a Queen
// chamber dug) builds the world here, in Node, from a fresh scenario — with the
// sim's own tick and commands, or by writing the test fixture's stores before the
// game ever sees them — and boots the game from it through the real Continue
// path. The render layer writes nothing: the world arrives as a save.

import { expect, type Page } from '@playwright/test';
import { SAVE_FORMAT_VERSION, SAVE_KEY, serializeWorldState } from '../../src/platform/save.js';
import { pushCommand, type SimCommand } from '../../src/sim/commands.js';
import { tick } from '../../src/sim/tick.js';
import type { WorldState } from '../../src/sim/types.js';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './geometry.js';

/** A save envelope (localStorage value) holding `world`, as buildSaveFile writes
 *  one (savedAtMs 0 reads as "unknown"). Its inputLog is empty, so replaying
 *  (seed, inputLog) does not reproduce the snapshot — fine for loading it, the only
 *  use here; not a replay fixture. */
export function saveOf(world: WorldState, seed: number): string {
  return JSON.stringify({
    version: SAVE_FORMAT_VERSION,
    seed,
    inputLog: [],
    snapshot: serializeWorldState(world),
    savedAtMs: 0,
  });
}

/** Give the player's `commands` to `world` and run the sim until `done(world)`
 *  holds (at most `maxTicks`); returns the tick it held at, or -1. */
export function runUntil(
  world: WorldState,
  commands: readonly SimCommand[],
  done: (w: WorldState) => boolean,
  maxTicks: number,
): number {
  for (const c of commands) pushCommand(world, c, 'player');
  for (let k = 0; k < maxTicks; k++) {
    tick(world, world.commandQueue.splice(0));
    if (done(world)) return world.tick;
  }
  return -1;
}

/** Boot the game from `save` on a fresh profile (no stored settings) via the
 *  Continue / New Game prompt's Continue, and wait until it is Playing. */
export async function bootFromSave(page: Page, save: string): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(
    ({ key, value }) => {
      localStorage.clear();
      localStorage.setItem(key, value);
    },
    { key: SAVE_KEY, value: save },
  );
  await page.reload();
  await waitForUiHook(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui?.bootScreen ??
          '<undefined>',
      ),
    )
    .toBe('save-prompt');
  await clickCanvasRect(page, SAVE_PROMPT_CONTINUE_RECT);
  await settleToPlaying(page);
}
