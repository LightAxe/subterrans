// terrain-texture.ts — render-only pixel texture helpers for 16px terrain tiles.
//
// These helpers intentionally derive all variation from tile coordinates. The
// patterns are stable while panning, require no assets, and never influence
// simulation state.

import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX } from './sprites.js';
import {
  COLOR_SURFACE_GRASS_DARK,
  COLOR_SURFACE_DIRT_DARK,
  COLOR_SURFACE_DIRT_LIGHT,
  COLOR_UNDERGROUND_SOLID_ROCK,
  COLOR_UNDERGROUND_OPEN_DUST,
} from './sprites.js';

const SALT_GRASS = 1;
const SALT_SURFACE_DIRT_DARK = 11;
const SALT_SURFACE_DIRT_LIGHT = 12;
const SALT_UNDERGROUND_SOLID_ROCK = 21;
const SALT_UNDERGROUND_SOLID_STRATA = 22;
const SALT_UNDERGROUND_OPEN_DUST = 31;
const SALT_UNDERGROUND_OPEN_DUST_BONUS = 32;

/**
 * Deterministic coordinate hash for render texture placement: no PRNG, no
 * Math.random, reproducible per tile. The large odd constants are spatial-hash
 * mixers; 1274126177 is the MurmurHash3 fmix multiplier.
 */
function terrainHash(tileX: number, tileY: number, salt: number): number {
  let h = (tileX * 374761393 + tileY * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function detailCoord(hash: number, shift: number): number {
  return (hash >>> shift) & (TILE_SIZE_PX - 1);
}

function detailCoordWithWidth(hash: number, shift: number, width: number): number {
  // Tiny modulo bias is visually irrelevant; the only contract is in-tile fit.
  return detailCoord(hash, shift) % (TILE_SIZE_PX - width + 1);
}

/** Draw grass blades and a small highlight pixel over a grass base tile. */
export function drawGrassTexture(gfx: GfxLike, screenX: number, screenY: number, tileX: number, tileY: number): void {
  const h0 = terrainHash(tileX, tileY, SALT_GRASS);

  const bladeAX = screenX + detailCoord(h0, 0);
  const bladeAY = screenY + 4 + (detailCoord(h0, 4) >> 1);
  gfx.fillStyle(COLOR_SURFACE_GRASS_DARK, 0.55);
  gfx.fillRect(bladeAX, bladeAY, 1, 3);

  const bladeBX = screenX + detailCoordWithWidth(h0, 8, 2);
  const bladeBY = screenY + 2 + (detailCoord(h0, 12) >> 1);
  gfx.fillRect(bladeBX, bladeBY, 2, 1);
}

/** Draw small pebbles/soil flecks over a surface dirt base tile. */
export function drawSurfaceDirtTexture(gfx: GfxLike, screenX: number, screenY: number, tileX: number, tileY: number): void {
  const h0 = terrainHash(tileX, tileY, SALT_SURFACE_DIRT_DARK);
  const h1 = terrainHash(tileX, tileY, SALT_SURFACE_DIRT_LIGHT);

  gfx.fillStyle(COLOR_SURFACE_DIRT_DARK, 0.55);
  gfx.fillRect(screenX + detailCoordWithWidth(h0, 0, 2), screenY + detailCoord(h0, 4), 2, 1);
  gfx.fillRect(screenX + detailCoord(h0, 8), screenY + detailCoordWithWidth(h0, 12, 2), 1, 2);

  gfx.fillStyle(COLOR_SURFACE_DIRT_LIGHT, 0.4);
  gfx.fillRect(screenX + detailCoord(h1, 0), screenY + detailCoord(h1, 4), 1, 1);
}

/** Draw rock flecks and short strata marks over unexcavated underground dirt. */
export function drawUndergroundSolidTexture(gfx: GfxLike, screenX: number, screenY: number, tileX: number, tileY: number): void {
  const h0 = terrainHash(tileX, tileY, SALT_UNDERGROUND_SOLID_ROCK);
  const h1 = terrainHash(tileX, tileY, SALT_UNDERGROUND_SOLID_STRATA);

  gfx.fillStyle(COLOR_UNDERGROUND_SOLID_ROCK, 0.5);
  gfx.fillRect(screenX + detailCoordWithWidth(h0, 0, 2), screenY + detailCoord(h0, 4), 2, 1);
  gfx.fillRect(screenX + detailCoord(h0, 8), screenY + detailCoord(h0, 12), 1, 1);

  if ((h1 & 3) === 0) {
    gfx.fillRect(screenX + detailCoordWithWidth(h1, 4, 4), screenY + detailCoord(h1, 8), 4, 1);
  }
}

/** Draw sparse dust pixels over excavated/open underground floor tiles. */
export function drawUndergroundOpenTexture(gfx: GfxLike, screenX: number, screenY: number, tileX: number, tileY: number): void {
  const h0 = terrainHash(tileX, tileY, SALT_UNDERGROUND_OPEN_DUST);
  const h1 = terrainHash(tileX, tileY, SALT_UNDERGROUND_OPEN_DUST_BONUS);

  gfx.fillStyle(COLOR_UNDERGROUND_OPEN_DUST, 0.45);
  gfx.fillRect(screenX + detailCoord(h0, 0), screenY + detailCoord(h0, 4), 1, 1);
  if ((h1 & 1) === 0) {
    gfx.fillRect(screenX + detailCoordWithWidth(h1, 8, 2), screenY + detailCoord(h1, 12), 2, 1);
  }
}
