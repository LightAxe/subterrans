// context-menu-layout.test.ts — Vitest unit tests for context menu geometry.

import { describe, it, expect } from 'vitest';
import {
  CONTEXT_MENU,
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_ITEMS,
  contextMenuHeight,
  contextMenuItemAt,
  isInsideContextMenu,
  itemLabelPos,
  drawContextMenuGeometry,
  visibleContextMenuItems,
} from './context-menu-layout.js';
import { ChamberType } from '../sim/enums.js';
import { createColonyRecord, type ChamberRecord } from '../sim/colony/colony-store.js';
import { createWorldState, type WorldState } from '../sim/types.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { GfxLike } from './draw-surface.js';

interface GfxCall {
  method: string;
  args: unknown[];
}

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];
  private rec(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }
  clear() {
    return this.rec('clear', []);
  }
  fillStyle(c: number, a?: number) {
    return this.rec('fillStyle', [c, a]);
  }
  lineStyle(w: number, c: number, a?: number) {
    return this.rec('lineStyle', [w, c, a]);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    return this.rec('fillRect', [x, y, w, h]);
  }
  fillCircle(x: number, y: number, r: number) {
    return this.rec('fillCircle', [x, y, r]);
  }
  strokeCircle(x: number, y: number, r: number) {
    return this.rec('strokeCircle', [x, y, r]);
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
    return this.rec('fillTriangle', [x0, y0, x1, y1, x2, y2]);
  }
}

// Test fixtures --------------------------------------------------------------

function makeQueenChamber(): ChamberRecord {
  return {
    chamberId: 1,
    chamberType: ChamberType.Queen,
    foodStored: 0,
    posX: 0,
    posY: 0,
    width: 5,
    height: 3,
  };
}

function makeWorld(): WorldState {
  return createWorldState(1);
}

describe('context menu layout constants', () => {
  it('three items with fixed chamber-type ordering', () => {
    expect(CONTEXT_MENU.ITEM_COUNT).toBe(3);
    expect(CONTEXT_MENU_ITEMS.length).toBe(3);
    expect(CONTEXT_MENU_ITEMS[0]!.chamberType).toBe(ChamberType.Queen);
    expect(CONTEXT_MENU_ITEMS[1]!.chamberType).toBe(ChamberType.Nursery);
    expect(CONTEXT_MENU_ITEMS[2]!.chamberType).toBe(ChamberType.FoodStorage);
  });

  it('labels match the user-facing contract', () => {
    expect(CONTEXT_MENU_ITEMS[0]!.label).toBe('Queen');
    expect(CONTEXT_MENU_ITEMS[1]!.label).toBe('Nursery');
    expect(CONTEXT_MENU_ITEMS[2]!.label).toBe('Food Storage');
  });

  it('total height (full list) = itemCount × itemHeight', () => {
    expect(CONTEXT_MENU_HEIGHT).toBe(CONTEXT_MENU.ITEM_HEIGHT * CONTEXT_MENU.ITEM_COUNT);
  });

  it('contextMenuHeight(items) scales with item count', () => {
    expect(contextMenuHeight(CONTEXT_MENU_ITEMS)).toBe(72);
    expect(contextMenuHeight(CONTEXT_MENU_ITEMS.slice(0, 2))).toBe(48);
    expect(contextMenuHeight([])).toBe(0);
  });
});

describe('contextMenuItemAt (full list)', () => {
  const AX = 100;
  const AY = 200;

  it('returns the chamber type for each row', () => {
    expect(contextMenuItemAt(AX + 10, AY + 5, AX, AY)).toBe(ChamberType.Queen);
    expect(contextMenuItemAt(AX + 10, AY + 25, AX, AY)).toBe(ChamberType.Nursery);
    expect(contextMenuItemAt(AX + 10, AY + 50, AX, AY)).toBe(ChamberType.FoodStorage);
  });

  it('returns null above, below, left, right of the menu', () => {
    expect(contextMenuItemAt(AX + 10, AY - 1, AX, AY)).toBeNull();
    expect(contextMenuItemAt(AX + 10, AY + CONTEXT_MENU_HEIGHT, AX, AY)).toBeNull();
    expect(contextMenuItemAt(AX - 1, AY + 5, AX, AY)).toBeNull();
    expect(contextMenuItemAt(AX + CONTEXT_MENU.WIDTH, AY + 5, AX, AY)).toBeNull();
  });
});

describe('contextMenuItemAt (filtered list)', () => {
  const AX = 0;
  const AY = 0;

  it('with Queen filtered: row 0 = Nursery, row 1 = FoodStorage', () => {
    const items = CONTEXT_MENU_ITEMS.filter((i) => i.chamberType !== ChamberType.Queen);
    expect(contextMenuItemAt(5, 5, AX, AY, items)).toBe(ChamberType.Nursery);
    expect(contextMenuItemAt(5, 25, AX, AY, items)).toBe(ChamberType.FoodStorage);
    expect(contextMenuItemAt(5, 48, AX, AY, items)).toBeNull(); // past 2-item height
  });
});

describe('isInsideContextMenu', () => {
  const AX = 100;
  const AY = 200;

  it('true for interior points (full list)', () => {
    expect(isInsideContextMenu(AX + 1, AY + 1, AX, AY)).toBe(true);
    expect(
      isInsideContextMenu(AX + CONTEXT_MENU.WIDTH - 1, AY + CONTEXT_MENU_HEIGHT - 1, AX, AY),
    ).toBe(true);
  });

  it('false for boundary-out and exterior points', () => {
    expect(isInsideContextMenu(AX - 1, AY + 1, AX, AY)).toBe(false);
    expect(isInsideContextMenu(AX + CONTEXT_MENU.WIDTH, AY + 1, AX, AY)).toBe(false);
    expect(isInsideContextMenu(AX + 1, AY - 1, AX, AY)).toBe(false);
    expect(isInsideContextMenu(AX + 1, AY + CONTEXT_MENU_HEIGHT, AX, AY)).toBe(false);
  });

  it('filtered list shortens the hit rect', () => {
    const items = CONTEXT_MENU_ITEMS.filter((i) => i.chamberType !== ChamberType.Queen);
    expect(isInsideContextMenu(AX + 1, AY + 47, AX, AY, items)).toBe(true); // inside 48px
    expect(isInsideContextMenu(AX + 1, AY + 48, AX, AY, items)).toBe(false); // now outside
    expect(isInsideContextMenu(AX + 1, AY + 60, AX, AY, items)).toBe(false);
  });
});

describe('itemLabelPos', () => {
  it('pads 6px from the left edge', () => {
    const pos = itemLabelPos(0, 100, 200);
    expect(pos.x).toBe(106);
  });

  it('stacks vertically by ITEM_HEIGHT', () => {
    const p0 = itemLabelPos(0, 100, 200);
    const p1 = itemLabelPos(1, 100, 200);
    const p2 = itemLabelPos(2, 100, 200);
    expect(p1.y - p0.y).toBe(CONTEXT_MENU.ITEM_HEIGHT);
    expect(p2.y - p1.y).toBe(CONTEXT_MENU.ITEM_HEIGHT);
  });
});

describe('drawContextMenuGeometry', () => {
  it('emits one background fillRect + 3 stripe fillRects (full list)', () => {
    const g = new MockGfx();
    drawContextMenuGeometry(g, 100, 200);
    const rects = g.calls.filter((c) => c.method === 'fillRect');
    expect(rects.length).toBe(4); // 1 bg + 3 stripes
    expect(rects[0]!.args).toEqual([100, 200, CONTEXT_MENU.WIDTH, CONTEXT_MENU_HEIGHT]);
  });

  it('uses the CONTEXT_MENU_ITEMS stripeColor for each stripe (in order)', () => {
    const g = new MockGfx();
    drawContextMenuGeometry(g, 0, 0);
    const fillStyles = g.calls.filter((c) => c.method === 'fillStyle');
    // 1 bg + 3 stripes = 4 fillStyle calls
    expect(fillStyles[1]!.args[0]).toBe(CONTEXT_MENU_ITEMS[0]!.stripeColor);
    expect(fillStyles[2]!.args[0]).toBe(CONTEXT_MENU_ITEMS[1]!.stripeColor);
    expect(fillStyles[3]!.args[0]).toBe(CONTEXT_MENU_ITEMS[2]!.stripeColor);
  });

  it('filtered list → fewer stripes + shorter background', () => {
    const g = new MockGfx();
    const items = CONTEXT_MENU_ITEMS.filter((i) => i.chamberType !== ChamberType.Queen);
    drawContextMenuGeometry(g, 0, 0, items);
    const rects = g.calls.filter((c) => c.method === 'fillRect');
    expect(rects.length).toBe(3); // 1 bg + 2 stripes
    // background height matches filtered height
    expect(rects[0]!.args).toEqual([0, 0, CONTEXT_MENU.WIDTH, 48]);
  });
});

describe('visibleContextMenuItems', () => {
  it('returns all three when colony has no Queen chamber (completed or pending)', () => {
    const world = makeWorld();
    const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
    world.colonies[PLAYER_COLONY_ID] = colony;
    const items = visibleContextMenuItems(colony, world);
    expect(items.length).toBe(3);
    expect(items.map((i) => i.chamberType)).toEqual([
      ChamberType.Queen,
      ChamberType.Nursery,
      ChamberType.FoodStorage,
    ]);
  });

  it('drops Queen when a completed Queen chamber exists', () => {
    const world = makeWorld();
    const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
    colony.chambers.push(makeQueenChamber());
    world.colonies[PLAYER_COLONY_ID] = colony;
    const items = visibleContextMenuItems(colony, world);
    expect(items.length).toBe(2);
    expect(items.map((i) => i.chamberType)).toEqual([ChamberType.Nursery, ChamberType.FoodStorage]);
  });

  it('drops Queen when a pending Queen chamber exists for this colony', () => {
    const world = makeWorld();
    const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
    world.colonies[PLAYER_COLONY_ID] = colony;
    world.pendingChambers[`${PLAYER_COLONY_ID}:10:5`] = {
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.Queen,
      anchorTileX: 10,
      anchorTileY: 5,
      width: 5,
      height: 3,
    };
    const items = visibleContextMenuItems(colony, world);
    expect(items.map((i) => i.chamberType)).toEqual([ChamberType.Nursery, ChamberType.FoodStorage]);
  });

  it('does NOT drop Queen when only another colony has a pending Queen chamber', () => {
    const world = makeWorld();
    const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
    world.colonies[PLAYER_COLONY_ID] = colony;
    world.pendingChambers[`99:10:5`] = {
      colonyId: 99,
      chamberType: ChamberType.Queen,
      anchorTileX: 10,
      anchorTileY: 5,
      width: 5,
      height: 3,
    };
    const items = visibleContextMenuItems(colony, world);
    expect(items.length).toBe(3);
  });

  it('multiple FoodStorage chambers do NOT remove the FoodStorage option', () => {
    const world = makeWorld();
    const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
    colony.chambers.push(
      {
        chamberId: 2,
        chamberType: ChamberType.FoodStorage,
        foodStored: 0,
        posX: 0,
        posY: 0,
        width: 4,
        height: 3,
      },
      {
        chamberId: 3,
        chamberType: ChamberType.FoodStorage,
        foodStored: 0,
        posX: 0,
        posY: 0,
        width: 4,
        height: 3,
      },
    );
    world.colonies[PLAYER_COLONY_ID] = colony;
    const items = visibleContextMenuItems(colony, world);
    expect(items.map((i) => i.chamberType)).toContain(ChamberType.FoodStorage);
    expect(items.length).toBe(3); // Queen still present, Nursery still present
  });

  it('Nursery unchanged: still present regardless of nursery state (policy undecided)', () => {
    const world = makeWorld();
    const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
    colony.chambers.push({
      chamberId: 4,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 0,
      posY: 0,
      width: 4,
      height: 3,
    });
    world.colonies[PLAYER_COLONY_ID] = colony;
    const items = visibleContextMenuItems(colony, world);
    expect(items.map((i) => i.chamberType)).toContain(ChamberType.Nursery);
  });
});
