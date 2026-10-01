// raid-order-view.test.ts — #352: the raid menu, the order caption, the rally
// badge, the raid-news captions under an order, and the input helpers that open
// the menu and send the pick.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RAID_ORDER_OPTIONS,
  RAID_BADGE_CELL_SCREEN_PX,
  RAID_BADGE_SCREEN_PX,
  activeRaidOrder,
  drawRaidOrderBadge,
  raidBadgeStackLiftWorldPx,
  raidBadgeWorldPx,
  RAID_MENU_DESCRIPTION_GAP_PX,
  RAID_MENU_DESCRIPTION_PAD_X,
  RAID_MENU_DESCRIPTION_WRAP_W,
  raidMenuDescription,
  raidMenuDescriptionObstacles,
  raidMenuDescriptionPos,
  raidMenuDescriptionWrapWidth,
  raidMenuHoveredOrder,
  raidMenuItemAt,
  raidOrderCaption,
  raidOrderOfRally,
  raidOrderOnTile,
  raidOrderOption,
  worldHasRaidOrders,
} from './raid-order-view.js';
import { drawGhostDelta } from './draw-command-legibility.js';
import type { GhostDelta } from './command-ghosts.js';
import { TILE_SIZE_PX } from './sprites.js';
import {
  CONTEXT_MENU,
  CONTEXT_MENU_HOVER_LIGHTEN,
  clampContextMenuAnchor,
  contextMenuHeight,
  contextMenuRowColor,
  drawContextMenuGeometry,
  isInsideContextMenu,
} from './context-menu-layout.js';
import { lerpColor } from './sprites.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';
import {
  createRaidCaptionState,
  nextRaidCaption,
  raidCaptionText,
  resetRaidCaptionState,
  RAID_CAPTION_TEXTS,
} from './raid-captions.js';
import { contextMenuState, hideContextMenu } from './context-menu-state.js';
import { handleSetRallyPoint, tryOpenRaidMenu } from '../input/surface-input.js';
import { RaidType } from '../sim/enums.js';
import { createScenario } from '../sim/scenario.js';
import { SIM_VERSION_V59_INVADER_RETARGET, type WorldState } from '../sim/types.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { makeCameraView } from './camera-adapter.js';
import type { ViewState } from './camera.js';
import type { GfxLike } from './draw-surface.js';
import type { SetRallyPointCommand } from '../sim/commands.js';

class MockGfx implements GfxLike {
  rects: Array<[number, number, number, number]> = [];
  styles: number[] = [];
  clear() {
    return this;
  }
  fillStyle(c: number) {
    this.styles.push(c);
    return this;
  }
  lineStyle() {
    return this;
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push([x, y, w, h]);
    return this;
  }
  fillCircle() {
    return this;
  }
  strokeCircle() {
    return this;
  }
  fillTriangle() {
    return this;
  }
}

function world(): WorldState {
  return createScenario(7, 'Normal');
}

function enemyDoor(w: WorldState): { x: number; y: number } {
  const e = w.colonies[ENEMY_COLONY_ID]!.entrances[0]!;
  return { x: e.surfaceTileX, y: e.surfaceTileY };
}

function surfaceView(): ViewState {
  return {
    activeView: 'surface',
    activeTool: 'command',
    surfaceCamera: makeCameraView(0, 0),
    undergroundCamera: makeCameraView(0, 0),
    undergroundVisited: true,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    undergroundCenterByColony: new Map(),
    showPheromoneOverlay: false,
  };
}

beforeEach(() => hideContextMenu());

describe('the raid menu rows', () => {
  it('lists the five orders in RaidType order', () => {
    expect(RAID_ORDER_OPTIONS.map((o) => o.label)).toEqual([
      'Loot',
      'Deny',
      'Spoil',
      'Blockade',
      'Assault',
    ]);
    RAID_ORDER_OPTIONS.forEach((o, i) => expect(o.raidType).toBe(i));
  });

  it('every label fits the menu width (13 px monospace, ~8 px a glyph, 6 px inset)', () => {
    for (const o of RAID_ORDER_OPTIONS)
      expect(6 + o.label.length * 8).toBeLessThan(CONTEXT_MENU.WIDTH);
  });

  it('maps a point to the row under it, and nothing outside the menu', () => {
    const ax = 100;
    const ay = 50;
    const h = CONTEXT_MENU.ITEM_HEIGHT;
    for (let i = 0; i < RAID_ORDER_OPTIONS.length; i++) {
      expect(raidMenuItemAt(ax + 10, ay + i * h + 1, ax, ay)).toBe(i);
      expect(raidMenuItemAt(ax + 10, ay + i * h + h - 1, ax, ay)).toBe(i);
    }
    expect(raidMenuItemAt(ax + 10, ay + 5 * h, ax, ay)).toBeNull();
    expect(raidMenuItemAt(ax - 1, ay + 1, ax, ay)).toBeNull();
    expect(raidMenuItemAt(ax + CONTEXT_MENU.WIDTH, ay + 1, ax, ay)).toBeNull();
    expect(raidMenuItemAt(ax + 10, ay - 1, ax, ay)).toBeNull();
    expect(isInsideContextMenu(ax + 10, ay + 5 * h - 1, ax, ay, RAID_ORDER_OPTIONS)).toBe(true);
    expect(isInsideContextMenu(ax + 10, ay + 5 * h, ax, ay, RAID_ORDER_OPTIONS)).toBe(false);
  });

  it('outlines the order in force, and only that row', () => {
    const plain = new MockGfx();
    drawContextMenuGeometry(plain, 0, 0, RAID_ORDER_OPTIONS);
    const marked = new MockGfx();
    drawContextMenuGeometry(marked, 0, 0, RAID_ORDER_OPTIONS, RaidType.Spoil);
    const extra = marked.rects.slice(plain.rects.length);
    expect(extra).toHaveLength(4);
    const top = RaidType.Spoil * CONTEXT_MENU.ITEM_HEIGHT;
    for (const [, y, , hh] of extra) {
      expect(y).toBeGreaterThanOrEqual(top);
      expect(y + hh).toBeLessThanOrEqual(top + CONTEXT_MENU.ITEM_HEIGHT);
    }
  });
});

describe('the order caption', () => {
  it('names the order ("Raiding: Deny. …")', () => {
    expect(raidOrderCaption(RaidType.Deny)).toMatch(/^Raiding: Deny\. /);
    expect(raidOrderCaption(RaidType.Blockade)).toMatch(/^Raiding: Blockade\. /);
    expect(raidOrderCaption(RaidType.Assault)).toMatch(/queen/);
  });

  it('raidOrderOfRally: an enemy entrance in a V60 world gives the command’s type (Loot if none)', () => {
    const w = world();
    const d = enemyDoor(w);
    const cmd = (extra: Partial<SetRallyPointCommand>): SetRallyPointCommand => ({
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: d.x,
      tileY: d.y,
      issuedAtTick: 0,
      ...extra,
    });
    expect(raidOrderOfRally(w, PLAYER_COLONY_ID, cmd({}))).toBe(RaidType.Loot);
    expect(raidOrderOfRally(w, PLAYER_COLONY_ID, cmd({ raidType: RaidType.Spoil }))).toBe(
      RaidType.Spoil,
    );
    expect(raidOrderOfRally(w, PLAYER_COLONY_ID, cmd({ raidType: 7 as RaidType }))).toBeNull();
    // A present null is malformed (the sim drops it), not Loot as an absent type is.
    expect(
      raidOrderOfRally(w, PLAYER_COLONY_ID, cmd({ raidType: null as unknown as RaidType })),
    ).toBeNull();
    expect(raidOrderOfRally(w, PLAYER_COLONY_ID, cmd({ tileX: d.x - 20 }))).toBeNull();
    w.simVersion = SIM_VERSION_V59_INVADER_RETARGET;
    expect(raidOrderOfRally(w, PLAYER_COLONY_ID, cmd({}))).toBeNull();
  });
});

describe('activeRaidOrder and the rally badge', () => {
  it('is the stored type only while the rally is on an enemy entrance in a V60 world', () => {
    const w = world();
    const c = w.colonies[PLAYER_COLONY_ID]!;
    expect(worldHasRaidOrders(w)).toBe(true);
    expect(activeRaidOrder(w, PLAYER_COLONY_ID)).toBeNull(); // no rally
    const d = enemyDoor(w);
    c.rallyPoint = { tileX: d.x, tileY: d.y };
    c.raidType = RaidType.Assault;
    expect(activeRaidOrder(w, PLAYER_COLONY_ID)).toBe(RaidType.Assault);
    c.rallyPoint = { tileX: d.x - 20, tileY: d.y };
    expect(activeRaidOrder(w, PLAYER_COLONY_ID)).toBeNull();
    const own = c.entrances[0]!;
    c.rallyPoint = { tileX: own.surfaceTileX, tileY: own.surfaceTileY };
    expect(activeRaidOrder(w, PLAYER_COLONY_ID)).toBeNull(); // own entrance: tunnel defence
    c.rallyPoint = { tileX: d.x, tileY: d.y };
    w.simVersion = SIM_VERSION_V59_INVADER_RETARGET;
    expect(activeRaidOrder(w, PLAYER_COLONY_ID)).toBeNull();
  });

  it('draws a dark square above the tile and a distinct letter per order', () => {
    const seen = new Set<string>();
    for (const o of RAID_ORDER_OPTIONS) {
      const g = new MockGfx();
      drawRaidOrderBadge(g, 160, 320, o.raidType, 1);
      const [bx, by, bw, bh] = g.rects[0]!;
      expect([bw, bh]).toEqual([RAID_BADGE_SCREEN_PX, RAID_BADGE_SCREEN_PX]);
      expect(by + bh).toBeLessThanOrEqual(320); // wholly above the rally tile
      const cells = g.rects.slice(1);
      expect(cells.length).toBe(o.glyph.join('').split('#').length - 1);
      for (const [x, y, w, h] of cells) {
        expect(x >= bx && y >= by && x + w <= bx + bw && y + h <= by + bh).toBe(true);
      }
      expect(g.styles).toContain(o.badgeColor);
      seen.add(JSON.stringify(cells));
    }
    expect(seen.size).toBe(RAID_ORDER_OPTIONS.length);
  });
});

describe('raid news captions under an order', () => {
  it('Loot keeps the #290 wording; Deny names the order', () => {
    expect(raidCaptionText('looting', RaidType.Loot)).toBe(RAID_CAPTION_TEXTS.looting);
    expect(raidCaptionText('looting', null)).toBe(RAID_CAPTION_TEXTS.looting);
    expect(raidCaptionText('looting', RaidType.Deny)).toMatch(/^Raiding: Deny\. /);
    expect(raidCaptionText('hauled', RaidType.Deny)).toMatch(/^Raiding: Deny\. /);
    expect(raidCaptionText('raided', RaidType.Deny)).toBe(RAID_CAPTION_TEXTS.raided);
  });

  it('a Spoil shows as the enemy’s loss: "spoiling" fires only under a Spoil order', () => {
    const w = world();
    const c = w.colonies[PLAYER_COLONY_ID]!;
    const enemy = w.colonies[ENEMY_COLONY_ID]!;
    const d = enemyDoor(w);
    c.rallyPoint = { tileX: d.x, tileY: d.y };
    c.raidType = RaidType.Spoil;
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, PLAYER_COLONY_ID);
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull();
    enemy.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBe('spoiling');
    expect(raidCaptionText('spoiling', RaidType.Spoil)).toMatch(/^Raiding: Spoil\. /);
    // Under Loot the same loss (the enemy's) is no news of ours.
    const w2 = world();
    const c2 = w2.colonies[PLAYER_COLONY_ID]!;
    c2.rallyPoint = { tileX: d.x, tileY: d.y };
    const s2 = createRaidCaptionState();
    resetRaidCaptionState(s2, w2, PLAYER_COLONY_ID);
    w2.colonies[ENEMY_COLONY_ID]!.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s2, w2, PLAYER_COLONY_ID)).toBeNull();
  });

  it('"spoiling" counts only the Spoil target’s loss, not another colony’s', () => {
    const w = world();
    const c = w.colonies[PLAYER_COLONY_ID]!;
    const d = enemyDoor(w);
    const enemy = w.colonies[ENEMY_COLONY_ID]!;
    // A third colony (after the enemy in key order) with an entrance of its own;
    // the Spoil order is on THAT entrance, so the enemy's loss is not our news.
    const door = { ...enemy.entrances[0]!, entranceId: 999_001, surfaceTileX: d.x + 9 };
    const third = { ...enemy, colonyId: 7, entrances: [door] };
    (w.colonies as Record<number, typeof third>)[7] = third;
    c.rallyPoint = { tileX: door.surfaceTileX, tileY: door.surfaceTileY };
    c.raidType = RaidType.Spoil;
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, PLAYER_COLONY_ID);
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull();
    enemy.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull();
    third.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBe('spoiling');
  });

  it('owed Spoil news is dropped when the order ends or moves to another colony', () => {
    const w = world();
    const c = w.colonies[PLAYER_COLONY_ID]!;
    const d = enemyDoor(w);
    const enemy = w.colonies[ENEMY_COLONY_ID]!;
    c.rallyPoint = { tileX: d.x, tileY: d.y };
    c.raidType = RaidType.Spoil;
    const s = createRaidCaptionState();
    resetRaidCaptionState(s, w, PLAYER_COLONY_ID);
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull(); // the target's baseline
    enemy.foodLostToRaidsFp += 1024;
    // Owed, but the caption queue is busy (never marked shown) ...
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBe('spoiling');
    // ... and the order changes to Loot: it must not show later as Spoil news.
    c.raidType = RaidType.Loot;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull();
    c.raidType = RaidType.Spoil;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull(); // back on: a new baseline

    // Moved to a third colony's entrance while owed: dropped, and the new
    // target's loss so far is only its baseline; a later loss of it is news.
    enemy.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBe('spoiling');
    const door = { ...enemy.entrances[0]!, entranceId: 999_001, surfaceTileX: d.x + 9 };
    const third = { ...enemy, colonyId: 7, entrances: [door], foodLostToRaidsFp: 4096 };
    (w.colonies as Record<number, typeof third>)[7] = third;
    c.rallyPoint = { tileX: door.surfaceTileX, tileY: door.surfaceTileY };
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBeNull();
    third.foodLostToRaidsFp += 1024;
    expect(nextRaidCaption(s, w, PLAYER_COLONY_ID)).toBe('spoiling');
  });
});

describe('input: opening the raid menu and sending the pick', () => {
  it('opens on an enemy entrance on the surface, in a V60 world, and nowhere else', () => {
    const w = world();
    const d = enemyDoor(w);
    expect(tryOpenRaidMenu(w, surfaceView(), 30, 40, d.x, d.y)).toBe(true);
    expect(contextMenuState.pendingShow).toBe(true);
    expect(contextMenuState.kind).toBe('raid');
    expect([contextMenuState.screenX, contextMenuState.screenY]).toEqual([30, 40]);
    expect([contextMenuState.anchorTileX, contextMenuState.anchorTileY]).toEqual([d.x, d.y]);
    hideContextMenu();
    const own = w.colonies[PLAYER_COLONY_ID]!.entrances[0]!;
    expect(tryOpenRaidMenu(w, surfaceView(), 0, 0, own.surfaceTileX, own.surfaceTileY)).toBe(false);
    expect(tryOpenRaidMenu(w, surfaceView(), 0, 0, d.x - 20, d.y)).toBe(false);
    expect(
      tryOpenRaidMenu(w, { ...surfaceView(), activeView: 'underground' }, 0, 0, d.x, d.y),
    ).toBe(false);
    w.simVersion = SIM_VERSION_V59_INVADER_RETARGET;
    expect(tryOpenRaidMenu(w, surfaceView(), 0, 0, d.x, d.y)).toBe(false);
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('a pick enqueues SetRallyPoint with the raid type; a plain rally carries none', () => {
    const w = world();
    const d = enemyDoor(w);
    expect(handleSetRallyPoint(w, d.x, d.y, PLAYER_COLONY_ID, false, RaidType.Blockade)).toBe(
      false,
    );
    expect(handleSetRallyPoint(w, d.x, d.y, PLAYER_COLONY_ID, false)).toBe(false);
    const [picked, plain] = w.commandQueue as SetRallyPointCommand[];
    expect(picked).toMatchObject({
      type: 'SetRallyPoint',
      tileX: d.x,
      raidType: RaidType.Blockade,
    });
    expect(plain!.type).toBe('SetRallyPoint');
    expect('raidType' in plain!).toBe(false);
  });
});

describe('#352 review — menu placement, the order in force, the queued badge', () => {
  it('clampContextMenuAnchor keeps the whole menu inside the given bounds', () => {
    const h = CONTEXT_MENU.ITEM_HEIGHT * RAID_ORDER_OPTIONS.length;
    expect(clampContextMenuAnchor(100, 100, h, 800, 508)).toEqual({ x: 100, y: 100 });
    // Near the bottom-right corner it moves up and left so every row is on screen.
    const a = clampContextMenuAnchor(780, 500, h, 800, 508);
    expect(a).toEqual({ x: 800 - CONTEXT_MENU.WIDTH, y: 508 - h });
    // Never off the top-left.
    expect(clampContextMenuAnchor(-5, -5, h, 800, 508)).toEqual({ x: 0, y: 0 });
  });

  it('raidOrderOnTile is the order only on the rallied entrance', () => {
    const w = world();
    const c = w.colonies[PLAYER_COLONY_ID]!;
    const d = enemyDoor(w);
    expect(raidOrderOnTile(w, PLAYER_COLONY_ID, d.x, d.y)).toBeNull();
    c.rallyPoint = { tileX: d.x, tileY: d.y };
    c.raidType = RaidType.Spoil;
    expect(raidOrderOnTile(w, PLAYER_COLONY_ID, d.x, d.y)).toBe(RaidType.Spoil);
    expect(raidOrderOnTile(w, PLAYER_COLONY_ID, d.x + 1, d.y)).toBeNull();
  });

  it('the queued badge sits on the rally tile, lifted above the committed one on a type change', () => {
    const base: GhostDelta = {
      pendingMarks: [],
      pendingRemovals: [],
      ghostChambers: [],
      removedChambers: [],
      pendingRally: null,
      rallyCleared: null,
      pendingSpiderPriority: null,
      pendingFoodMark: null,
      foodMarkCleared: null,
      pendingEntrances: [],
      pendingRaidOrder: null,
    };
    const tile = { tileX: 10, tileY: 20 };
    // #378: the badge is sized for the camera zoom, which drawGhostDelta passes on.
    for (const zoom of [1, 2, 0.5]) {
      const plain = new MockGfx();
      drawGhostDelta(
        plain,
        { ...base, pendingRaidOrder: { ...tile, raidType: RaidType.Deny, overCommitted: false } },
        'surface',
        PLAYER_COLONY_ID,
        zoom,
      );
      const ref = new MockGfx();
      drawRaidOrderBadge(
        ref,
        tile.tileX * TILE_SIZE_PX,
        tile.tileY * TILE_SIZE_PX,
        RaidType.Deny,
        zoom,
      );
      expect(plain.rects).toEqual(ref.rects);
      const lifted = new MockGfx();
      drawGhostDelta(
        lifted,
        { ...base, pendingRaidOrder: { ...tile, raidType: RaidType.Deny, overCommitted: true } },
        'surface',
        PLAYER_COLONY_ID,
        zoom,
      );
      const lift = raidBadgeStackLiftWorldPx(zoom);
      expect(lifted.rects.map((r) => r[1])).toEqual(ref.rects.map((r) => r[1] - lift));
      // Stacked just clear of the committed badge: it ends 1 screen px above it.
      expect((lift - raidBadgeWorldPx(zoom)) * zoom).toBeCloseTo(1, 9);
    }
    expect(new MockGfx().rects).toEqual([]);
  });
});

describe('#378 — the rally badge is sized on screen, not in the world', () => {
  /** The badge rects drawn for the rally tile at (wx, wy) = (160, 320) under `zoom`. */
  function badge(zoom: number, type: RaidType = RaidType.Assault) {
    const g = new MockGfx();
    drawRaidOrderBadge(g, 160, 320, type, zoom);
    const [bx, by, bw, bh] = g.rects[0]!;
    return { g, bx, by, bw, bh, cells: g.rects.slice(1) };
  }

  it('is the same size on screen at every zoom, letter cells included', () => {
    for (const zoom of [0.2, 0.5, 0.8, 1, 1.5, 2]) {
      const { bw, bh, cells } = badge(zoom);
      expect(bw * zoom).toBeCloseTo(RAID_BADGE_SCREEN_PX, 9);
      expect(bh * zoom).toBeCloseTo(RAID_BADGE_SCREEN_PX, 9);
      expect(raidBadgeWorldPx(zoom) * zoom).toBeCloseTo(RAID_BADGE_SCREEN_PX, 9);
      for (const [, , cw, ch] of cells) {
        expect(cw * zoom).toBeCloseTo(RAID_BADGE_CELL_SCREEN_PX, 9);
        expect(ch * zoom).toBeCloseTo(RAID_BADGE_CELL_SCREEN_PX, 9);
      }
    }
  });

  it('is legible at 1x: half as big again as the old 12-px chip, a 15-px letter', () => {
    expect(RAID_BADGE_SCREEN_PX).toBeGreaterThanOrEqual(18);
    expect(5 * RAID_BADGE_CELL_SCREEN_PX).toBeGreaterThanOrEqual(15);
    expect(badge(1).bw).toBe(RAID_BADGE_SCREEN_PX);
  });

  it('never dominates at high zoom: at 2x it is smaller on screen than the tile under it', () => {
    const zoom = 2;
    const { bw } = badge(zoom);
    expect(bw * zoom).toBeLessThan(TILE_SIZE_PX * zoom * 0.75);
    expect(bw * zoom).toBeLessThan(24); // the old world-sized chip was 24 px at 2x
  });

  it('sits centred over the rally tile (to a whole screen px) and wholly above it, 1 screen px clear', () => {
    for (const zoom of [0.5, 1, 2]) {
      const { bx, by, bw, bh, cells } = badge(zoom);
      expect(Math.abs(bx + bw / 2 - (160 + TILE_SIZE_PX / 2)) * zoom).toBeLessThanOrEqual(0.5);
      expect((320 - (by + bh)) * zoom).toBeCloseTo(1, 9);
      for (const [x, y, w, h] of cells) {
        expect(x >= bx && y >= by && x + w <= bx + bw + 1e-9 && y + h <= by + bh + 1e-9).toBe(true);
      }
    }
  });

  it('lands on whole pixels at 1x (a tile-aligned camera draws it crisp)', () => {
    const { g } = badge(1);
    for (const [x, y, w, h] of g.rects) {
      for (const v of [x, y, w, h]) expect(Number.isInteger(v)).toBe(true);
    }
    // At 2x its left edge is a whole number of screen px from the tile's.
    const b2 = badge(2);
    expect(Number.isInteger((b2.bx - 160) * 2)).toBe(true);
  });

  it('keeps the letter shape: the same cells at every zoom, only scaled', () => {
    const at = (zoom: number) =>
      badge(zoom, RaidType.Blockade).cells.map(([x, y]) => [
        Math.round(((x - badge(zoom).bx) * zoom) / RAID_BADGE_CELL_SCREEN_PX),
        Math.round(((y - badge(zoom).by) * zoom) / RAID_BADGE_CELL_SCREEN_PX),
      ]);
    expect(at(0.5)).toEqual(at(1));
    expect(at(2)).toEqual(at(1));
  });
});

describe('#378 — the raid menu: hover highlight and description', () => {
  const ax = 100;
  const ay = 50;
  const rowY = (i: number) => ay + i * CONTEXT_MENU.ITEM_HEIGHT + 4;

  it('a mouse hovers the row under it; nothing off the menu', () => {
    for (const o of RAID_ORDER_OPTIONS) {
      expect(raidMenuHoveredOrder(ax + 10, rowY(o.raidType), ax, ay, true)).toBe(o.raidType);
    }
    expect(raidMenuHoveredOrder(ax - 1, rowY(0), ax, ay, true)).toBeNull();
    expect(
      raidMenuHoveredOrder(ax + 10, ay + contextMenuHeight(RAID_ORDER_OPTIONS), ax, ay, true),
    ).toBeNull();
  });

  it('a pointer not pointing (touch, or a mouse not moved since the menu opened) hovers nothing — not even the first row it rests on', () => {
    expect(raidMenuHoveredOrder(ax, ay, ax, ay, false)).toBeNull();
    for (const o of RAID_ORDER_OPTIONS) {
      expect(raidMenuHoveredOrder(ax + 10, rowY(o.raidType), ax, ay, false)).toBeNull();
    }
  });

  it('describes the hovered order, else the order in force, else nothing', () => {
    expect(raidMenuDescription(RaidType.Spoil, RaidType.Deny)).toMatch(/^Spoil: /);
    expect(raidMenuDescription(null, RaidType.Deny)).toMatch(/^Deny: /); // no hover
    expect(raidMenuDescription(RaidType.Loot, null)).toMatch(/^Loot: /);
    expect(raidMenuDescription(null, null)).toBeNull();
  });

  it('uses the order caption’s own wording (single-sourced), one line per order', () => {
    for (const o of RAID_ORDER_OPTIONS) {
      const d = raidMenuDescription(o.raidType, null)!;
      expect(d).toBe(`${o.label}: ${raidOrderOption(o.raidType).blurb}`);
      expect(raidOrderCaption(o.raidType).endsWith(o.blurb)).toBe(true);
      expect(d).not.toContain('\n');
      // A rough bound only (12-px monospace is ~7.2 px a glyph, plus 12 px of
      // padding): one line fits the 800-px canvas. The e2e screenshot shows it.
      expect(12 + d.length * 7.2).toBeLessThan(800);
    }
  });

  it('draws the hovered row lit, every other row as before; hover and the in-force outline coexist', () => {
    const plain = new MockGfx();
    drawContextMenuGeometry(plain, ax, ay, RAID_ORDER_OPTIONS, RaidType.Deny);
    const hovered = new MockGfx();
    drawContextMenuGeometry(hovered, ax, ay, RAID_ORDER_OPTIONS, RaidType.Deny, RaidType.Spoil);
    expect(hovered.rects).toEqual(plain.rects); // same geometry, outline included
    const diff = hovered.styles
      .map((c, i) => [i, c, plain.styles[i]] as const)
      .filter(([, a, b]) => a !== b);
    expect(diff).toHaveLength(1);
    const spoil = raidOrderOption(RaidType.Spoil);
    const lit = lerpColor(spoil.stripeColor, 0xffffff, CONTEXT_MENU_HOVER_LIGHTEN);
    expect(diff[0]![1]).toBe(lit);
    expect(diff[0]![2]).toBe(spoil.stripeColor);
    expect(contextMenuRowColor(spoil, true)).toBe(lit);
    expect(contextMenuRowColor(spoil, false)).toBe(spoil.stripeColor);
  });

  it('a lit row is clearly brighter than every unlit stripe', () => {
    const lum = (c: number) => ((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff);
    const brightestUnlit = Math.max(...RAID_ORDER_OPTIONS.map((o) => lum(o.stripeColor)));
    for (const o of RAID_ORDER_OPTIONS) {
      expect(lum(contextMenuRowColor(o, true)) - lum(o.stripeColor)).toBeGreaterThan(150);
      expect(lum(contextMenuRowColor(o, true))).toBeGreaterThan(brightestUnlit);
    }
  });

  it('places the description just below the menu, or above it when below meets the HUD strip', () => {
    const menuH = contextMenuHeight(RAID_ORDER_OPTIONS);
    // Room below: left-aligned with the menu, 2 px under it.
    expect(raidMenuDescriptionPos(ax, ay, menuH, 400, 20, 800, 508)).toEqual({
      x: ax,
      y: ay + menuH + 2,
    });
    // The menu pushed down to the strip (clampContextMenuAnchor): above it instead.
    const low = 508 - menuH;
    const above = raidMenuDescriptionPos(ax, low, menuH, 400, 20, 800, 508);
    expect(above).toEqual({ x: ax, y: low - 2 - 20 });
    expect(above.y + 20).toBeLessThanOrEqual(low); // never over the menu
    // Near the right edge: moved left to end inside the canvas.
    expect(raidMenuDescriptionPos(680, ay, menuH, 400, 20, 800, 508).x).toBe(400);
    // Wider than the canvas: pinned at 0, never off the left.
    expect(raidMenuDescriptionPos(680, ay, menuH, 900, 20, 800, 508).x).toBe(0);
    // #399 — fits neither below nor above (not reachable at 800 × 592): beside
    // the menu instead, at the top, clear of it.
    expect(raidMenuDescriptionPos(ax, 0, menuH, 400, 20, 800, menuH + 10)).toEqual({
      x: ax + CONTEXT_MENU.WIDTH + 2,
      y: 0,
    });
    // Fits nowhere at all (a box as wide as the canvas, no room above or below):
    // the #378 rule — pinned at the top-left, never off the canvas.
    expect(raidMenuDescriptionPos(ax, 0, menuH, 800, 20, 800, menuH + 10)).toEqual({ x: 0, y: 0 });
  });
});

describe('#399 — the raid menu description: wrapped, on screen, clear of the HUD', () => {
  const layout = DEFAULT_LAYOUT;
  const hud = buildHudLayout(layout);
  const obstacles = raidMenuDescriptionObstacles(hud);
  const menuH = contextMenuHeight(RAID_ORDER_OPTIONS);
  const strip = hud.HINTS.y;
  const g = RAID_MENU_DESCRIPTION_GAP_PX;
  type R = { x: number; y: number; w: number; h: number };
  /** True if a and b are at least `gap` px apart (on one axis or the other). */
  const apart = (a: R, b: R, gap: number): boolean =>
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y;
  /** The description box for a menu opened at (px, py), w × h. */
  const place = (px: number, py: number, w: number, h: number): R & { menu: R } => {
    const a = clampContextMenuAnchor(px, py, menuH, layout.w, strip);
    const pos = raidMenuDescriptionPos(a.x, a.y, menuH, w, h, layout.w, strip, obstacles);
    return { ...pos, w, h, menu: { x: a.x, y: a.y, w: CONTEXT_MENU.WIDTH, h: menuH } };
  };
  /** Greedy word wrap at `cols` characters (what Phaser's basic wrap does in a
   *  monospace font). */
  const wrap = (text: string, cols: number): string[] => {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= cols) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
    return lines;
  };
  /** The box of a two-line description at the full wrap width, and of a three-line
   *  one (headroom for a wider font). 12-px monospace: ~7.2 px a glyph, ~14 px a line. */
  const BOXES = [
    { w: RAID_MENU_DESCRIPTION_WRAP_W + 2 * RAID_MENU_DESCRIPTION_PAD_X, h: 2 * 15 + 6 },
    { w: RAID_MENU_DESCRIPTION_WRAP_W + 2 * RAID_MENU_DESCRIPTION_PAD_X, h: 3 * 15 + 6 },
    { w: 160, h: 20 },
  ] as const;

  it('wraps at 288 px (40 monospace characters): every order is two short lines, the blurb unchanged', () => {
    expect(raidMenuDescriptionWrapWidth(layout)).toBe(RAID_MENU_DESCRIPTION_WRAP_W);
    expect(RAID_MENU_DESCRIPTION_WRAP_W).toBe(288);
    // A canvas too narrow for the box: the box (text + padding) still fits it.
    expect(raidMenuDescriptionWrapWidth(createLayoutContext(200, 592))).toBe(
      200 - 2 * RAID_MENU_DESCRIPTION_PAD_X,
    );
    const cols = Math.floor(RAID_MENU_DESCRIPTION_WRAP_W / 7.2);
    for (const o of RAID_ORDER_OPTIONS) {
      const text = raidMenuDescription(o.raidType, null)!;
      // The menu and the order caption say the same thing (one blurb).
      expect(text).toBe(`${o.label}: ${o.blurb}`);
      expect(raidOrderCaption(o.raidType)).toBe(`Raiding: ${o.label}. ${o.blurb}`);
      const lines = wrap(text, cols);
      expect(lines.length, text).toBe(2);
      // The one-line description that ran to the canvas's edge was ~500 px.
      for (const line of lines) expect(line.length * 7.2).toBeLessThanOrEqual(288);
    }
  });

  it('keeps clear of the minimap frame, the right-hand toggles, the tool palette, the stats and the save icon', () => {
    const frame = obstacles[0]!;
    // The minimap's painted frame reaches 3 px outside the map rect.
    expect(frame).toEqual({
      x: hud.MINIMAP.x - 3,
      y: hud.MINIMAP.y - 3,
      w: hud.MINIMAP.w + 6,
      h: hud.MINIMAP.h + 6,
    });
    expect(obstacles.slice(1)).toEqual([
      hud.VIEW_TOGGLE,
      hud.ALARM_TOGGLE,
      hud.TOOLS,
      hud.STATS,
      hud.SAVE_ICON,
    ]);
  });

  it('the playtest case (Blockade, menu by the Underground button): under the menu, left of the minimap and the button', () => {
    // shots/04-raid-menu-hover-3-blockade.png: the menu at (424, 296).
    const b = place(424, 296, BOXES[0].w, BOXES[0].h);
    expect(b.y).toBe(296 + menuH + g); // still just under the menu
    expect(b.x + b.w + g).toBeLessThanOrEqual(hud.MINIMAP.x - 3); // left of the minimap frame
    expect(b.x + b.w + g).toBeLessThanOrEqual(hud.VIEW_TOGGLE.x);
    expect(b.x + b.w).toBeGreaterThan(424); // and still under (part of) the menu
  });

  it('near the right edge: under the menu, inside the canvas, clear of the right-hand column', () => {
    const b = place(790, 150, BOXES[0].w, BOXES[0].h);
    expect(b.menu.x).toBe(layout.w - CONTEXT_MENU.WIDTH);
    expect(b.y).toBe(b.menu.y + menuH + g);
    expect(b.x + b.w).toBeLessThanOrEqual(layout.w);
    for (const r of obstacles) expect(apart(b, r, g)).toBe(true);
  });

  it('near the bottom: above the menu (the menu sits on the HUD strip)', () => {
    const b = place(300, 560, BOXES[0].w, BOXES[0].h);
    expect(b.menu.y).toBe(strip - menuH);
    expect(b.y + b.h + g).toBe(b.menu.y);
    expect(b.x).toBe(300);
  });

  it('over the minimap: above the menu and left of the right-hand toggles', () => {
    const b = place(700, 470, BOXES[0].w, BOXES[0].h);
    // The menu itself lies over the minimap.
    expect(apart(b.menu, obstacles[0]!, 0)).toBe(false);
    expect(b.y + b.h).toBeLessThanOrEqual(b.menu.y - g);
    expect(b.x + b.w + g).toBeLessThanOrEqual(hud.ALARM_TOGGLE.x);
    for (const r of obstacles) expect(apart(b, r, g)).toBe(true);
  });

  it('slides past a control toward 0 first, else the other way; beside the menu, up first, else down', () => {
    const w = 300;
    const h = 36;
    // Below the menu, a control under its left end, by the canvas's left edge: no
    // room to its left, so the box goes just right of it.
    const control = { x: 0, y: 160, w: 100, h: 40 };
    expect(raidMenuDescriptionPos(10, 30, menuH, w, h, 800, 508, [control])).toEqual({
      x: control.x + control.w + g,
      y: 30 + menuH + g,
    });
    // The same control further right: room to its left, so just left of it.
    const right = { x: 400, y: 160, w: 100, h: 40 };
    expect(raidMenuDescriptionPos(350, 30, menuH, w, h, 800, 508, [right])).toEqual({
      x: right.x - g - w,
      y: 30 + menuH + g,
    });
    // No room above or below (a short canvas): beside the menu, left first,
    // top-aligned with it…
    const short = menuH + 10;
    expect(raidMenuDescriptionPos(700, 0, menuH, w, 20, 800, short)).toEqual({
      x: 700 - g - w,
      y: 0,
    });
    // …slid down past a control there (no room above it).
    const beside = { x: 380, y: 0, w: 50, h: 30 };
    expect(raidMenuDescriptionPos(700, 0, menuH, w, 20, 800, short, [beside])).toEqual({
      x: 700 - g - w,
      y: beside.y + beside.h + g,
    });
  });

  it('wherever the menu opens, the box is on screen above the strip, off the menu, and clear of every HUD control', () => {
    let checked = 0;
    const bad: string[] = [];
    for (const box of BOXES) {
      for (let py = -20; py <= layout.h + 20; py += 3) {
        for (let px = -20; px <= layout.w + 20; px += 3) {
          const b = place(px, py, box.w, box.h);
          const ok =
            b.x >= 0 &&
            b.y >= 0 &&
            b.x + b.w <= layout.w &&
            b.y + b.h <= strip &&
            apart(b, b.menu, g) &&
            obstacles.every((r) => apart(b, r, g));
          if (!ok && bad.length < 5) {
            bad.push(`menu (${b.menu.x}, ${b.menu.y}), box ${box.w}×${box.h} at (${b.x}, ${b.y})`);
          }
          checked++;
        }
      }
    }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(100_000);
  });
});
