// opponent-config.ts — which policy drives the enemy Colony this round.
//
// `rules` is the rule-based AI controller (ai-controller.ts, the historical and
// default opponent). `jev` is the Jev opponent (jev-enemy-controller.ts), which
// needs a same-origin proxy endpoint to be configured; when the endpoint is empty
// the game silently plays `rules` instead, so this config is a *preference*, not a
// guarantee.
//
// Lives in render/ because it describes a render-layer policy choice. `save.ts`
// imports the type only (no runtime dependency from platform/ on render/).

import type { WorldState } from '../sim/types.js';
import { DEFAULT_ORDERS_TEXT, normalizeOrders } from './jev-orders.js';

export type OpponentConfig =
  | { readonly kind: 'rules' }
  | {
      /** Standing orders text; `''` means "send no standing_orders field". */
      readonly kind: 'jev';
      readonly orders: string;
    };

/** The opponent a round uses when nothing says otherwise (including old saves). */
export const DEFAULT_OPPONENT: OpponentConfig = { kind: 'rules' };

/** Build a `jev` config with its orders normalized (trimmed / collapsed / capped). */
export function jevOpponent(orders: string): OpponentConfig {
  return { kind: 'jev', orders: normalizeOrders(orders) };
}

/**
 * What the new-game screen pre-selects when the player has not chosen an opponent
 * yet this session (Rob, 2026-10-09): on a build with a Jev endpoint (the beta),
 * Jev with the Balanced preset; on any other build, the Standard AI — such a build
 * never shows Jev at all. A choice made earlier in the session (a restart, a retry,
 * the next New Game) is the caller's to prefer over this.
 */
export function defaultScreenOpponent(jevAvailable: boolean): OpponentConfig {
  return jevAvailable ? jevOpponent(DEFAULT_ORDERS_TEXT) : DEFAULT_OPPONENT;
}

/**
 * The tier a match against `opponent` is played at (Rob, 2026-10-09): a Jev match is
 * always Normal — difficulty barely reached Jev (only the queen's egg interval and the
 * spider's hunger), and the standing-orders presets are its strength setting — so the
 * new-game screen hides the difficulty rows while Jev is selected. The Standard AI
 * plays the tier asked for. `opponent` is the EFFECTIVE one (a Jev request on a build
 * with no endpoint has already become the Standard AI, and keeps its tier).
 */
export function matchDifficulty(
  requested: WorldState['difficulty'],
  opponent: OpponentConfig,
): WorldState['difficulty'] {
  return opponent.kind === 'jev' ? 'Normal' : requested;
}

/**
 * Structural validator for an untrusted value (a save envelope field, a host-page
 * option). Deliberately narrow: only the two shapes `jevOpponent` /
 * `DEFAULT_OPPONENT` can produce are accepted.
 */
export function isOpponentConfig(value: unknown): value is OpponentConfig {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'rules') return true;
  if (kind !== 'jev') return false;
  const orders = (value as { orders?: unknown }).orders;
  return typeof orders === 'string';
}

/**
 * Live opponent state for the HUD label and telemetry, as reported by
 * `GameScene.getOpponentStatus()`. `status` is the *effective* driver of the
 * enemy colony right now, which can differ from `kind`: a round started as `jev`
 * reports `status: 'fallback'` once the controller gave up and the rule-based AI
 * took over mid-round, and a `jev` preference on a build with no endpoint reports
 * `status: 'rules'`.
 */
export interface OpponentStatus {
  readonly kind: OpponentConfig['kind'];
  readonly status: 'rules' | 'jev' | 'fallback';
  /** Completed decision beats across every Jev-driven AI colony this round. */
  readonly beats: number;
  /** Failed beats (timeout / bad response) across the same controllers — a failed readiness probe counts as one. */
  readonly failedBeats: number;
  /** Round-trip of the most recent beat (or successful probe), or null before either lands. */
  readonly lastLatencyMs: number | null;
  /**
   * Readiness-probe state ahead of the first real beat (see
   * JevEnemyController's header comment): null before any controller has sent
   * one, 'pending' while one is in flight, 'ok' once one has succeeded, or
   * 'failed' after an unsuccessful attempt with no success yet. Aggregated
   * across controllers as the most advanced state seen (ok > failed > pending
   * > null).
   */
  readonly probe: 'pending' | 'ok' | 'failed' | null;
}

/**
 * The small monospace HUD label for `status`, or null when there is nothing to
 * say (the rule-based AI is the historical default — it gets no label, so the
 * HUD stays clean for every player who never opts into the beta).
 *
 *   jev       → "Opponent: Jev · beat 12 · 130 ms"  (latency omitted until the
 *                first beat completes)
 *   jev       → "Opponent: Jev · opening · 130 ms"  (before the first beat,
 *                once a readiness probe has confirmed the endpoint is alive)
 *   jev       → "Opponent: Jev · connecting…"        (before the first beat,
 *                while no probe has succeeded yet)
 *   fallback  → "Opponent: Jev → Standard AI (fallback)"
 */
export function formatOpponentStatusLabel(status: OpponentStatus): string | null {
  if (status.status === 'rules') return null;
  if (status.status === 'fallback') return 'Opponent: Jev → Standard AI (fallback)';
  const latency = status.lastLatencyMs === null ? '' : ` · ${Math.round(status.lastLatencyMs)} ms`;
  if (status.beats === 0) {
    if (status.probe === 'ok') return `Opponent: Jev · opening${latency}`;
    if (status.probe === 'pending' || status.probe === null) return 'Opponent: Jev · connecting…';
  }
  return `Opponent: Jev · beat ${status.beats}${latency}`;
}
