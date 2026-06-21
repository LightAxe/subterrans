// input-glyphs.ts — Stage 3b controls rework (issue #18, component #1): a lean,
// static device-glyph resolver. Maps an ActionId to ONE canonical on-screen
// glyph per input device, so the hint strip (#2), first-use hints (#3), and
// tooltips (#5) all render the SAME symbol for a given action from a single
// source of truth.
//
// Scope: render-only. No Phaser, no DOM, no WorldState — pure data + a lookup,
// so it is unit-testable and safe under the sim/render boundary guard.
//
// Why a static table and not a binding registry: the bindings are stable and
// NOT rebindable today (Stage 3a). A full binding-constant registry is over-
// build now (grill + Codex R1#13). Drift is guarded instead by (a) the exact-
// glyph-string unit test in input-glyphs.test.ts and (b) the cross-reference
// comment below — keep this table in lockstep with the keydown-* handlers in
// game-scene.ts. If keys ever become rebindable, replace this with a registry.
//
// ─── KEEP IN SYNC WITH game-scene.ts hotkeys (the keydown-* block) ───────────
//   keydown-ONE   → selectTool('command')   ⇒ TOOL_COMMAND      [1]
//   keydown-TWO   → selectTool('dig')        ⇒ TOOL_DIG          [2]
//   keydown-THREE → selectTool('chamber')    ⇒ TOOL_CHAMBER      [3]
//   keydown-PLUS / NUMPAD_ADD      → stepSpeed(+1) ⇒ SPEED_STEP_UP    [=]
//   keydown-MINUS / NUMPAD_SUBTRACT→ stepSpeed(-1) ⇒ SPEED_STEP_DOWN  [-]
//   keydown-SPACE → toggleUserPause()        ⇒ PAUSE_TOGGLE      [Space]
//   keydown-TAB   → toggleView()             ⇒ VIEW_SWITCH       [Tab]
//   keydown-X     → toggleUndergroundColony()⇒ COLONY_TOGGLE     [X]
//   keydown-P     → toggle pheromone overlay ⇒ PHEROMONE_TOGGLE  [P]
//   speed-widget click (1×/2×/4×)            ⇒ SET_SPEED_1/2/4   1× 2× 4×
//   left-drag (Command/Dig-surface/Chamber)  ⇒ PAN               Drag
//   mouse wheel                              ⇒ ZOOM              Scroll
//   underground Dig tap / drag               ⇒ DIG_MARK / DIG_PAINT  Click / Drag
//   Chamber-tool tap                         ⇒ CHAMBER_PLACE     Click
//   right-click (any tool, underground)      ⇒ CHAMBER_MENU      RMB
//   Command tap (food / ground / spider)     ⇒ ORDER_FOOD/RALLY/SPIDER  Click
//   Dig tap on the surface                   ⇒ ENTRANCE_DESIGNATE Click
// ─────────────────────────────────────────────────────────────────────────────

/** The two input devices a glyph can describe. Desktop-only in Stage 3b;
 *  Phase-6 touch will add a third device with its own glyph column. */
export type Device = 'keyboard' | 'mouse';

/**
 * Every player action the teaching surfaces can reference. Models the REAL
 * Stage-3a bindings (Codex R1#12); names group by widget/gesture, not by key.
 */
export type ActionId =
  // Tool selection (number-row hotkeys / palette buttons)
  | 'TOOL_COMMAND'
  | 'TOOL_DIG'
  | 'TOOL_CHAMBER'
  // Speed — step keys vs widget presets
  | 'SPEED_STEP_UP'
  | 'SPEED_STEP_DOWN'
  | 'SET_SPEED_1'
  | 'SET_SPEED_2'
  | 'SET_SPEED_4'
  // Global toggles
  | 'PAUSE_TOGGLE'
  | 'VIEW_SWITCH'
  | 'COLONY_TOGGLE'
  | 'PHEROMONE_TOGGLE'
  // Camera (affordance-less gestures — the #3 first-use hints)
  | 'PAN'
  | 'ZOOM'
  // Tool primary actions
  | 'DIG_MARK'
  | 'DIG_PAINT'
  | 'CHAMBER_PLACE'
  | 'CHAMBER_MENU'
  | 'ORDER_RALLY'
  | 'ORDER_FOOD'
  | 'ORDER_SPIDER'
  | 'ENTRANCE_DESIGNATE';

/**
 * One canonical glyph per (action, device). Keys are bracketed ([1], [Tab]);
 * mouse gestures are words (Drag, Scroll, Click, RMB); speed presets are their
 * widget labels (1×). `Partial` because not every action has both devices —
 * e.g. PAN/ZOOM are mouse-only, VIEW_SWITCH is keyboard-only.
 *
 * EXACT strings are asserted in input-glyphs.test.ts; do not edit one without
 * updating that test (that is the anti-drift guard).
 */
export const GLYPHS: Readonly<Record<ActionId, Partial<Record<Device, string>>>> = {
  TOOL_COMMAND: { keyboard: '[1]' },
  TOOL_DIG: { keyboard: '[2]' },
  TOOL_CHAMBER: { keyboard: '[3]' },
  SPEED_STEP_UP: { keyboard: '[=]' },
  SPEED_STEP_DOWN: { keyboard: '[-]' },
  SET_SPEED_1: { mouse: '1×' },
  SET_SPEED_2: { mouse: '2×' },
  SET_SPEED_4: { mouse: '4×' },
  PAUSE_TOGGLE: { keyboard: '[Space]' },
  VIEW_SWITCH: { keyboard: '[Tab]' },
  COLONY_TOGGLE: { keyboard: '[X]' },
  PHEROMONE_TOGGLE: { keyboard: '[P]' },
  PAN: { mouse: 'Drag' },
  ZOOM: { mouse: 'Scroll' },
  DIG_MARK: { mouse: 'Click' },
  DIG_PAINT: { mouse: 'Drag' },
  CHAMBER_PLACE: { mouse: 'Click' },
  CHAMBER_MENU: { mouse: 'RMB' },
  ORDER_RALLY: { mouse: 'Click' },
  ORDER_FOOD: { mouse: 'Click' },
  ORDER_SPIDER: { mouse: 'Click' },
  ENTRANCE_DESIGNATE: { mouse: 'Click' },
};

/**
 * The canonical glyph for an action on a device, or `null` if that action has
 * no glyph on that device (e.g. glyphFor('PAN','keyboard') → null). Callers
 * compose UI copy from the returned token so the symbol lives in exactly one
 * place.
 */
export function glyphFor(action: ActionId, device: Device): string | null {
  return GLYPHS[action][device] ?? null;
}
