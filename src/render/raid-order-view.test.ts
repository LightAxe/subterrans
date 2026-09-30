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
  raidMenuDescription,
  raidMenuDescriptionPos,
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
    // Fits neither below nor above (not reachable at 800 × 592): pinned at the
    // top — never off it — even though it then overlaps the menu.
    expect(raidMenuDescriptionPos(ax, 0, menuH, 400, 20, 800, menuH + 10).y).toBe(0);
  });
});
