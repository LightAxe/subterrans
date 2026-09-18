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
