// sprite-shapes.ts — procedural shape primitives for composing pixel-art
// sprites. Used by terrain-motifs.ts to build the larger ant-scale sprites
// added in issue #44 step 3 without hand-authoring 2000+ lines of bitmap
// ASCII.
//
// Each helper paints onto a `canvas` (a flat number[] indexed `y * width + x`,
// where the value at each cell is a palette index — 0 means transparent).
// Caller allocates the canvas and passes it in; helpers mutate in place.
//
// Render-side only — `src/render/` is free to use floats and division. None
// of these helpers run inside the per-tick sim loop; they execute once at
// module load to produce the static `ReadonlyArray<number>` that backs each
// sprite's `pixels` field.

/** Allocate a transparent canvas of size width × height. */
export function makeCanvas(width: number, height: number): number[] {
  return new Array<number>(width * height).fill(0);
}

/** Stamp a single pixel if (x, y) is in bounds. */
export function paintPx(canvas: number[], width: number, x: number, y: number, color: number): void {
  if (x < 0 || y < 0 || x >= width) return;
  const height = canvas.length / width;
  if (y >= height) return;
  canvas[y * width + x] = color;
}

/**
 * Fill an axis-aligned ellipse centered at (cx, cy) with radii (rx, ry).
 * Half-pixel center bias so even-sized radii produce a symmetric blob.
 * Existing pixels under the ellipse are overwritten with `color` (color 0
 * leaves them as-is — use a separate clear pass if you want to "erase").
 */
export function paintOval(
  canvas: number[],
  width: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: number,
): void {
  if (color === 0) return;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(canvas.length / width - 1, Math.ceil(cy + ry));
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      if ((dx * dx) / rx2 + (dy * dy) / ry2 <= 1) {
        canvas[y * width + x] = color;
      }
    }
  }
}

/** Fill an axis-aligned rectangle, inclusive of both bounds. */
export function paintRect(
  canvas: number[],
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number,
): void {
  if (color === 0) return;
  const xa = Math.max(0, Math.min(x0, x1));
  const xb = Math.min(width - 1, Math.max(x0, x1));
  const ya = Math.max(0, Math.min(y0, y1));
  const yb = Math.min(canvas.length / width - 1, Math.max(y0, y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      canvas[y * width + x] = color;
    }
  }
}

/**
 * Bresenham line from (x0, y0) to (x1, y1), inclusive. Used for grass
 * blades, twig outlines, leaf veins.
 */
export function paintLine(
  canvas: number[],
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number,
): void {
  if (color === 0) return;
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    paintPx(canvas, width, x, y, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
  }
}

/**
 * Stamp a tapered grass-blade silhouette: vertical-ish line from (baseX,
 * baseY) toward (tipX, tipY) with extra width near the base. Three colors:
 * `darkColor` at the root, `midColor` along the blade, `lightColor` at the
 * very tip — produces the "darker base / lighter tip" depth cue the issue
 * called out for ant-scale grass.
 */
export function paintGrassBlade(
  canvas: number[],
  width: number,
  baseX: number,
  baseY: number,
  tipX: number,
  tipY: number,
  darkColor: number,
  midColor: number,
  lightColor: number,
): void {
  const len = Math.max(1, baseY - tipY);  // blade goes upward (baseY > tipY)
  for (let i = 0; i <= len; i++) {
    const t = i / len;  // 0 at base, 1 at tip
    const x = Math.round(baseX + (tipX - baseX) * t);
    const y = baseY - i;
    // Color: dark for lower 25%, mid for middle 50%, light for upper 25%.
    const c = t < 0.25 ? darkColor : t < 0.75 ? midColor : lightColor;
    paintPx(canvas, width, x, y, c);
    // Widen near the root: paint adjacent pixels for the lower 30%.
    if (t < 0.3) {
      paintPx(canvas, width, x - 1, y, darkColor);
    }
  }
}

/**
 * Stamp a deterministic pseudo-random fleck pattern (used for boulder lichen,
 * leaf veins, bark texture etc.). Uses a small linear-congruential generator
 * seeded by `seed` so each invocation produces a stable layout — render
 * runs at module load with the same seed every time, so the pattern is
 * fixed per sprite.
 */
export function paintFlecks(
  canvas: number[],
  width: number,
  count: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number,
  seed: number,
): void {
  if (color === 0) return;
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = x0 + (s % Math.max(1, x1 - x0 + 1));
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const y = y0 + (s % Math.max(1, y1 - y0 + 1));
    paintPx(canvas, width, x, y, color);
  }
}
