// chamber-shape.ts — #97 organic chamber walls.
//
// Pure helpers for deterministic per-chamber rendering geometry. Render-only:
// no Phaser, no Math.random in the hash path, no save-impacting state. The
// simulation footprint stays rectangular (CHAMBER_DIMENSIONS); these helpers
// only shape what the player sees, so chambers read as hand-carved earth
// rather than tile-grid rectangles.
//
// Determinism: a chamber's identity (colonyId, chamberId, chamberType) is
// stable across ticks and across save/reload, so the same chamber renders
// with the same wavy outline each frame. No persisted shape state.
//
// Visual model: the wall is the bounding rectangle's perimeter sampled at
// NUM_PERIMETER_POINTS evenly-spaced points, with each point displaced along
// its outward normal by a deterministic per-chamber smooth wave. The wave is
// the linear interpolation of NUM_WAVE_NODES integer offsets sampled from
// the chamber's seed, giving a low-frequency wobble (4 wavelengths around
// the perimeter at the default settings) — closer to "hand-drawn rectangle"
// than "noisy zigzag." Outward = away from the chamber center.

const HASH_MIX_A = 0x85ebca6b;
const HASH_MIX_B = 0xc2b2ae35;
const HASH_MIX_C = 0x27d4eb2f;

/**
 * 32-bit integer hash from a chamber's identity. Deterministic, integer-only,
 * stable across runs and reloads. Returned as a non-negative 32-bit value.
 */
export function chamberSeed(colonyId: number, chamberId: number, chamberType: number): number {
  let h = Math.imul(colonyId | 0, HASH_MIX_A);
  h ^= Math.imul(chamberId | 0, HASH_MIX_B);
  h ^= Math.imul(chamberType | 0, HASH_MIX_C);
  h ^= h >>> 16;
  h = Math.imul(h, HASH_MIX_A);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Per-node deterministic 32-bit hash, derived from a chamber seed plus an
 * index. Same Math.imul mixer as chamberSeed; returns non-negative 32-bit.
 */
function nodeSeed(chamberSeedValue: number, nodeIndex: number): number {
  let h = Math.imul(chamberSeedValue | 0, HASH_MIX_A);
  h ^= Math.imul(nodeIndex | 0, HASH_MIX_B);
  h ^= h >>> 16;
  h = Math.imul(h, HASH_MIX_C);
  h ^= h >>> 13;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Wavy perimeter
// ---------------------------------------------------------------------------

/**
 * Number of wave-driven edge samples around the chamber perimeter (split
 * across the 4 truncated straight edges). The total point count returned
 * by `chamberPerimeterPoints` is NUM_PERIMETER_POINTS + 4 *
 * NUM_CORNER_ARC_SAMPLES — 4 inscribed quarter-arcs, one per corner of
 * the inflated rectangle.
 */
export const NUM_PERIMETER_POINTS = 32;

/**
 * Number of samples per inscribed corner arc (4 corners total). 5 samples
 * across a 90° quarter-arc = 4 line segments at 22.5° each, smooth enough
 * to read as rounded rather than chamfered at typical chamber pixel sizes.
 */
export const NUM_CORNER_ARC_SAMPLES = 5;

/**
 * Default corner radius in pixels for the inscribed corner arcs. Chosen as
 * 2 × WAVE_AMPLITUDE_PX so the corner curvature is on a similar scale to
 * the edge wave wobble — visible but not overwhelming. Capped per chamber
 * to stay within bounds (see chamberPerimeterPoints).
 */
export const CORNER_RADIUS_PX = 6;

/**
 * Number of "wave nodes" — integer offsets that get linearly interpolated
 * around the perimeter. Lower = smoother wave with longer wavelength. With
 * 8 nodes around 32 perimeter points, each node spans 4 perimeter points.
 */
export const NUM_WAVE_NODES = 8;

/** Default wall-jitter amplitude in pixels (peak displacement from the rectangle edge). */
export const WAVE_AMPLITUDE_PX = 3;

export interface PerimeterPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Compute the chamber's wavy perimeter as a closed polygon: `numEdgeSamples`
 * wave-driven samples distributed across the 4 truncated straight edges
 * (in clockwise order: top, right, bottom, left), interleaved with 4
 * inscribed quarter-arc corners at NUM_CORNER_ARC_SAMPLES samples each.
 * Total length: numEdgeSamples + 4 * NUM_CORNER_ARC_SAMPLES.
 *
 * Geometry:
 *   1. Inflate the base rectangle by the (clamped) wave amplitude on each
 *      side. The wave's inward swing on a straight edge then reaches at
 *      most the original rectangle's edge — never inside.
 *   2. Truncate each straight edge by CORNER_RADIUS_PX on both ends so
 *      they meet the inscribed corner arcs cleanly (no double-back).
 *   3. At each inflated corner, replace the sharp 90° turn with a quarter-
 *      circle inscribed in the corner: arc center at (corner + R inward
 *      diagonally), radius R, sweeping 90° clockwise. The arc midpoint
 *      stays outside the original rectangle for R ≤ ~3.4 × amplitude
 *      (default 6 px vs amp 3 px is well within margin).
 *
 * Together this gives a chamber outline that's wavy on the long edges and
 * smoothly rounded at the corners — closer to "hand-carved oval" than
 * "rectangle with bumps."
 *
 * Edge samples are placed at half-step offsets ((i + 0.5) / numEdgeSamples)
 * across the truncated straight perimeter so no sample lands exactly on
 * the truncation boundary where it would coincide with a corner-arc
 * endpoint.
 *
 * The chamber center is (topLeftX + w/2, topLeftY + h/2). The polygon is
 * suitable for fan-triangulation from that center for fill, and for
 * line-segment rendering between adjacent points for outline.
 */
export function chamberPerimeterPoints(
  seed: number,
  topLeftX: number,
  topLeftY: number,
  w: number,
  h: number,
  numEdgeSamples: number = NUM_PERIMETER_POINTS,
  jitterAmpPx: number = WAVE_AMPLITUDE_PX,
): PerimeterPoint[] {
  const ampClamped = clampAmplitude(jitterAmpPx, w, h);
  const nodes = computeWaveNodes(seed, ampClamped);

  // Inflate the base rectangle by ampClamped px per side so the wave's
  // inward swing on a straight edge reaches exactly the original rect edge.
  const inflW = w + 2 * ampClamped;
  const inflH = h + 2 * ampClamped;
  const inflTLX = topLeftX - ampClamped;
  const inflTLY = topLeftY - ampClamped;

  // Cap the corner radius so the truncated edges remain non-negative AND
  // the inscribed arc midpoint stays outside the original rectangle. The
  // arc midpoint is at distance (R - amp)*√2 from the original corner; we
  // need (R - amp)*√2 ≥ R, i.e. R ≤ amp / (1 - 1/√2) ≈ 3.41 × amp. We use
  // a defensive 3 × amp upper bound.
  const cornerR = clampCornerRadius(CORNER_RADIUS_PX, ampClamped, inflW, inflH);

  const truncW = inflW - 2 * cornerR;
  const truncH = inflH - 2 * cornerR;
  const straightPerim = 2 * (truncW + truncH);

  // Insertion thresholds in straight-perimeter t-space. The TL arc is
  // emitted before any edge sample (threshold 0); subsequent arcs are
  // emitted as t crosses each truncation boundary.
  const arcThresholds = [0, truncW, truncW + truncH, 2 * truncW + truncH];

  // Arc descriptors (clockwise from top-left). startAngle is in math
  // convention (0=east, π/2=south for screen y-down). Each arc sweeps
  // +π/2 from startAngle, which is visually clockwise in screen space.
  const arcs = [
    // TL: from end-of-left-edge (west of arc center) to start-of-top-edge (north).
    { cx: inflTLX + cornerR, cy: inflTLY + cornerR, startAngle: Math.PI },
    // TR: from end-of-top (north) to start-of-right (east).
    { cx: inflTLX + inflW - cornerR, cy: inflTLY + cornerR, startAngle: -Math.PI / 2 },
    // BR: from end-of-right (east) to start-of-bottom (south).
    { cx: inflTLX + inflW - cornerR, cy: inflTLY + inflH - cornerR, startAngle: 0 },
    // BL: from end-of-bottom (south) to start-of-left (west).
    { cx: inflTLX + cornerR, cy: inflTLY + inflH - cornerR, startAngle: Math.PI / 2 },
  ];

  const points: PerimeterPoint[] = [];
  let arcIdx = 0;

  const emitArc = (idx: number): void => {
    const arc = arcs[idx]!;
    for (let j = 0; j < NUM_CORNER_ARC_SAMPLES; j++) {
      const theta = arc.startAngle + (j / (NUM_CORNER_ARC_SAMPLES - 1)) * (Math.PI / 2);
      points.push({
        x: arc.cx + cornerR * Math.cos(theta),
        y: arc.cy + cornerR * Math.sin(theta),
      });
    }
  };

  for (let i = 0; i < numEdgeSamples; i++) {
    const t = ((i + 0.5) / numEdgeSamples) * straightPerim;

    while (arcIdx < 4 && arcThresholds[arcIdx]! <= t) {
      emitArc(arcIdx);
      arcIdx++;
    }

    let baseX: number, baseY: number, nx: number, ny: number;

    if (t < truncW) {
      // TOP edge — between TL and TR arcs.
      baseX = inflTLX + cornerR + t;
      baseY = inflTLY;
      nx = 0;
      ny = -1;
    } else if (t < truncW + truncH) {
      // RIGHT edge — between TR and BR arcs.
      baseX = inflTLX + inflW;
      baseY = inflTLY + cornerR + (t - truncW);
      nx = 1;
      ny = 0;
    } else if (t < 2 * truncW + truncH) {
      // BOTTOM edge — between BR and BL arcs.
      baseX = inflTLX + inflW - cornerR - (t - truncW - truncH);
      baseY = inflTLY + inflH;
      nx = 0;
      ny = 1;
    } else {
      // LEFT edge — between BL arc and the TL arc that opens the next loop.
      baseX = inflTLX;
      baseY = inflTLY + inflH - cornerR - (t - 2 * truncW - truncH);
      nx = -1;
      ny = 0;
    }

    const jitter = sampleWaveAt(nodes, i, numEdgeSamples);
    points.push({ x: baseX + nx * jitter, y: baseY + ny * jitter });
  }

  while (arcIdx < 4) {
    emitArc(arcIdx);
    arcIdx++;
  }

  return points;
}

/**
 * Clamp the corner radius so:
 *   - truncW = inflW - 2R ≥ 0 (truncated top/bottom edge non-negative)
 *   - truncH = inflH - 2R ≥ 0 (truncated left/right edge non-negative)
 *   - The arc midpoint stays outside the original rectangle:
 *     R ≤ ~3 × amp (slightly conservative vs the strict 3.41 × amp bound).
 *
 * Lower bound of 0 is allowed: at R=0 the arcs degenerate to single points
 * at each inflated corner — equivalent to the pre-rounding behavior.
 */
function clampCornerRadius(requested: number, amp: number, inflW: number, inflH: number): number {
  const halfMin = Math.min(inflW, inflH) / 2;
  const ampCap = amp > 0 ? 3 * amp : Infinity; // R=0 fine when amp=0
  return Math.max(0, Math.min(requested, halfMin, ampCap));
}

/**
 * Clamp wave amplitude to leave at least 1 px of margin on the chamber's
 * smaller half-extent so the inward swing of the wave can't collapse the
 * polygon to a degenerate shape on tiny hypothetical chambers.
 */
function clampAmplitude(requested: number, w: number, h: number): number {
  const halfMin = Math.min(w, h) >> 1;
  const cap = Math.max(0, halfMin - 1);
  return Math.min(requested, cap);
}

function computeWaveNodes(chamberSeedValue: number, ampPx: number): number[] {
  const nodes: number[] = new Array<number>(NUM_WAVE_NODES);
  if (ampPx <= 0) {
    nodes.fill(0);
    return nodes;
  }
  const range = 2 * ampPx + 1;
  for (let i = 0; i < NUM_WAVE_NODES; i++) {
    const h = nodeSeed(chamberSeedValue, i);
    nodes[i] = (h % range) - ampPx;
  }
  return nodes;
}

function sampleWaveAt(nodes: number[], pointIdx: number, totalPoints: number): number {
  const k = nodes.length;
  const t = (pointIdx / totalPoints) * k;
  const i0 = Math.floor(t) % k;
  const i1 = (i0 + 1) % k;
  const frac = t - Math.floor(t);
  return nodes[i0]! + (nodes[i1]! - nodes[i0]!) * frac;
}
