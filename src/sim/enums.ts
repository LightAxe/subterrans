// enums.ts — PRD §1 §2 §5a discriminated enum types for src/sim/
//
// Pattern: object-const + type alias (established in game-over.ts, Phase 5).
// This pattern is PRD-normative per Errata E-02 and is compatible with:
//   - Vite/esbuild bundling (same tree-shaking as const enum)
//   - Node --experimental-strip-types headless tests (no TypeScript transform needed)
//   - isolatedModules: true (no const enum cross-file inlining)
//
// DO NOT use `const enum` or ordinary `enum` declarations.
// All values are non-negative integer literals in documented order.
// Member names are PRD §1 §2 §5a verbatim — do not rename or add aliases.

// ---------------------------------------------------------------------------
// AntTask — primary task assigned to each ant (PRD §1 lines 51-56)
// ---------------------------------------------------------------------------

export const AntTask = {
  Idle:     0,
  Foraging: 1,
  Digging:  2,
  Fighting: 3,
  Nursing:  4,
} as const;
export type AntTask = typeof AntTask[keyof typeof AntTask];

// ---------------------------------------------------------------------------
// ForagingSubState — sub-state for ants with AntTask.Foraging (PRD §1 lines 62-66)
// 3 members including ReturningToNest — do NOT reduce to 2
// ---------------------------------------------------------------------------

export const ForagingSubState = {
  SearchingFood:   0,
  CarryingFood:    1,
  ReturningToNest: 2, // PRD §1 line 66 — required; downstream plans reference this member
} as const;
export type ForagingSubState = typeof ForagingSubState[keyof typeof ForagingSubState];

// ---------------------------------------------------------------------------
// DiggingSubState — sub-state for ants with AntTask.Digging (PRD §1 lines 72-74)
// ---------------------------------------------------------------------------

export const DiggingSubState = {
  MovingToTile: 0,
  Excavating:   1,
} as const;
export type DiggingSubState = typeof DiggingSubState[keyof typeof DiggingSubState];

// ---------------------------------------------------------------------------
// NursingSubState — sub-state for ants with AntTask.Nursing (PRD §1 lines 82-84)
// Member 1 is `Feeding` — NOT `FeedingBrood`
// ---------------------------------------------------------------------------

export const NursingSubState = {
  MovingToBrood: 0,
  Feeding:       1, // PRD §1 line 84 — member is `Feeding`, NOT `FeedingBrood`
  Attending:     2, // S4 V21+ — nurse dwells at Nursery after deposit; accelerates adjacent larvae
} as const;
export type NursingSubState = typeof NursingSubState[keyof typeof NursingSubState];

// ---------------------------------------------------------------------------
// FightingSubState — sub-state for ants with AntTask.Fighting (PRD §1 lines 91-93)
// 2 members — both fully defined at Phase 2 scope; do NOT reduce to a singleton
// ---------------------------------------------------------------------------

export const FightingSubState = {
  MovingToRally: 0, // PRD §1 line 92
  Engaging:      1, // PRD §1 line 93 — both members canonical at Phase 2 scope
} as const;
export type FightingSubState = typeof FightingSubState[keyof typeof FightingSubState];

// ---------------------------------------------------------------------------
// ChamberType — underground chamber classification (PRD §2)
// ---------------------------------------------------------------------------

export const ChamberType = {
  Queen:       0,
  Nursery:     1,
  FoodStorage: 2,
} as const;
export type ChamberType = typeof ChamberType[keyof typeof ChamberType];

// ---------------------------------------------------------------------------
// PheromoneType — pheromone trail classification (PRD §5a)
// ---------------------------------------------------------------------------

export const PheromoneType = {
  FoodTrail:   0,
  DangerTrail: 1,
} as const;
export type PheromoneType = typeof PheromoneType[keyof typeof PheromoneType];
