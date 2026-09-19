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

import { normalizeOrders } from './jev-orders.js';

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
