// camera.test.ts — Vitest tests for src/render/camera.ts
//
// Tests cover:
//   - createViewState: correct initial positions, independence of camera objects
//   - toggleView (VIEW-02, §7c): X-sync, first-visit Y-center, surface Y preservation, repeat-visit
//   - clampCamera: minimum/maximum clamp on both axes, degenerate guard
//   - screenToTile: center-canvas round-trip, top-left corner, tile round-trip

import { describe, it, expect } from 'vitest';
import {
  VIEWPORT_WIDTH_TILES,
  VIEWPORT_HEIGHT_TILES,
  UNDERGROUND_INITIAL_CAMERA_Y,
  createViewState,
  resetViewState,
  toggleView,
  toggleUndergroundColony,
  clampCamera,
  screenToTile,
} from './camera.js';
import { TILE_SIZE_PX } from './sprites.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';

// Convenience: default viewport camera
function makeCamera(x: number, y: number) {
  return {
    x,
    y,
    viewportWidth: VIEWPORT_WIDTH_TILES,
    viewportHeight: VIEWPORT_HEIGHT_TILES,
  };
}

// ---------------------------------------------------------------------------
// createViewState
// ---------------------------------------------------------------------------

describe('createViewState', () => {
  it('surfaceCamera starts at (startTileX, startTileY)', () => {
    const vs = createViewState(24, 64);
    expect(vs.surfaceCamera.x).toBe(24);
    expect(vs.surfaceCamera.y).toBe(64);
  });

  it('undergroundCamera starts at (startTileX, UNDERGROUND_INITIAL_CAMERA_Y) — starter shaft near top', () => {
    // UNDERGROUND_INITIAL_CAMERA_Y = VIEWPORT_HEIGHT_TILES / 2 = 18.5 (the clamp
    // minimum Y), which places underground tile row 0 at the very top of the
    // viewport. The starter entrance / shaft row is visible on first view,
    // giving the player an immediate surface→underground connection.
    const vs = createViewState(24, 64);
    expect(vs.undergroundCamera.x).toBe(24);
    expect(vs.undergroundCamera.y).toBe(UNDERGROUND_INITIAL_CAMERA_Y);
    expect(UNDERGROUND_INITIAL_CAMERA_Y).toBe(VIEWPORT_HEIGHT_TILES / 2);
  });

  it('undergroundVisited is false initially', () => {
    const vs = createViewState(24, 64);
    expect(vs.undergroundVisited).toBe(false);
  });

  it('activeView is "surface" initially', () => {
    const vs = createViewState(24, 64);
    expect(vs.activeView).toBe('surface');
  });

  it('surfaceCamera and undergroundCamera are distinct object references', () => {
    const vs = createViewState(24, 64);
    expect(vs.surfaceCamera).not.toBe(vs.undergroundCamera);
  });

  it('cameras have correct viewport dimensions', () => {
    const vs = createViewState(10, 20);
    expect(vs.surfaceCamera.viewportWidth).toBe(VIEWPORT_WIDTH_TILES);
    expect(vs.surfaceCamera.viewportHeight).toBe(VIEWPORT_HEIGHT_TILES);
    expect(vs.undergroundCamera.viewportWidth).toBe(VIEWPORT_WIDTH_TILES);
    expect(vs.undergroundCamera.viewportHeight).toBe(VIEWPORT_HEIGHT_TILES);
  });

  it('issue #114 — showPheromoneOverlay defaults to true (matches DEFAULT_SETTINGS)', () => {
    // jsdom has localStorage available but the suite clears between tests,
    // so loadSettings falls back to DEFAULT_SETTINGS.pheromoneOverlay = true.
    localStorage.removeItem('subterrans:settings:v1');
    const vs = createViewState(10, 20);
    expect(vs.showPheromoneOverlay).toBe(true);
  });

  it('issue #114 — showPheromoneOverlay hydrates from persisted settings', () => {
    localStorage.setItem(
      'subterrans:settings:v1',
      JSON.stringify({ version: 1, settings: { pheromoneOverlay: false } }),
    );
    const vs = createViewState(10, 20);
    expect(vs.showPheromoneOverlay).toBe(false);
    localStorage.removeItem('subterrans:settings:v1');
  });
});

// ---------------------------------------------------------------------------
// resetViewState — Phase 9 session reset
// ---------------------------------------------------------------------------

describe('resetViewState', () => {
  it('restores activeView to "surface" regardless of prior view', () => {
    const vs = createViewState(10, 10);
    vs.activeView = 'underground';
    resetViewState(vs, 24, 64);
    expect(vs.activeView).toBe('surface');
  });

  it('rebinds surfaceCamera center to the given start tile', () => {
    const vs = createViewState(10, 10);
    vs.surfaceCamera.x = 999;
    vs.surfaceCamera.y = 999;
    resetViewState(vs, 24, 64);
    expect(vs.surfaceCamera.x).toBe(24);
    expect(vs.surfaceCamera.y).toBe(64);
  });

  it('rebinds undergroundCamera to (start, UNDERGROUND_INITIAL_CAMERA_Y) — starter shaft near top', () => {
    const vs = createViewState(10, 10);
    vs.undergroundCamera.x = 999;
    vs.undergroundCamera.y = 999;
    resetViewState(vs, 24, 64);
    expect(vs.undergroundCamera.x).toBe(24);
    expect(vs.undergroundCamera.y).toBe(UNDERGROUND_INITIAL_CAMERA_Y);
  });

  it('clears undergroundVisited so the next toggle re-anchors the shaft near the top', () => {
    const vs = createViewState(24, 64);
    toggleView(vs); // → underground, visited=true
    toggleView(vs); // → surface
    expect(vs.undergroundVisited).toBe(true);
    resetViewState(vs, 24, 64);
    expect(vs.undergroundVisited).toBe(false);
    // Next underground toggle should restore the first-visit top anchor.
    vs.undergroundCamera.y = 5;
    toggleView(vs);
    expect(vs.undergroundCamera.y).toBe(UNDERGROUND_INITIAL_CAMERA_Y);
  });

  it('preserves the ViewState object identity (mutates in place)', () => {
    // Critical invariant: UIScene + input handlers capture this reference in
    // create(). A reassigned object would strand those references on the old.
    const vs = createViewState(10, 10);
    const surfaceCamRef = vs.surfaceCamera;
    const undergroundCamRef = vs.undergroundCamera;
    resetViewState(vs, 24, 64);
    expect(vs.surfaceCamera).toBe(surfaceCamRef);
    expect(vs.undergroundCamera).toBe(undergroundCamRef);
  });

  it('restores viewport dimensions to canonical defaults', () => {
    const vs = createViewState(10, 10);
    vs.surfaceCamera.viewportWidth = 99;
    vs.surfaceCamera.viewportHeight = 99;
    vs.undergroundCamera.viewportWidth = 99;
    vs.undergroundCamera.viewportHeight = 99;
    resetViewState(vs, 24, 64);
    expect(vs.surfaceCamera.viewportWidth).toBe(VIEWPORT_WIDTH_TILES);
    expect(vs.surfaceCamera.viewportHeight).toBe(VIEWPORT_HEIGHT_TILES);
    expect(vs.undergroundCamera.viewportWidth).toBe(VIEWPORT_WIDTH_TILES);
    expect(vs.undergroundCamera.viewportHeight).toBe(VIEWPORT_HEIGHT_TILES);
  });

  it('issue #114 — re-reads pheromoneOverlay setting from localStorage on reset', () => {
    // Settings are cosmetic preferences, not session state — a restart should
    // honor the player's current toggle, not snap back to the boot-time value.
    const vs = createViewState(10, 10);
    expect(vs.showPheromoneOverlay).toBe(true);
    localStorage.setItem(
      'subterrans:settings:v1',
      JSON.stringify({ version: 1, settings: { pheromoneOverlay: false } }),
    );
    resetViewState(vs, 24, 64);
    expect(vs.showPheromoneOverlay).toBe(false);
    localStorage.removeItem('subterrans:settings:v1');
  });

  it('restart simulation: mid-game underground pan does not leak into fresh session', () => {
    const vs = createViewState(24, 64);
    toggleView(vs); // underground
    vs.undergroundCamera.x = 100;
    vs.undergroundCamera.y = 40;
    vs.surfaceCamera.x = 80;
    resetViewState(vs, 24, 64);
    expect(vs.activeView).toBe('surface');
    expect(vs.surfaceCamera.x).toBe(24);
    expect(vs.surfaceCamera.y).toBe(64);
    expect(vs.undergroundCamera.x).toBe(24);
    expect(vs.undergroundCamera.y).toBe(UNDERGROUND_INITIAL_CAMERA_Y);
    expect(vs.undergroundVisited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleView — VIEW-02, §7c
// ---------------------------------------------------------------------------

describe('toggleView', () => {
  describe('first toggle: surface → underground (first visit)', () => {
    it('undergroundCamera.x becomes surfaceCamera.x', () => {
      const vs = createViewState(24, 64);
      vs.surfaceCamera.x = 50; // change surface X to test sync
      toggleView(vs);
      expect(vs.undergroundCamera.x).toBe(50);
    });

    it('undergroundCamera.y is anchored at UNDERGROUND_INITIAL_CAMERA_Y (starter shaft near top) on first visit', () => {
      const vs = createViewState(24, 64);
      vs.undergroundCamera.y = 99; // override a prior value to verify the first-visit anchor wins
      toggleView(vs);
      expect(vs.undergroundCamera.y).toBe(UNDERGROUND_INITIAL_CAMERA_Y);
    });

    it('undergroundVisited becomes true', () => {
      const vs = createViewState(24, 64);
      toggleView(vs);
      expect(vs.undergroundVisited).toBe(true);
    });

    it('activeView becomes "underground"', () => {
      const vs = createViewState(24, 64);
      toggleView(vs);
      expect(vs.activeView).toBe('underground');
    });
  });

  describe('second toggle: underground → surface (VIEW-03: surface Y preserved)', () => {
    it('surfaceCamera.x becomes undergroundCamera.x', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // → underground
      vs.undergroundCamera.x = 77;
      toggleView(vs); // → surface
      expect(vs.surfaceCamera.x).toBe(77);
    });

    it('activeView becomes "surface"', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // → underground
      toggleView(vs); // → surface
      expect(vs.activeView).toBe('surface');
    });

    it('surfaceCamera.y is NOT changed (VIEW-03: surface Y preserved across toggles)', () => {
      const vs = createViewState(24, 64);
      const originalSurfaceY = vs.surfaceCamera.y;
      toggleView(vs); // → underground
      toggleView(vs); // → surface
      expect(vs.surfaceCamera.y).toBe(originalSurfaceY);
    });
  });

  describe('third toggle: surface → underground (already visited)', () => {
    it('undergroundCamera.y is NOT re-anchored (preserves user-panned underground.y)', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // first visit → y set to UNDERGROUND_INITIAL_CAMERA_Y, visited=true
      vs.undergroundCamera.y = 55; // simulate a user pan after first visit
      toggleView(vs); // → surface
      toggleView(vs); // second visit → must preserve 55, NOT snap back to the top anchor
      expect(vs.undergroundCamera.y).toBe(55);
    });

    it('undergroundCamera.x still syncs from surfaceCamera.x on repeated toggle', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // → underground (first visit)
      toggleView(vs); // → surface
      vs.surfaceCamera.x = 88;
      toggleView(vs); // → underground (second visit)
      expect(vs.undergroundCamera.x).toBe(88);
    });
  });
});

// ---------------------------------------------------------------------------
// clampCamera
// ---------------------------------------------------------------------------

describe('clampCamera', () => {
  it('clamps camera too far left/up to half-viewport boundary', () => {
    const cam = makeCamera(0, 0);
    clampCamera(cam, 128, 128);
    // half-viewport: 50/2 = 25, 37/2 = 18.5
    expect(cam.x).toBe(VIEWPORT_WIDTH_TILES / 2);   // 25
    expect(cam.y).toBe(VIEWPORT_HEIGHT_TILES / 2);  // 18.5
  });

  it('clamps camera too far right/down to worldSize - half-viewport boundary', () => {
    const cam = makeCamera(200, 200);
    clampCamera(cam, 128, 128);
    // max: 128 - 25 = 103, 128 - 18.5 = 109.5
    expect(cam.x).toBe(128 - VIEWPORT_WIDTH_TILES / 2);   // 103
    expect(cam.y).toBe(128 - VIEWPORT_HEIGHT_TILES / 2);  // 109.5
  });

  it('leaves camera unchanged when within valid bounds', () => {
    const cam = makeCamera(64, 64);
    clampCamera(cam, 128, 128);
    expect(cam.x).toBe(64);
    expect(cam.y).toBe(64);
  });

  it('handles degenerate case where worldW < viewportWidth (centers X)', () => {
    const cam = makeCamera(0, 32);
    clampCamera(cam, 10, 128); // world width 10 < viewport 50
    expect(cam.x).toBe(10 / 2); // 5 = worldW/2
  });

  it('handles degenerate case where worldH < viewportHeight (centers Y)', () => {
    const cam = makeCamera(64, 0);
    clampCamera(cam, 128, 10); // world height 10 < viewport 37
    expect(cam.y).toBe(10 / 2); // 5 = worldH/2
  });
});

// ---------------------------------------------------------------------------
// screenToTile
// ---------------------------------------------------------------------------

describe('screenToTile', () => {
  it('pointer at canvas center (400, 296) with camera at world center (64, 64) returns the tile the renderer drew there', () => {
    // Camera center at tile (64, 64), viewport 50×37.
    //   Horizontal: cam.x=64, vw/2=25 (integer) → left = 64-25 = 39
    //     tileX = floor(400/16) + 39 = 25 + 39 = 64
    //   Vertical:   cam.y=64, vh/2=18.5 (fractional) → top = floor(45.5) = 45
    //     tileY = floor(296/16) + 45 = 18 + 45 = 63
    // The odd viewport height means the renderer draws tile 63 at screen
    // y=288..303, so a click at y=296 hits tile 63 — not 64.
    const cam = makeCamera(64, 64);
    const result = screenToTile(400, 296, cam);
    expect(result.tileX).toBe(64);
    expect(result.tileY).toBe(63);
  });

  it('pointer at (0, 0) with camera clamped to minimum (25, 18.5) returns tile (0, 0)', () => {
    // Camera center at (25, 18.5) = half-viewport clamp
    // cameraPixelX = (25 - 25) * 16 = 0
    // tileX = Math.floor((0 + 0) / 16) = 0
    // cameraPixelY = (18.5 - 18.5) * 16 = 0
    // tileY = Math.floor((0 + 0) / 16) = 0
    const cam = makeCamera(VIEWPORT_WIDTH_TILES / 2, VIEWPORT_HEIGHT_TILES / 2);
    const result = screenToTile(0, 0, cam);
    expect(result.tileX).toBe(0);
    expect(result.tileY).toBe(0);
  });

  it('round-trip: tile pixel coordinates through screenToTile return same tile', () => {
    // For tile (tx, ty), the top-left pixel the renderer draws it at is:
    //   screenX = (tx - camLeft) * TILE_SIZE_PX
    // where camLeft = Math.floor(cam.x - cam.viewportWidth/2) — the
    // integer-tile snap the renderer applies. screenToTile mirrors that
    // floor, so any pixel inside the drawn tile must round-trip to (tx, ty).
    const cam = makeCamera(64, 64);
    const camLeft = Math.floor(cam.x - cam.viewportWidth / 2);
    const camTop = Math.floor(cam.y - cam.viewportHeight / 2);

    // Test a specific tile inside the viewport: tile (70, 70)
    const tx = 70;
    const ty = 70;
    const screenX = (tx - camLeft) * TILE_SIZE_PX;
    const screenY = (ty - camTop) * TILE_SIZE_PX;
    const result = screenToTile(screenX, screenY, cam);
    expect(result.tileX).toBe(tx);
    expect(result.tileY).toBe(ty);
  });

  it('fractional camera: clicks anywhere in a rendered tile resolve to that tile', () => {
    // Regression: drag-pan and the 0.5-tile keyboard scroll leave cam.x
    // fractional. The renderer snaps its tile offset with Math.floor(cam.x -
    // viewportWidth/2), so visible tiles are integer-aligned. If screenToTile
    // used the raw fractional camera instead, the tile it reports drifts up
    // to a full tile away from what the player sees — which is why food-pile
    // clicks only worked near the center of the drawn mark.
    const cam = makeCamera(64.3, 64.7); // mid-pan / mid-scroll
    const left = Math.floor(cam.x - cam.viewportWidth / 2); // renderer's floor
    const top = Math.floor(cam.y - cam.viewportHeight / 2);

    // Tile (70, 70) is drawn spanning screen px [(70-left)*16, (70-left+1)*16)
    // horizontally — every click inside that span must resolve to tileX=70.
    const tx = 70;
    const ty = 70;
    const tileLeftPx = (tx - left) * TILE_SIZE_PX;
    const tileTopPx = (ty - top) * TILE_SIZE_PX;

    // Four corners + center of the drawn tile all map to (70, 70)
    for (const [dx, dy] of [[0, 0], [15, 0], [0, 15], [15, 15], [8, 8]]) {
      const r = screenToTile(tileLeftPx + dx!, tileTopPx + dy!, cam);
      expect(r.tileX).toBe(tx);
      expect(r.tileY).toBe(ty);
    }
  });
});

// ---------------------------------------------------------------------------
// toggleUndergroundColony — Phase 09.1 Chunk 2 (enemy underground view)
// ---------------------------------------------------------------------------
//
// Binary toggle that flips ViewState.activeUndergroundColonyId between
// PLAYER_COLONY_ID and ENEMY_COLONY_ID so the player can inspect the enemy
// nest before invasion (09.1 CONTEXT §Chunk 2). Mutates in place — same
// in-place contract as toggleView and resetViewState so UIScene and input
// handlers that hold a captured ViewState reference keep seeing the update.
// The reducer is pure with respect to the toggle itself; the caller (the X
// keybind handler in GameScene) is responsible for gating the dispatch on
// activeView==='underground' so the surface view never flips colony id.

describe('toggleUndergroundColony', () => {
  it('initial createViewState sets activeUndergroundColonyId to PLAYER_COLONY_ID', () => {
    // Fresh boot must start looking at the player's own underground — there
    // is no session where we want the first underground Tab to surface the
    // enemy grid. This also makes the `Your Colony` HUD label the default.
    const vs = createViewState(24, 64);
    expect(vs.activeUndergroundColonyId).toBe(PLAYER_COLONY_ID);
  });

  it('flips PLAYER_COLONY_ID → ENEMY_COLONY_ID on first call', () => {
    const vs = createViewState(24, 64);
    toggleUndergroundColony(vs);
    expect(vs.activeUndergroundColonyId).toBe(ENEMY_COLONY_ID);
  });

  it('flips ENEMY_COLONY_ID → PLAYER_COLONY_ID on second call (idempotence)', () => {
    const vs = createViewState(24, 64);
    toggleUndergroundColony(vs); // → ENEMY
    toggleUndergroundColony(vs); // → PLAYER
    expect(vs.activeUndergroundColonyId).toBe(PLAYER_COLONY_ID);
  });

  it('double-toggle returns to the starting value (no drift)', () => {
    const vs = createViewState(24, 64);
    const start = vs.activeUndergroundColonyId;
    toggleUndergroundColony(vs);
    toggleUndergroundColony(vs);
    expect(vs.activeUndergroundColonyId).toBe(start);
  });

  it('leaves activeView unchanged (reducer is pure w.r.t. other fields)', () => {
    // Gating on activeView is the caller's responsibility. The reducer only
    // touches activeUndergroundColonyId so a stray dispatch cannot silently
    // flip the player out of the surface view.
    const vs = createViewState(24, 64);
    expect(vs.activeView).toBe('surface');
    toggleUndergroundColony(vs);
    expect(vs.activeView).toBe('surface');
  });

  it('leaves surfaceCamera and undergroundCamera positions unchanged', () => {
    const vs = createViewState(24, 64);
    const sx = vs.surfaceCamera.x;
    const sy = vs.surfaceCamera.y;
    const ux = vs.undergroundCamera.x;
    const uy = vs.undergroundCamera.y;
    toggleUndergroundColony(vs);
    expect(vs.surfaceCamera.x).toBe(sx);
    expect(vs.surfaceCamera.y).toBe(sy);
    expect(vs.undergroundCamera.x).toBe(ux);
    expect(vs.undergroundCamera.y).toBe(uy);
  });

  it('leaves undergroundVisited flag unchanged', () => {
    const vs = createViewState(24, 64);
    toggleView(vs); // → underground, visited=true
    toggleView(vs); // → surface
    expect(vs.undergroundVisited).toBe(true);
    toggleUndergroundColony(vs);
    expect(vs.undergroundVisited).toBe(true);
  });

  it('mutates the ViewState in place — preserves object identity for captured refs', () => {
    // UIScene and input handlers capture a reference to the ViewState in
    // create(). Reassigning a fresh object would strand those references
    // (same failure class as the stale-world bug documented in camera.ts).
    const vs = createViewState(24, 64);
    const surfaceCamRef = vs.surfaceCamera;
    const undergroundCamRef = vs.undergroundCamera;
    toggleUndergroundColony(vs);
    expect(vs.surfaceCamera).toBe(surfaceCamRef);
    expect(vs.undergroundCamera).toBe(undergroundCamRef);
  });

  it('resetViewState restores activeUndergroundColonyId to PLAYER_COLONY_ID', () => {
    // Session reset must clear the enemy-view state — a fresh game starts
    // with `Your Colony` regardless of what the prior session was viewing.
    const vs = createViewState(24, 64);
    toggleUndergroundColony(vs);
    expect(vs.activeUndergroundColonyId).toBe(ENEMY_COLONY_ID);
    resetViewState(vs, 24, 64);
    expect(vs.activeUndergroundColonyId).toBe(PLAYER_COLONY_ID);
  });
});
