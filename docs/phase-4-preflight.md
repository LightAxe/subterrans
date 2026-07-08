# Phase 4 pre-flight — single-map / two-colony assumption inventory

Every single-map / two-colony assumption verified against `main` @ `500287f` (the
2026-07-03 architecture review). Guards land in #232; behavioral generalizations ride
the Phase 4 WorldState reshape unless another issue owns them.

> **Line numbers are as-of `500287f`.** Intervening merges (Wave C / C1) have shifted
> some of these files — search by content (the packing expression / handler name), not
> the exact line, when Phase 4 revisits a site. The *assumptions* below remain valid.

| Assumption | file:line | Class | Guard status | Owner |
|---|---|---|---|---|
| tile-key stride 128 + 16-bit mask | `tile-key.ts:24-59` | bit-packing | guard added | #232 |
| occupancy key 7-bit tileX | `ant/ant-movement.ts:1455-1475` | bit-packing | guard added | #232 |
| glow key tx/ty bytes | `render/draw-underground.ts:565-588` | bit-packing (render) | guard added | #232 |
| HUNT_KEY_SHIFT / meander shift | `spider.ts:47-54` | bit-packing | already guarded | — |
| MarkDigTile bounds | `tick.ts:376-377` | constant-bounds | swapped → `underground.width/height` | #232 |
| CancelDigMark bounds | `tick.ts:429-430` | constant-bounds | swapped → `underground.width/height` | #232 |
| PlaceChamber bounds | `tick.ts:516-517` | constant-bounds | swapped → `underground.width/height` | #232 |
| MarkFoodPile bounds | `tick.ts:411-412` | constant-bounds | left on SURFACE_GRID_* (surface is shared) | #232 (documented) |
| MAX_PHEROMONE_GRID_KEYS / MAX_COLONIES_LOAD caps | `save.ts:177-180` | save caps | none | #234 |
| MAX_ENTITIES=8192 cumulative-births cap | `types.ts:1158-1163`, `ant-store.ts:507` | entity cap | none | #233 |
| 4× 2-slot queen-exclusion pre-scans | `spider.ts:100-109,164-172,211-220` | two-colony logic | none | Phase 4 reshape |
| rampage top-2 targeting | `spider.ts:352-359` | two-colony logic | none | Phase 4 reshape |
| combat pairs two lowest colony ids/tile | `combat.ts:283-305` | two-colony logic | none | Phase 4 reshape |
| checkTiebreaks(PLAYER_COLONY_ID) + single-player GameOutcome | `tick.ts:1505-1508`, `game-over.ts:8-14,234-253` | outcome model | none | Phase 4 reshape |
| AI targets PLAYER_COLONY_ID only | `ai-state.ts:150-154,276-280,549`, `ai-controller.ts:780-791,867-878` | two-colony logic | none | Phase 4 reshape |
| Underground input hardcodes PLAYER_COLONY_ID (~10 sites) | `underground-input.ts` (cf. `surface-input.ts:354,449`) | two-colony logic | none | Phase 4 reshape |
| Input world dims branch on constants | `gesture-arbiter.ts:206-210`, `camera-input.ts:194` | constant-bounds (input) | none | Phase 4 reshape |
| SpiderState 28-field singleton mirrored 3× | types iface / `copyWorldState` / `save.ts` | predator model | none | Phase 4 reshape (5b) |

## Guard pattern

Each bit-packing guard copies the `entrance-flow.ts:36` typed-const tripwire:

```ts
const _NAME_IS_128: 128 = SOME_GRID_WIDTH; // fails to compile if the constant drifts
void _NAME_IS_128;
```

A width/height change that would corrupt a packed key now breaks the build at the packing
site instead of silently producing wrong keys at runtime — so the Phase-4 reshape is a
planned single break, not whack-a-mole.
