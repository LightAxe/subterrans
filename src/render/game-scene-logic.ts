// game-scene-logic.ts — Pure helpers extracted from GameScene for testability.
//
// These functions have no Phaser dependency and can be unit-tested under Node (Vitest).
// GameScene imports and uses these; Plan 07 covers Phaser-coupled integration via Playwright.

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import type { SimCommand } from '../sim/commands.js';
import type { ToolId, ViewState } from './camera.js';

// ---------------------------------------------------------------------------
// GamePhase state machine (object-const per project convention — not enum)
// ---------------------------------------------------------------------------

export const GamePhase = {
  Playing: 0,
  Paused: 1,
  GameOver: 2,
  SavePrompt: 3,
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

// ---------------------------------------------------------------------------
// canArbiterPan — gesture-arbiter left-drag pan gate (Stage 1 controls rework)
// ---------------------------------------------------------------------------

/**
 * Whether the gesture arbiter's left-drag pan may run.
 *
 * The arbiter's pan is driven by Phaser pointermove handlers that fire
 * INDEPENDENTLY of GameScene.update() (they mutate the camera directly), so an
 * update()-level early-return does NOT stop a pan — the gate must be explicit.
 *
 * Pan is a pure camera move (no world effect), so it stays available exactly
 * when the world is interactive: while Playing, AND during a bare user-pause
 * (Space / the ⏸ button) where tools, taps and pan are all still live. It must
 * be BLOCKED while a modal owns input — the Esc pause menu (pause reason
 * 'menu'), SavePrompt, or GameOver — because closePauseMenu()/reconcilePause()
 * never reset the camera, so a pan behind the menu would persist after Resume.
 *
 * `isModalOpen` already encodes exactly that non-interactive set
 * (GameOver || SavePrompt || pauseReasons.menu) and is false for a bare
 * user-pause, so the gate is simply its negation.
 */
export function canArbiterPan(isModalOpen: boolean): boolean {
  return !isModalOpen;
}

// ---------------------------------------------------------------------------
// Tool cursor resolution + memoization (Stage 1 controls rework)
// ---------------------------------------------------------------------------

/** The cursor key applied to the canvas: a real tool, or the 'default' sentinel. */
export type CursorTool = ToolId | 'default';

/** Inputs to resolveCursorTool — plain flags so it is unit-testable without Phaser. */
export interface CursorToolDeps {
  /** The active tool from ViewState. */
  activeTool: ToolId;
  /** The active view — Chamber is underground-only. */
  activeView: ViewState['activeView'];
  /**
   * True when a modal owns input (GameOver / SavePrompt / Esc 'menu' pause).
   * Deliberately NOT `gamePhase !== Playing`: a bare user-pause keeps tools,
   * taps and the entrance-hover outline LIVE (canEditWorld = !isModalOpen), so
   * the tool cursor must persist then too — otherwise the cursor shows a plain
   * arrow while a click would still queue an edit (a contradictory affordance).
   */
  isModalOpen: boolean;
  /** contextMenuState.visible — the chamber context menu is up. */
  contextMenuVisible: boolean;
  /** antActivityPanelState.visible — the inspector panel is up. */
  antActivityPanelVisible: boolean;
  /** True when the pointer is currently over a HUD zone. */
  overHud: boolean;
}

/**
 * Resolve the effective cursor tool. Returns the 'default' sentinel whenever the
 * cursor must read as the OS arrow — over chrome (HUD / context menu / panel) or
 * while a modal owns input — and otherwise the active tool (Chamber collapses to
 * 'command' outside the underground view). The 'default' sentinel is returned as
 * the literal string (NOT null) so it round-trips through cursorToolChanged.
 */
export function resolveCursorTool(deps: CursorToolDeps): CursorTool {
  const overChrome =
    deps.isModalOpen || deps.contextMenuVisible || deps.antActivityPanelVisible || deps.overHud;
  if (overChrome) return 'default';
  if (deps.activeTool === 'chamber' && deps.activeView !== 'underground') return 'command';
  return deps.activeTool;
}

/**
 * Whether the resolved (tool, view) differs from the last applied pair — i.e.
 * whether a DOM cursor write is actually needed this frame. The previous code
 * stored the 'default' case as `null` while comparing against the 'default'
 * string, so `'default' === null` was always false and setDefaultCursor ran
 * EVERY frame over chrome. Comparing the sentinel consistently (store and
 * compare the literal 'default') restores the intended single-write behaviour.
 */
export function cursorToolChanged(
  effectiveTool: CursorTool,
  view: ViewState['activeView'],
  lastTool: CursorTool | null,
  lastView: ViewState['activeView'] | null,
): boolean {
  return effectiveTool !== lastTool || view !== lastView;
}

// ---------------------------------------------------------------------------
// decideBootMode — pure boot-path decider
// ---------------------------------------------------------------------------

/**
 * Returns 'prompt' if a save exists (user should be asked to Continue or start New Game),
 * or 'fresh' if no save is present.
 */
export function decideBootMode(hasSaveFn: () => boolean): 'prompt' | 'fresh' {
  return hasSaveFn() ? 'prompt' : 'fresh';
}

// ---------------------------------------------------------------------------
// deriveAIColonyIds — discovers non-player colony IDs
// ---------------------------------------------------------------------------

/**
 * Returns all colony IDs from world.colonies except the player colony, in ascending order.
 *
 * ADR-0006: world.colonies is a PLAIN OBJECT — uses Object.keys, never .keys()/.entries()/.get().
 */
export function deriveAIColonyIds(world: WorldState, playerColonyId: ColonyId): ColonyId[] {
  return Object.keys(world.colonies)
    .map((key) => Number(key))
    .filter((cid) => cid !== playerColonyId)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// appendInputLog — SCEN-06 replay truth: never truncates
// ---------------------------------------------------------------------------

/**
 * Appends all commands from cmds into log.
 * SCEN-06: inputLog is AUTHORITATIVE — no truncation, no max size.
 * Plan 04 Task 1's replay equivalence test asserts byte-for-byte parity when
 * replayed against createScenario(seed). Dropping commands silently breaks that contract.
 */
export function appendInputLog(log: SimCommand[], cmds: readonly SimCommand[]): void {
  for (const c of cmds) log.push(c);
}

// ---------------------------------------------------------------------------
// resetInputLog — session ownership: clears the log in-place
// ---------------------------------------------------------------------------

/**
 * Empties the inputLog without reassigning the reference.
 *
 * (seed, inputLog) is the Phase 4 / Phase 9 replay contract and describes the
 * CURRENT session only. bootFresh must start with an empty log; bootFromSave
 * must start empty before appending the persisted log. restartGame reuses the
 * GameScene instance so leaked commands from the previous run would otherwise
 * silently break autosave/replay truth.
 *
 * In-place mutation preserves the object identity that holders (e.g. the
 * autosave closure) have already captured.
 */
export function resetInputLog(log: SimCommand[]): void {
  log.length = 0;
}

// ---------------------------------------------------------------------------
// generateFreshSeed — wall-clock to positive int32
// ---------------------------------------------------------------------------

/**
 * Converts a wall-clock timestamp (Date.now()) to a positive int32 suitable as a sim seed.
 * Date.now() is ~1.7e12 which exceeds int32 max. Bitmask-clamp to positive int32:
 *   (nowMs & 0x7fffffff) | 0
 * Bitwise ops truncate to int32; 0x7fffffff mask ensures the sign bit is clear → always positive.
 * No Math.floor needed — bitwise ops already truncate.
 */
export function generateFreshSeed(nowMs: number): number {
  return (nowMs & 0x7fffffff) | 0;
}
