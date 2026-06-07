# INVESTIGATION.md — forager mis-movement & static-terrain (#127 / #128)

**Phase 0 deliverable** of `plan/flurry/PR2-REPLAN.md` (the outer planning repo).
This document + the committed harness under `src/platform/investigation/` are the
**diagnosis**. It ships **no fix** — the precise fix specs are written at the
post-investigation checkpoint, pinned to the measured data below. Two prior
diagnoses were wrong (original PR 2; re-plan v1); the point of this pass is to
**not pre-commit a fix to an unproven mechanism**.

- **simVersion:** unchanged. `main` is at **V27**; this PR is diagnostic
  (harness + docs only, no sim-behaviour change), so no bump. Fixes (V28+) come
  later.
- **How to run:** `npx vitest run src/platform/investigation/harness.test.ts`
  (bounded regression guards). The full sweep used for the numbers below is
  reproducible by calling `runTracedScenario` over all seed sets × 3 difficulties
  × 3000 ticks (see "Reproducing the full sweep" at the end).

---

## 1. Harness architecture

Committed under `src/platform/investigation/`:

| File              | Role                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `seeds.ts`        | Three **disjoint** seed sets: discovery / calibration / acceptance.                                               |
| `input-logs.ts`   | Fixed `SimCommand[][]` schedules — chamber excavation, dig cancellation, entrance designation, descent.           |
| `harness.ts`      | Traced run, episode detection (#127 + #128), static-terrain oracle, perf/save-size measurement, neutrality check. |
| `harness.test.ts` | Regression guards (disjoint seeds, neutrality, determinism, #127 + #128 repro, oracle).                           |

**Why `src/platform/` (not `src/sim/`):** the harness imports the
render/platform-only movement-source inferencer (`debug-snapshot.ts`), so it
cannot live inside the sacred `src/sim` boundary. It only **reads** `WorldState`
and calls `tick()`; it never writes a `world.*` field (FNDN-07 clean). Synthetic
world construction (for structural #128 cases) lives in the `*.test.ts` file,
which the sim-boundary grep excludes — the accepted `determinism.test.ts` pattern.

### Observational neutrality (plan §1, R3-P0-3) — PROVEN

Tracing consumes **no `world.rngState`** and mutates **no sim state**: the probes
(`surfaceMovementAt`, `canEnterUndergroundTile`, the scent scan) are pure reads,
and the pheromone-branch probe calls `sampleForagingDirection` with a **throwaway
`Rng`** that never touches `world.rngState`; the only randomness that advances the
world flows through `tick()`'s internal `Rng`. `checkObservationalNeutrality`
runs the same `(seed, difficulty, inputLog)` twice — once with full per-tick
tracing, once clean — and asserts the final **serialized `WorldState` AND
`rngState` are byte-identical**. Asserted green for both the empty log (seed 11)
and the construction log (seed 42). Perf baselines are collected with tracing
disabled.

### Seed sets (disjoint; asserted)

- **Discovery** (inspected freely): `11, 42, 99, 7, 123, 256, 777, 2024, 31415, 8675309`
  — includes **seed 11** (Codex's scent-vs-wall repro; already inspected, so not a clean hold-out).
- **Calibration** (sets the numeric caps): `13, 17, 23, 51, 88, 101, 202, 303, 404, 505`.
- **Acceptance** (untouched hold-out; never inspected during design; post-fix only):
  `1009, 2017, 3023, 4051, 5077, 6101, 7127, 8147, 9173, 10193`.
  If an acceptance seed ever fails (R4-P2-5) it is no longer clean → move it into
  discovery and mint a fresh acceptance set before retuning.

---

## 2. Branch manifest (auditable — plan §6 completion gate)

Every live steering / post-steering branch, its locus, whether it is
production-reachable at V27, and what exercises it. Loci are as of this branch
(`flurry-pr2-investigation`). "Sweep" = the empty-log/construction-log traced
sweep in this harness; "suite" = a pre-existing committed test.

### Base steering sources

| #   | Branch                                            | Locus (`ant-system.ts` unless noted) | Reachable @V27 | Exercised by                                                      |
| --- | ------------------------------------------------- | ------------------------------------ | :------------: | ----------------------------------------------------------------- |
| B1  | Idle skip (non-steering)                          | ~4255                                |      yes       | sweep (queens/idle)                                               |
| B2  | Search-pause hold / trigger                       | ~4469–4486                           |   yes (V4+)    | sweep (#127 episodes interleave pauses)                           |
| B3  | Priority-target routing (`pickCardinalStep`)      | ~4489–4503                           |      yes       | `surface-passability.test.ts` (no marking in the empty-log sweep) |
| B4  | **Scent steering** (`findNearestScentPile`, R=15) | ~4514–4519                           |      yes       | **sweep (dominant #127 source)**                                  |
| B5  | Pheromone follow (`sampleForagingDirection`)      | ~4521–4548                           |      yes       | sweep (#127 pheromone episodes)                                   |
| B6  | Excursion wander (`chooseExcursionDirection`)     | ~4545–4554                           |      yes       | sweep (#127 wander episodes)                                      |
| B7  | Carrier chamber-food routing (flow-field)         | ~4242–4312                           |      yes       | construction-log sweep                                            |
| B8  | Carrier entrance fallback                         | ~4313–4444                           |      yes       | construction-log sweep                                            |
| B9  | Surface entrance routing (home-bound)             | ~4396–4444                           |   yes (V11+)   | construction-log sweep                                            |
| B10 | Digger dig-flow-field (`getTaskDirection`)        | ~4686 / 1490                         |      yes       | construction-log sweep                                            |
| B11 | Digger excavating hold                            | 1500–1503                            |      yes       | construction-log sweep                                            |
| B12 | Nurse chamber routing                             | 1532–1626                            |   yes (V10+)   | `chamber-flow.test.ts`                                            |
| B13 | Fighter rally routing                             | ~4558–4683                           |      yes       | `fighter-rally-hold.test.ts`                                      |
| B14 | Fighter rally hold                                | ~4676–4683                           |      yes       | `fighter-rally-hold.test.ts`                                      |
| B15 | Invader underground pursuit                       | ~4585–4652                           |      yes       | `determinism.test.ts` cross-grid, `invasion-routing.test.ts`      |
| B16 | Invader recall-to-entrance                        | ~4600–4627                           |   yes (V25+)   | `invasion-routing.test.ts`                                        |

### Post-steering transforms

| #   | Transform                                             | Locus      | Reachable  | Exercised by                              |
| --- | ----------------------------------------------------- | ---------- | :--------: | ----------------------------------------- |
| T1  | Surface no-revisit substitution (recent-tiles, 8-dir) | ~4691–4738 |    yes     | sweep                                     |
| T2  | Underground no-revisit substitution (4-dir)           | ~4740–4784 | yes (V14+) | construction-log sweep                    |
| T3  | SoftCost speed halving                                | ~4790–4807 | yes (V6+)  | sweep                                     |
| T4  | Underground passability guard + per-axis revert       | ~4811–4882 |    yes     | construction-log sweep                    |
| T5  | Surface passability guard + `pickSurfaceDetour`       | ~4884–4951 | yes (V6+)  | sweep (#127 scent-vs-wall)                |
| T6  | Bounds clamp (underground / surface)                  | ~4953–4965 |    yes     | sweep                                     |
| T7  | Occupancy displacement (`resolveSameColonyOccupancy`) | ~5234–5370 |    yes     | sweep (post-occupancy positions observed) |
| T8  | Occupancy exemptions (`isOccupancyExempt`)            | ~5386–5425 |    yes     | sweep                                     |
| T9  | Flow diagonalization (`diagonalizeFlowStep`)          | ~4256      |    yes     | construction-log sweep                    |

### Zone transitions

| #   | Transition                                         | Locus      |   Reachable   | Exercised by                      |
| --- | -------------------------------------------------- | ---------- | :-----------: | --------------------------------- |
| Z1  | ReturningToNest → SearchingFood at entrance        | ~5031–5066 |      yes      | sweep (wave resets observed)      |
| Z2  | Descent gate + iteration (`posY=0`, no Open check) | ~5074–5156 |      yes      | **#128 class-ii structural test** |
| Z3  | Pre-descent blocker gate (`isDescentBlocked`)      | ~5132–5139 |      yes      | `predescent-gate.test.ts`         |
| Z4  | Ascent (grid-aware, invader skip, recall)          | ~5162–5208 | yes (V13/V25) | `invasion-routing.test.ts`        |

### Recent-tiles ring-buffer sites (plan §4 — the hard-coded `4`)

`RECENT_TILES_LEN = 4` (`ant-store.ts:259`). Sites: alloc `ant-store.ts:292–298`;
head `:346`; clear `clearRecentTiles :490–497`; push `pushRecentTile :469–475`;
membership `isRecentTile :481–487`. Consumed at `ant-system.ts` ~4710, ~4759,
~4908, and inside `pickSurfaceDetour` ~3191. Test reference uses a hard-coded
`4` at `ant-system.test.ts:6916`. **A deepened buffer (the C-both 4-vs-12
experiment) must touch every one of these sites** — see §6.

### Explicit exclusions (unreachable-in-production / test-only)

- **LEGACY drain-order branch** (`withdrawFood` LEGACY path) — only reached by
  `determinism.test.ts` "LEGACY vs LATEST"; saves below `MIN_ACCEPTED_SIM_VERSION = 22`
  reject at load, so the pre-V22 movement variants are unreachable.
- **Pre-V4/V6/V8/V10/V11/V13/V14/V23/V24/V25 gated movement variants** — superseded;
  a save in the accepted window (V22–V27) never selects them. Listed in the
  version-gate table the manifest agent produced; not separately exercised because
  production cannot reach them.
- **Render-only sprite placement** (`draw-underground.ts`) — see #128 class-iii;
  not a sim branch, probed render-side only.

**Completion-gate status:** every **production-reachable** base/transform/transition
branch above is exercised either by this harness's sweep or by a named committed
suite, and the sweep surfaced **zero uncatalogued** stuck/embedded episode
_classes_ (every episode the detector raised maps to a catalogued mechanism in
§4/§5). Caveat held open honestly: the gate is met for the \*\*named-seed + command-log

- structural-synthetic** suites as required; it is **not\*\* an open-ended seed sweep,
  and the render-only class is bounded by a documented probe, not a screenshot
  regression (see §5).

---

## 3. Route-kind / transform taxonomy

The base steering source of a confined surface searcher is reconstructed from the
sim's **exact movement-time precedence** (`computeDecisions`, pre-`tick`):
**`search-pause > scatter > priority > scent > pheromone > wander`** — where
`search-pause` is the V4+ stationary pause (`tickAntMovement` exits before any
steering, so no step is intended — never a wall-aim), `scatter` is the
spider-flee override (`tick.ts` step 13e), `priority` is resolved from the colony's
`priorityFoodPileId` (not the stale `targetPos`), and the pheromone/wander split is
the real `sampleForagingDirection` (incl. the prev-tile anti-backtrack). The wider
`MovementSource` enum (`debug-snapshot.ts`) covers the non-searcher routes —
**carrier** `food-storage | entrance`; **underground searcher** `underground-exit`;
**nurse** `nursing-chamber`; **fighter** `rally`; fallback `task`; `dead`.
Transforms (T1–T9 above) are observed via tile-state + position deltas after
occupancy resolution. This is the taxonomy used to label every episode below.

---

## 4. #127 — surface forager confinement (catalog)

**Definition used (plan §2):** a `SearchingFood` forager is _confined this tick_
when, over the trailing 20-tick window, it stays inside a ≤3×3 Chebyshev box
**while actively moving** (≥4 tile-crossings/window) — staying boxed for a full
window _is_ the no-progress signal, so no separate progress gate is needed. The
position window is cleared on each new search wave (entrance re-launch) and on
surface re-entry, so productive searching never false-positives. An **episode** is
a contiguous run of confined ticks; `startTick` is the first confined tick and
`lengthTicks` is the run length, so length, locus, sources, and `aimedIntoWall`
all describe the **same** interval. `finishConfinement` keeps only runs
≥`CONFINE_MIN_TICKS` (a single duration gate). `aimedIntoWall` is set from the
ant's **actual intended step** (toward its priority target or nearest scent pile),
computed from **pre-movement** state each tick.

### 4.1 Severity (measured — 20 seeds × 3 difficulties × 3000 ticks)

| Difficulty | Episodes | Confined ants (sum) |     Worst episode (ticks) |
| ---------- | -------: | ------------------: | ------------------------: |
| Easy       |       62 |                  13 |                      2050 |
| Normal     |       61 |                  13 |                      2050 |
| Hard       |       60 |                  13 |                      1965 |
| **Total**  |  **183** |                   — | **2050 (~102 s @ 20 Hz)** |

Worst _confirmed_ episode is **2050 ticks** — independently matching Step-0's
worst (2050) — and is essentially difficulty-independent.

### 4.2 Mechanism attribution — **scent-vs-wall dominates** (corrects Step-0)

Movement-source tally across confined ticks (all seeds/difficulties):

| Source       | Confined-tick count | Note                                                                     |
| ------------ | ------------------: | ------------------------------------------------------------------------ |
| **scent**    |           **32610** | dominant                                                                 |
| search-pause |                5407 | V4+ stationary pause (non-steering; never a wall-aim)                    |
| pheromone    |                2692 | exact branch (sampleForagingDirection)                                   |
| wander       |                 574 |                                                                          |
| priority     |                   0 | none (no player marking in the empty-log sweep)                          |
| scatter      |                   0 | spider-flee override (radius 1; never coincided with a confinement tick) |

**158 of 183 episodes (86 %)** aim the ant's **actual intended step** — the
cardinal/diagonal move toward its priority target or nearest scent pile, replicated
from `pickCardinalStep` + `findNearestScentPile`, evaluated from **pre-movement**
state — onto a **`HardBlock`** (`aimedIntoWall`, a precise destination-tile test),
and **every one of the 10 longest episodes is pure-`scent` with
`aimedIntoWall = true`.** This **confirms the re-plan's corrected root cause**
(scent steering's naive `pickCardinalStep` aims straight at a pile through a
`HardBlock`, `ant-system.ts:4514`) and **supersedes Step-0's "worst case is pure
wander"** — Step-0's detector counted milling-ticks; attributing by steering
source shows scent is the severe, long-tail mechanism. Wander confinement is real
but short-tail.

> **Note on Step-0's two solid negatives — still upheld.** This investigation does
> **not** re-open gradient hysteresis or the recent-tiles guard pass-through; both
> remain disproven and out of scope (plan "Established findings").

### 4.3 Canonical reproductions (seed + locus)

| Mechanism                         | Seed | Ant | Start |  Len | Locus (tile) | Source | Wall |
| --------------------------------- | ---: | --: | ----: | ---: | ------------ | ------ | :--: |
| **Scent-vs-wall (Codex repro)**   |   11 |  22 |   950 | 2050 | (100,43)     | scent  |  ✓   |
| Scent-vs-wall (next-worst)        |   42 |  17 |  1035 | 1965 | (17,55)      | scent  |  ✓   |
| Scent-vs-wall (calibration worst) |   51 |  17 |     — | 1481 | ~(10–12,56)  | scent  |  ✓   |

Seed 11 / ant 22 reproduces Codex's exact case (`movementSource="scent"`, intended
step into a `HardBlock`) at locus (100,43) — adjacent to the enemy start column
(104), a player forager scenting a pile across a wall. Pheromone and wander
confinement also occur but are **short-tail** (longest non-scent sustained episode
is well under 300 ticks); after the precise intended-step test, **158/183
episodes are scent/priority-vs-wall**, and they dominate the long tail.

### 4.4 Per-seed worst episode (Normal) — calibration drives the caps

Discovery worst: **2050** (seed 11). Calibration worst: **1481** (seed 51).
Calibration per-seed worst: `13→294, 17→212, 23→0, 51→1481, 88→0, 101→0,
202→0, 303→950, 404→0, 505→0`. Sustained confinement **clusters in a subset of
seeds** (several show 0): it appears where a food pile sits behind a procedural
`HardBlock` within scent range, so the scent step pins on the wall — exactly the
mechanism Fix-A targets. The rest is a short tail of sub-300-tick wander/pheromone
loops.

### 4.5 → committed fix

Maps to **Fix-A (passability-aware food routing for scent _and_ priority via one
primitive; target selection by path distance; source-aware no-revisit)** and, only
if the 4-vs-12 experiment proves independent value, **C-both**. The scent-vs-wall
class is Fix-A's primary target; the short-tail wander loops are the C-both
pocket-escape's target **iff** §6's experiment justifies it.

---

## 5. #128 — underground embedding (catalog)

**Oracle (plan §5):** an ant is _embedded_ when its current tile is non-passable
**judged task-aware** via `canEnterUndergroundTile(grid, x, y, task)` (Marked is
legal for a Digger). The harness scans every underground ant every tick using the
ant's `currentGridColonyId` grid.

### 5.1 Natural occurrence — **~0 under tested command logs** (important)

Running the construction log (entrance designation + dig marking + chamber
placement + **mid-excavation `CancelDigMark`**) on 5 discovery seeds × 3000 ticks
produced **zero** natural embedding episodes. **#128 is a latent
invariant-violation, not a high-frequency emergent bug** under the command
patterns tested. This reframes the fix: PR 2b guards invariants that the _current_
AI/player command mix rarely trips, rather than stopping a constantly-firing loop.
(The shipped game's render-side AI may issue different cancel/cancel-timing
patterns; widening the command logs to the real AI cadence is a checkpoint item.)

### 5.2 Classification (plan §5 (i)–(iv)) + structural reproductions

| Class                            | Mechanism                                                                                                                                                                                                              | Locus                      | Repro status                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **(ii) descent placement**       | Descent sets `posY=0`, `zone=Underground` with **no Open-tile check** (`ant-system.ts:~5140`). A non-Open landing tile → embedded.                                                                                     | Z2                         | **Structural test green** — corrupt landing tile to Solid, CarryingFood forager descends, lands on Solid, `canEnter…=false`.                    |
| **(iv) mutation-under-occupant** | `CancelDigMark` reverts Marked→Solid (`tick.ts:424`), and chamber-cancel reverts the footprint, **with no occupancy check**. Also `PlaceChamber` Solid→Marked (`tick.ts:603`) and dig-completion BeingDug→Open.        | T4 / commands              | **Structural test green** — digger on a Marked tile, `CancelDigMark` reverts it to Solid under the standing digger, `canEnter…(Digging)=false`. |
| (i) terrain-pocket               | Sustained embedding while attempting to move (non-mutation, non-descent).                                                                                                                                              | B7–B11/T4                  | Not observed naturally; detector classifies it if it occurs.                                                                                    |
| **(iii) render-only**            | `draw-underground.ts` draws ant sprites **center-origin** while tiles are **corner-origin 32 px**; a sub-tile fractional position on a valid Open tile can render the sprite _visually_ inside an adjacent Solid tile. | `draw-underground.ts:~515` | **Sim-only probe cannot see it** — see below.                                                                                                   |

The harness auto-classifies each episode as `descent-placement` /
`mutation-under-occupant` / `terrain-pocket` from the zone/tile transition on the
first embedded tick.

### 5.3 Render-only (iii) — probe note (R3-P0-2)

A sim tile-validity probe is blind to class (iii): the sim places the ant on a
legal Open tile, but the renderer's center-origin sprite over a corner-origin 32 px
tile grid can paint it overlapping adjacent dirt. **This is the most likely cause
of player-visible "embedded in dirt" given the ~0 sim-side natural rate.** A
proper probe is render-coordinate / sprite-footprint vs rendered-dirt geometry (or
a screenshot regression) — out of this sim-only harness's reach and flagged for
the checkpoint. Per-task BFS goal fields differ (forager `food`, carrier
`food/entrance`, nurse `nursing/nurseDeposit`, digger `dig`), so each task's
embedding must be diagnosed against its own field — captured in the manifest.

### 5.4 → committed fix

Maps to **PR 2b (#128)**: (ii) a descent landing-tile validity guard; (iv)
occupancy-aware terrain mutation (or post-mutation displacement); (iii) a
render-side fix, separate from sim. PR 2b shares PR 2's escape **only after** a
common failure contract is proven — the data says (ii)/(iv) are latent and (iii)
is render-side, so a shared sim escape is **not** yet justified.

---

## 6. Measurements that gate the fixes (plan §4)

### 6.1 Static-terrain feature-field oracle (plan §3, R3-P1-6)

Hash = FNV-1a over the **complete 128×128** `surfaceMovementAt` effect field.

- **Mutation exists and is large:** of **900** food piles (20 seeds × 3
  difficulties), **477 (53 %)** reveal a previously-suppressed **HardBlock** within
  their 7×7 halo when removed — **5268** revealed tiles total. This is the
  static-terrain bug class (depleting a pile _reveals_ terrain under it); it
  generalises Codex's 348/3000 stale-cached-path probe to the underlying field.
- **Entrance designation** also flips the field (suppression halo) — asserted in
  the test by scanning columns until a flip is found.
- **Save/load is invariant:** `featureFieldHash` and `featureFieldDiffCount` are
  identical across `serialize → deserialize` (diff = 0) — terrain inputs round-trip
  cleanly, so the redesign's "exact-equality across save/load" oracle is satisfiable.
- **Per-scenario fingerprint is stable:** e.g. seed 11 → `3899278803`, seed 42 →
  `742821237`, seed 99 → `630142740` (Normal).

**Oracle for the redesign:** require `featureFieldHash` **exactly equal** across
pile spawn, depletion, entrance designation, entrance opening, save/load
round-trip, and command-driven runs. Today it is **not** invariant (477/900); the
static-terrain change must make it invariant. The hash + diff functions are
committed and ready to assert this post-fix.

### 6.2 4-vs-12 recent-tiles experiment — **methodology + baseline (deferred run)**

`RECENT_TILES_LEN` is a **compile-time** constant sizing typed arrays
(`ant-store.ts:259`), so a len-12 run requires a code change touching every
ring-buffer site in §2 — that is a **fix-side** experiment, correctly belonging to
the checkpoint, not Phase-0 diagnosis. **Baseline (len=4) confinement is catalogued
above (183 episodes; 158 wall-pins).** The experiment to run at the checkpoint:
rebuild with len=12, re-run the _calibration_ sweep, and retain the deepening
**only if** it independently reduces confinement (especially the short-tail
wander/pheromone loops) **without** unacceptable global path change. Until then,
C-both's recent-tiles deepening is **not** justified by data and stays gated
(Codex P0-4).

### 6.3 Perf baseline + budget (tracing disabled)

Seed 42, 3000 ticks: **~0.26 ms/tick** (Easy 0.253, Normal 0.257, Hard 0.253;
~765 ms total per run), difficulty-independent, on the dev machine in Node 26.
**Budget for path-aware routing (Fix-A):** the 20 Hz timestep is 50 ms/tick; the
current sim uses ~0.5 % of that. A per-pile BFS field or bounded local BFS has
ample headroom, but Fix-A must still ship with **preallocated per-world caches +
explicit invalidation + a tick-time budget** (re-measure with this harness's
`measurePerfAndSize` as the pre/post gate; flag any regression beyond, say, 2×).

### 6.4 Save-size baseline + quota

Serialized `WorldState` (JSON string length) at tick 3000 ≈ **1.095 MB**
(1,095,416 / 1,095,377 / 1,095,127 bytes for Easy/Normal/Hard). Any new stored
array (baked terrain grid, deepened recent-tiles buffer, confinement counter) is
measured against this baseline; **proposed quota: a new per-ant array must add
< 5 %** (~55 KB) and a baked 128×128 terrain grid (~16 KB raw) is well within it.
Re-measure with `measurePerfAndSize` in each fix PR.

### 6.5 SoA / serialization site matrix (plan §4)

Any new stored field must be threaded through **every** site, mirroring the
existing SoA discipline visible in `determinism.test.ts`'s serializer:
**allocation** (`ant-store.ts` create), **init** (`initAnt`), **push/scan/clear**
(per-field ops), **SoA copy** (`copyWorldState`), **raw save serialize/deserialize**
(`save.ts`), **determinism-test serialize** (`determinism.test.ts`
`serializeWorldState`), and **every task-transition reset**. The hard-coded `4` at
`types.ts:461` and `ant-system.test.ts:6916` must be replaced with the symbolic
length if the buffer is deepened. This harness's neutrality + the existing
determinism suite together catch a missed site (a divergence in any unthreaded
field breaks byte-parity).

---

## 7. Numeric acceptance caps (set from calibration; verify on acceptance)

Derived from the **calibration seeds ONLY** (10 seeds × 3 difficulties: **136
episodes, 127 wall-pins, worst 1481 ticks**) — the §4 severity figures (183/158,
worst 2050) are the full discovery+calibration sweep and are NOT the cap basis. To
be **verified post-fix on the untouched acceptance seeds** + structural cases
(never the reverse):

| Metric                                            | Baseline (calibration-only) | Proposed cap (post-fix)       |
| ------------------------------------------------- | --------------------------: | ----------------------------- |
| Worst confinement episode                         |                  1481 ticks | **≤ 60 ticks (3 s)**          |
| Scent/priority-vs-wall episodes (`aimedIntoWall`) |                     127/136 | **0**                         |
| Confinement episodes > 300 ticks                  |                        many | **0**                         |
| #128 embedded ant-ticks (structural cases)        |                 >0 (latent) | **0**                         |
| Feature-field hash invariance across events       |              477/900 mutate | **0 mutate (exact equality)** |
| Tick-time (3000-tick run)                         |               ~0.26 ms/tick | **≤ 0.5 ms/tick**             |
| Save size                                         |                   ~1.095 MB | **≤ +5 %**                    |

These caps are **proposals for the checkpoint**, not final — they are set here from
calibration data so the checkpoint can confirm/adjust them, then verification runs
on the acceptance hold-out.

---

## 8. Mechanism → committed fix (summary)

| Mechanism (catalogued)                                     | Committed fix                                   | PR             |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------- |
| Scent-vs-wall (dominant #127)                              | Fix-A path-aware scent+priority routing         | PR 2           |
| Short-tail wander/pheromone loops                          | C-both pocket-escape **iff** 4-vs-12 justifies  | PR 2           |
| Field mutates on pile spawn/deplete + entrance designation | Static terrain + reachable-spawn + connectivity | PR 2a (first)  |
| #128 (ii) descent placement                                | Descent landing-tile validity guard             | PR 2b          |
| #128 (iv) mutation-under-occupant                          | Occupancy-aware terrain mutation / displacement | PR 2b          |
| #128 (iii) render-only embedding                           | Render-side sprite/tile geometry fix            | PR 2b (render) |

---

## 9. Honest limitations / open items for the checkpoint

1. **#128 natural rate is ~0** under the tested command logs — the structural
   reproductions are real and green, but the **emergent** trigger (esp. the
   player-visible render-only class iii) needs the real AI cancel cadence and a
   render-geometry probe. Highest-value checkpoint follow-up.
2. **4-vs-12** is a deferred build-flag experiment (compile-time constant); only
   the len=4 baseline is measured here.
3. The branch manifest's loci are accurate as of this branch but are **line
   approximations** from a structured read; treat them as anchors, re-grep before
   editing.
4. The completion gate is met for **named-seed + command-log + structural** suites
   as the plan specifies — not an open-ended seed sweep.
5. **Source/wall-aim attribution timing.** Decisions are snapshotted just before
   `tick()` and reproduce the sim's exact movement-time precedence
   **search-pause > scatter > priority > scent > pheromone > wander**: scatter from
   `world.scatterReticleTile` (the shadow step 13e consumes), priority from the
   colony's `priorityFoodPileId` (what `routeForagerPriority` step 13 actually
   uses — never the stale pre-tick `targetPos`), then `findNearestScentPile`, then
   the real `sampleForagingDirection` (prev-tile anti-backtrack). **Residual:** the
   pheromone trail grid is read one tick stale — deposit/decay (steps 14–15) run
   mid-`tick` before movement (step 16) — so a near-threshold cell could flip a
   pheromone↔wander label. This is far smaller than the prior nearby-pheromone
   heuristic and cannot affect the scent/scatter/priority counts or the
   scent-vs-wall conclusion; an exact pheromone label would need an intra-tick
   hook (post-step-15, pre-movement). Scatter never coincided with a confinement
   tick in the sweep (radius 1). **Search pause:** in-pause ticks
   (`searchPauseTicks > 0`) are labeled `search-pause` from pre-tick state, and the
   pause-ENTRY tick (a `searchPauseTicks == 0 → set` RNG roll that `tick` enters
   before steering) is caught **post-tick** (the counter went 0→>0) and relabeled
   `search-pause` too — so no paused tick contributes a steering count or a false
   wall-aim. No residual remains for pauses.

---

## Reproducing the full sweep

```ts
import { runTracedScenario, measurePerfAndSize, featureFieldHash } from './harness.js';
import { DISCOVERY_SEEDS, CALIBRATION_SEEDS, DIFFICULTIES } from './seeds.js';
import { emptyLog, playerConstructionLog } from './input-logs.js';

for (const seed of [...DISCOVERY_SEEDS, ...CALIBRATION_SEEDS])
  for (const diff of DIFFICULTIES) runTracedScenario(seed, diff, 3000, emptyLog(3000)); // #127
// #128 + measurements: playerConstructionLog, measurePerfAndSize, featureFieldHash.
```

The committed `harness.test.ts` runs a bounded subset so `npm run verify` stays
green; the numbers in this document come from the full sweep above.
