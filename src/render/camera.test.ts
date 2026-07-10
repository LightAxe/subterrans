// camera.test.ts — Vitest tests for src/render/camera.ts (Stage 2 world-px model).
//
// Tests cover the two-view lifecycle on the new world-pixel CameraView model:
//   - createViewState / resetViewState: world-px centers, default zoom, in-place reset
//   - toggleView: X-link (world px), first-underground-visit centering, surface-Y/underground-Y
//     preservation, and the atomic-toggle §A5 behavior (per-view ZOOM save/restore,
//     in-flight zoom-lerp cancelled, clamp at the restored zoom)
//   - toggleUndergroundColony: binary colony flip
//
// The pure projection / clamp / screen↔tile math (formerly clampCamera/screenToTile here)
// now lives in camera-adapter.ts and is covered by camera-adapter.test.ts.

import { describe, it, expect } from 'vitest';
import {
  UNDERGROUND_WORLD_PX_H,
  createViewState,
  resetViewState,
  toggleView,
  toggleUndergroundColony,
} from './camera.js';
import { DEFAULT_ZOOM, viewWorldHeight, initialUndergroundCenterYPx } from './camera-adapter.js';
import { TILE_SIZE_PX, CANVAS_H } from './sprites.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';

// Center (world px) of a tile — mirrors camera.ts's framing of the start tile.
const tileCenterPx = (tile: number): number => (tile + 0.5) * TILE_SIZE_PX;

// ---------------------------------------------------------------------------
// createViewState
// ---------------------------------------------------------------------------

describe('createViewState', () => {
  it('surfaceCamera is centered (world px) on the start tile at default zoom', () => {
    const vs = createViewState(24, 64);
    expect(vs.surfaceCamera.centerX).toBe(tileCenterPx(24)); // 392
    expect(vs.surfaceCamera.centerY).toBe(tileCenterPx(64)); // 1032
    expect(vs.surfaceCamera.zoom).toBe(DEFAULT_ZOOM);
    expect(vs.surfaceCamera.targetZoom).toBe(DEFAULT_ZOOM);
  });

  it('undergroundCamera starts X-aligned with the start tile and Y at the shaft-top anchor', () => {
    // initialUndergroundCenterYPx() = viewportH/2 (= CANVAS_H/2 at the fixed viewport)
    // places world y=0 (the ceiling / surface-entrance row) at the very top at zoom 1.
    const vs = createViewState(24, 64);
    expect(vs.undergroundCamera.centerX).toBe(tileCenterPx(24));
    expect(vs.undergroundCamera.centerY).toBe(initialUndergroundCenterYPx());
    expect(initialUndergroundCenterYPx()).toBe(CANVAS_H / 2); // 296
    expect(vs.undergroundCamera.zoom).toBe(DEFAULT_ZOOM);
  });

  it('undergroundVisited is false initially', () => {
    expect(createViewState(24, 64).undergroundVisited).toBe(false);
  });

  it('activeView is "surface" initially', () => {
    expect(createViewState(24, 64).activeView).toBe('surface');
  });

  it('surfaceCamera and undergroundCamera are distinct object references', () => {
    const vs = createViewState(24, 64);
    expect(vs.surfaceCamera).not.toBe(vs.undergroundCamera);
  });

  it('issue #114 — showPheromoneOverlay defaults to true (matches DEFAULT_SETTINGS)', () => {
    localStorage.removeItem('subterrans:settings:v1');
    expect(createViewState(10, 20).showPheromoneOverlay).toBe(true);
  });

  it('issue #114 — showPheromoneOverlay hydrates from persisted settings', () => {
    localStorage.setItem(
      'subterrans:settings:v1',
      JSON.stringify({ version: 1, settings: { pheromoneOverlay: false } }),
    );
    expect(createViewState(10, 20).showPheromoneOverlay).toBe(false);
    localStorage.removeItem('subterrans:settings:v1');
  });
});

// ---------------------------------------------------------------------------
// resetViewState — session reset (in place)
// ---------------------------------------------------------------------------

describe('resetViewState', () => {
  it('restores activeView to "surface" regardless of prior view', () => {
    const vs = createViewState(10, 10);
    vs.activeView = 'underground';
    resetViewState(vs, 24, 64);
    expect(vs.activeView).toBe('surface');
  });

  it('rebinds the surface camera center (world px) to the given start tile and resets zoom', () => {
    const vs = createViewState(10, 10);
    vs.surfaceCamera.centerX = 999;
    vs.surfaceCamera.centerY = 999;
    vs.surfaceCamera.zoom = 1.7;
    vs.surfaceCamera.targetZoom = 1.7;
    resetViewState(vs, 24, 64);
    expect(vs.surfaceCamera.centerX).toBe(tileCenterPx(24));
    expect(vs.surfaceCamera.centerY).toBe(tileCenterPx(64));
    expect(vs.surfaceCamera.zoom).toBe(DEFAULT_ZOOM);
    expect(vs.surfaceCamera.targetZoom).toBe(DEFAULT_ZOOM);
  });

  it('rebinds the underground camera to (start-X, shaft-top anchor) at default zoom', () => {
    const vs = createViewState(10, 10);
    vs.undergroundCamera.centerX = 999;
    vs.undergroundCamera.centerY = 999;
    vs.undergroundCamera.zoom = 0.4;
    resetViewState(vs, 24, 64);
    expect(vs.undergroundCamera.centerX).toBe(tileCenterPx(24));
    expect(vs.undergroundCamera.centerY).toBe(initialUndergroundCenterYPx());
    expect(vs.undergroundCamera.zoom).toBe(DEFAULT_ZOOM);
  });

  it('clears undergroundVisited so the next toggle re-anchors the shaft near the top', () => {
    const vs = createViewState(24, 64);
    toggleView(vs); // → underground, visited=true
    toggleView(vs); // → surface
    expect(vs.undergroundVisited).toBe(true);
    resetViewState(vs, 24, 64);
    expect(vs.undergroundVisited).toBe(false);
    vs.undergroundCamera.centerY = 5;
    toggleView(vs);
    expect(vs.undergroundCamera.centerY).toBe(initialUndergroundCenterYPx());
  });

  it('preserves the ViewState + camera object identities (mutates in place)', () => {
    const vs = createViewState(10, 10);
    const surfaceCamRef = vs.surfaceCamera;
    const undergroundCamRef = vs.undergroundCamera;
    resetViewState(vs, 24, 64);
    expect(vs.surfaceCamera).toBe(surfaceCamRef);
    expect(vs.undergroundCamera).toBe(undergroundCamRef);
  });

  it('issue #114 — re-reads pheromoneOverlay setting from localStorage on reset', () => {
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
});

// ---------------------------------------------------------------------------
// toggleView — atomic toggle (PLAN-stage2 §A5)
// ---------------------------------------------------------------------------

describe('toggleView', () => {
  describe('surface → underground (first visit)', () => {
    it('X-links the underground center to the surface center (world px)', () => {
      const vs = createViewState(24, 64);
      vs.surfaceCamera.centerX = 800; // in-bounds world px
      toggleView(vs);
      expect(vs.undergroundCamera.centerX).toBe(800);
    });

    it('anchors underground centerY at the shaft-top on first visit (overriding any prior value)', () => {
      const vs = createViewState(24, 64);
      vs.undergroundCamera.centerY = 900; // a stale value the first-visit anchor must win over
      toggleView(vs);
      expect(vs.undergroundCamera.centerY).toBe(initialUndergroundCenterYPx());
    });

    it('marks undergroundVisited and sets activeView=underground', () => {
      const vs = createViewState(24, 64);
      toggleView(vs);
      expect(vs.undergroundVisited).toBe(true);
      expect(vs.activeView).toBe('underground');
    });
  });

  describe('underground → surface (surface Y preserved)', () => {
    it('X-links the surface center to the underground center (world px)', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // → underground
      vs.undergroundCamera.centerX = 700;
      toggleView(vs); // → surface
      expect(vs.surfaceCamera.centerX).toBe(700);
    });

    it('does NOT change surface centerY across the round trip', () => {
      const vs = createViewState(24, 64);
      vs.surfaceCamera.centerY = 1000; // in-bounds
      const before = vs.surfaceCamera.centerY;
      toggleView(vs); // → underground
      toggleView(vs); // → surface
      expect(vs.surfaceCamera.centerY).toBe(before);
    });
  });

  describe('surface → underground (already visited)', () => {
    it('preserves the user-panned underground centerY (no re-anchor)', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // first visit
      vs.undergroundCamera.centerY = 600; // in-bounds user pan (1024-tall world, half-view 296 → [296,728])
      toggleView(vs); // → surface
      toggleView(vs); // → underground (2nd visit): keep 600
      expect(vs.undergroundCamera.centerY).toBe(600);
    });

    it('still X-links underground centerX from surface on repeat toggle', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // → underground (first visit)
      toggleView(vs); // → surface
      vs.surfaceCamera.centerX = 900;
      toggleView(vs); // → underground (2nd visit)
      expect(vs.undergroundCamera.centerX).toBe(900);
    });
  });

  describe('atomic-toggle behavior (§A5)', () => {
    it('PER-VIEW ZOOM is saved and restored across toggles', () => {
      const vs = createViewState(64, 64);
      vs.surfaceCamera.zoom = 1.5;
      vs.surfaceCamera.targetZoom = 1.5;
      vs.undergroundCamera.zoom = 0.5;
      vs.undergroundCamera.targetZoom = 0.5;

      toggleView(vs); // → underground; each view keeps its own zoom
      expect(vs.undergroundCamera.zoom).toBe(0.5);
      expect(vs.surfaceCamera.zoom).toBe(1.5); // leaving view's zoom snapshotted

      toggleView(vs); // → surface; surface zoom still 1.5
      expect(vs.surfaceCamera.zoom).toBe(1.5);
      expect(vs.undergroundCamera.zoom).toBe(0.5);
    });

    it('cancels an in-flight zoom-lerp on both the leaving and entering views', () => {
      const vs = createViewState(64, 64);
      vs.surfaceCamera.targetZoom = 1.8; // surface mid-lerp (zoom 1 → 1.8)
      vs.undergroundCamera.targetZoom = 0.3; // underground had a pending lerp too
      toggleView(vs); // leaving surface, entering underground
      expect(vs.surfaceCamera.targetZoom).toBe(vs.surfaceCamera.zoom); // leaving cancelled
      expect(vs.undergroundCamera.targetZoom).toBe(vs.undergroundCamera.zoom); // entering settled
    });

    it('clamps the entering view at its restored zoom (out-of-bounds center pulled in)', () => {
      const vs = createViewState(24, 64);
      toggleView(vs); // first visit underground (zoom 1)
      vs.undergroundCamera.centerY = 99999; // force out of bounds
      toggleView(vs); // → surface
      toggleView(vs); // → underground (2nd visit) → settle clamps
      // zoom 1, underground world 1024 tall, half-view = viewWorldHeight(1)/2 = 296 → max 728.
      const maxCenterY = UNDERGROUND_WORLD_PX_H - viewWorldHeight(1) / 2;
      expect(vs.undergroundCamera.centerY).toBeCloseTo(maxCenterY, 6); // 728
    });
  });

  it('resets the active tool to the entering view default on toggle', () => {
    const vs = createViewState(24, 64);
    expect(vs.activeTool).toBe('command');
    toggleView(vs); // → underground
    expect(vs.activeTool).toBe('dig');
    toggleView(vs); // → surface
    expect(vs.activeTool).toBe('command');
  });
});

// ---------------------------------------------------------------------------
// toggleUndergroundColony — 09.1 Chunk 2 (enemy underground view)
// ---------------------------------------------------------------------------

describe('toggleUndergroundColony', () => {
  it('initial createViewState sets activeUndergroundColonyId to PLAYER_COLONY_ID', () => {
    expect(createViewState(24, 64).activeUndergroundColonyId).toBe(PLAYER_COLONY_ID);
  });

  it('flips PLAYER → ENEMY then ENEMY → PLAYER', () => {
    const vs = createViewState(24, 64);
    toggleUndergroundColony(vs);
    expect(vs.activeUndergroundColonyId).toBe(ENEMY_COLONY_ID);
    toggleUndergroundColony(vs);
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
    const vs = createViewState(24, 64);
    toggleUndergroundColony(vs);
    expect(vs.activeView).toBe('surface');
  });

  it('leaves both camera centers unchanged', () => {
    const vs = createViewState(24, 64);
    const sx = vs.surfaceCamera.centerX;
    const sy = vs.surfaceCamera.centerY;
    const ux = vs.undergroundCamera.centerX;
    const uy = vs.undergroundCamera.centerY;
    toggleUndergroundColony(vs);
    expect(vs.surfaceCamera.centerX).toBe(sx);
    expect(vs.surfaceCamera.centerY).toBe(sy);
    expect(vs.undergroundCamera.centerX).toBe(ux);
    expect(vs.undergroundCamera.centerY).toBe(uy);
  });

  it('leaves undergroundVisited unchanged', () => {
    const vs = createViewState(24, 64);
    toggleView(vs);
    toggleView(vs);
    expect(vs.undergroundVisited).toBe(true);
    toggleUndergroundColony(vs);
    expect(vs.undergroundVisited).toBe(true);
  });

  it('mutates in place — preserves camera object identity for captured refs', () => {
    const vs = createViewState(24, 64);
    const surfaceCamRef = vs.surfaceCamera;
    const undergroundCamRef = vs.undergroundCamera;
    toggleUndergroundColony(vs);
    expect(vs.surfaceCamera).toBe(surfaceCamRef);
    expect(vs.undergroundCamera).toBe(undergroundCamRef);
  });

  it('resetViewState restores activeUndergroundColonyId to PLAYER_COLONY_ID', () => {
    const vs = createViewState(24, 64);
    toggleUndergroundColony(vs);
    expect(vs.activeUndergroundColonyId).toBe(ENEMY_COLONY_ID);
    resetViewState(vs, 24, 64);
    expect(vs.activeUndergroundColonyId).toBe(PLAYER_COLONY_ID);
  });
});
