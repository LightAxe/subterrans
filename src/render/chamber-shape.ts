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
 * Number of wave-driven edge samples around the chamber perimeter. The
 * total point count returned by `chamberPerimeterPoints` is
 * NUM_PERIMETER_POINTS + NUM_CORNER_SAMPLES (=4 fixed inflated-rectangle
 * corners). Tests should size assertions against the total.
 */
export const NUM_PERIMETER_POINTS = 32;

/**
 * Fixed corner samples inserted at the 4 inflated-rectangle corners.
 * These guarantee that the chord between adjacent perimeter samples always
 * wraps AROUND each corner externally (otherwise the chord between the last
 * edge-sample before a corner and the first edge-sample after the corner
 * could cut through the rectangle interior with extreme jitter).
 */
export const NUM_CORNER_SAMPLES = 4;

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
 * wave-driven edge samples plus 4 fixed corner samples at the inflated
 * rectangle's corners, returned in clockwise order starting at the top-left
 * corner. Total length: numEdgeSamples + NUM_CORNER_SAMPLES.
 *
 * Each edge sample walks the inflated rectangle's perimeter and is
 * displaced along its outward normal by a deterministic smooth-wave offset
 * in [-jitterAmp, +jitterAmp]. Outward = away from the chamber center.
 *
 * The base rectangle is inflated by the (clamped) wave amplitude on each
 * side, so the worst inward swing of the wave reaches exactly the original
 * rectangle's edge — never crosses INSIDE it. The 4 corner samples then
 * guarantee that the CHORD between adjacent perimeter samples also stays
 * outside the original rectangle: without corner samples, the chord between
 * the last edge-sample before a corner and the first edge-sample after the
 * corner can dip across the corner area into the original rectangle interior
 * (codex P1 on PR #100, seed=0 case).
 *
 * Together, point-position + corner-chord guarantees mean the polygon ALWAYS
 * covers the rectangular CHAMBER_DIMENSIONS footprint. Substrate doesn't
 * peek through. Outward swings extend up to 2 × amplitude beyond the original
 * rectangle into adjacent open-floor tiles, which reads as the chamber's
 * irregular hand-carved boundary.
 *
 * Points are placed at half-step offsets ((i + 0.5) / numEdgeSamples) so
 * no edge sample lands exactly on the inflated rectangle's corners where
 * the outward normal is ambiguous.
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

  // Inflate the base perimeter by ampClamped px on each side. The wave's
  // inward swing (up to -ampClamped) then reaches exactly the original
  // rectangle edge.
  const inflW = w + 2 * ampClamped;
  const inflH = h + 2 * ampClamped;
  const inflTLX = topLeftX - ampClamped;
  const inflTLY = topLeftY - ampClamped;
  const perim = 2 * (inflW + inflH);

  // Corner samples (clockwise from top-left), each at the matching `t`
  // along the inflated perimeter. Inserted into the output stream as we
  // pass them during the edge-sample walk.
  const cornerXs = [inflTLX, inflTLX + inflW, inflTLX + inflW, inflTLX];
  const cornerYs = [inflTLY, inflTLY,         inflTLY + inflH, inflTLY + inflH];
  const cornerTs = [0,       inflW,           inflW + inflH,   2 * inflW + inflH];

  const points: PerimeterPoint[] = [];
  let cornerIdx = 0;

  for (let i = 0; i < numEdgeSamples; i++) {
    const t = ((i + 0.5) / numEdgeSamples) * perim;

    while (cornerIdx < 4 && cornerTs[cornerIdx]! < t) {
      points.push({ x: cornerXs[cornerIdx]!, y: cornerYs[cornerIdx]! });
      cornerIdx++;
    }

    let baseX: number, baseY: number, nx: number, ny: number;

    if (t < inflW) {
      baseX = inflTLX + t;
      baseY = inflTLY;
      nx = 0; ny = -1;
    } else if (t < inflW + inflH) {
      baseX = inflTLX + inflW;
      baseY = inflTLY + (t - inflW);
      nx = 1; ny = 0;
    } else if (t < 2 * inflW + inflH) {
      baseX = inflTLX + inflW - (t - inflW - inflH);
      baseY = inflTLY + inflH;
      nx = 0; ny = 1;
    } else {
      baseX = inflTLX;
      baseY = inflTLY + inflH - (t - 2 * inflW - inflH);
      nx = -1; ny = 0;
    }

    const jitter = sampleWaveAt(nodes, i, numEdgeSamples);
    points.push({ x: baseX + nx * jitter, y: baseY + ny * jitter });
  }

  while (cornerIdx < 4) {
    points.push({ x: cornerXs[cornerIdx]!, y: cornerYs[cornerIdx]! });
    cornerIdx++;
  }

  return points;
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
  const nodes: number[] = new Array(NUM_WAVE_NODES);
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
