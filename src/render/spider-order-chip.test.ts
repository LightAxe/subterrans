// spider-order-chip.test.ts — #400: the HUD's spider-order chip (visibility, the
// clear command, and its framed background).

import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { tickSpider } from '../sim/spider.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import type { WorldState } from '../sim/types.js';
import type { GfxLike } from './draw-surface.js';
import { SPIDER_PRIORITY_COMMITTED_COLOR, SPIDER_PRIORITY_QUEUED_COLOR } from './draw-surface.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';
import { handleSurfaceCommandTap } from '../input/surface-input.js';
import {
  SPIDER_ORDER_BORDER_PX,
  SPIDER_ORDER_FILL,
  SPIDER_ORDER_LABEL,
  drawSpiderOrderChip,
  spiderOrderChipVisible,
  spiderOrderClearCommand,
} from './spider-order-chip.js';

const hud = buildHudLayout(DEFAULT_LAYOUT);

/** A fresh world with the player's spider order applied by a real tick. */
function withOrder(): WorldState {
  const w = createScenario(3, 'Normal');
  tick(w, [
    { type: 'MarkSpiderPriority', colonyId: PLAYER_COLONY_ID, isPriority: true, issuedAtTick: 0 },
  ]);
  expect(w.spiderPriorityColonyId).toBe(PLAYER_COLONY_ID);
  return w;
}

describe('#400 spiderOrderChipVisible', () => {
  it('is up while the player’s spider order is in force, and only then', () => {
    const w = createScenario(3, 'Normal');
    expect(spiderOrderChipVisible(w, PLAYER_COLONY_ID)).toBe(false);
    const on = withOrder();
    expect(spiderOrderChipVisible(on, PLAYER_COLONY_ID)).toBe(true);
    // Another colony's order is not the player's.
    expect(spiderOrderChipVisible(on, ENEMY_COLONY_ID)).toBe(false);
  });

  it('stays up when the spider eats (V70 dropped the order at its next meal)', () => {
    const w = withOrder();
    // Staged: the spider just made a kill with no fighter next to it — it goes off
    // to eat (the meal that ended a V70 order).
    const spider = w.spider!;
    spider.state = 'Chasing';
    spider.killedThisTick = 1;
    spider.hungerTicks = 1500;
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    w.tick = 5000;
    tickSpider(w);
    expect(w.spider!.state).toBe('Feeding');
    expect(spiderOrderChipVisible(w, PLAYER_COLONY_ID)).toBe(true);
  });

  it('goes with the spider: no spider, no chip', () => {
    const w = withOrder();
    w.spider = null;
    expect(spiderOrderChipVisible(w, PLAYER_COLONY_ID)).toBe(false);
  });

  it('folds in a queued order (paused): a queued ON shows it, a queued OFF hides it', () => {
    const off = createScenario(3, 'Normal');
    // A Command tap on the spider while paused only queues the order.
    expect(handleSurfaceCommandTap(off, 0, 0, true, true, PLAYER_COLONY_ID)).toBe(false);
    expect(off.spiderPriorityColonyId).toBeNull();
    expect(spiderOrderChipVisible(off, PLAYER_COLONY_ID)).toBe(true);

    const on = withOrder();
    const clear = spiderOrderClearCommand(on, PLAYER_COLONY_ID)!;
    on.commandQueue.push(clear);
    expect(on.spiderPriorityColonyId).toBe(PLAYER_COLONY_ID); // still live…
    expect(spiderOrderChipVisible(on, PLAYER_COLONY_ID)).toBe(false); // …but called off
  });
});

describe('#400 spiderOrderClearCommand', () => {
  it('is the player’s MarkSpiderPriority off, stamped with the tick', () => {
    const w = withOrder();
    expect(spiderOrderClearCommand(w, PLAYER_COLONY_ID)).toEqual({
      type: 'MarkSpiderPriority',
      colonyId: PLAYER_COLONY_ID,
      isPriority: false,
      issuedAtTick: w.tick,
    });
  });

  it('sends nothing when there is nothing to call off — including a second click while paused', () => {
    expect(spiderOrderClearCommand(createScenario(3, 'Normal'), PLAYER_COLONY_ID)).toBeNull();
    const w = withOrder();
    w.commandQueue.push(spiderOrderClearCommand(w, PLAYER_COLONY_ID)!);
    expect(spiderOrderClearCommand(w, PLAYER_COLONY_ID)).toBeNull();
  });

  it('applied by tick(), it ends the order', () => {
    const w = withOrder();
    tick(w, [spiderOrderClearCommand(w, PLAYER_COLONY_ID)!]);
    expect(w.spiderPriorityColonyId).toBeNull();
    expect(spiderOrderChipVisible(w, PLAYER_COLONY_ID)).toBe(false);
  });
});

describe('#400 drawSpiderOrderChip', () => {
  type Op = { color: number; x: number; y: number; w: number; h: number };
  function record(): { gfx: GfxLike; ops: Op[] } {
    const ops: Op[] = [];
    let color = -1;
    const gfx = {
      clear: () => gfx,
      fillStyle: (c: number) => {
        color = c;
        return gfx;
      },
      lineStyle: () => gfx,
      fillRect: (x: number, y: number, w: number, h: number) => {
        ops.push({ color, x, y, w, h });
        return gfx;
      },
      fillCircle: () => gfx,
      strokeCircle: () => gfx,
      fillTriangle: () => gfx,
    } as GfxLike;
    return { gfx, ops };
  }

  it('fills the rect, then frames it in the spider mark’s committed border colour, inside the rect', () => {
    const r = hud.SPIDER_ORDER;
    const { gfx, ops } = record();
    drawSpiderOrderChip(gfx, r);
    expect(ops[0]).toEqual({ color: SPIDER_ORDER_FILL, x: r.x, y: r.y, w: r.w, h: r.h });
    const border = ops.slice(1);
    expect(border).toHaveLength(4);
    for (const o of border) {
      expect(o.color).toBe(SPIDER_PRIORITY_COMMITTED_COLOR);
      expect(o.x).toBeGreaterThanOrEqual(r.x);
      expect(o.y).toBeGreaterThanOrEqual(r.y);
      expect(o.x + o.w).toBeLessThanOrEqual(r.x + r.w);
      expect(o.y + o.h).toBeLessThanOrEqual(r.y + r.h);
      expect(Math.min(o.w, o.h)).toBe(SPIDER_ORDER_BORDER_PX);
    }
    // The four edges: top, bottom, left, right.
    const b = SPIDER_ORDER_BORDER_PX;
    // A queued order (paused, not yet applied) is framed in the queued colour, as
    // the world mark round the spider is.
    const queued = record();
    drawSpiderOrderChip(queued.gfx, r, true);
    expect(queued.ops.slice(1).map((o) => o.color)).toEqual(
      Array(4).fill(SPIDER_PRIORITY_QUEUED_COLOR),
    );
    expect(border).toEqual([
      { color: SPIDER_PRIORITY_COMMITTED_COLOR, x: r.x, y: r.y, w: r.w, h: b },
      { color: SPIDER_PRIORITY_COMMITTED_COLOR, x: r.x, y: r.y + r.h - b, w: r.w, h: b },
      { color: SPIDER_PRIORITY_COMMITTED_COLOR, x: r.x, y: r.y + b, w: b, h: r.h - 2 * b },
      {
        color: SPIDER_PRIORITY_COMMITTED_COLOR,
        x: r.x + r.w - b,
        y: r.y + b,
        w: b,
        h: r.h - 2 * b,
      },
    ]);
  });

  it('the label is the action, short enough for the toggle column', () => {
    expect(SPIDER_ORDER_LABEL).toBe('Call off spider');
    // 12px Courier is ~7.2px a glyph; the column holds 'Enemy Colony [X]' (16).
    expect(SPIDER_ORDER_LABEL.length).toBeLessThanOrEqual(16);
  });
});
