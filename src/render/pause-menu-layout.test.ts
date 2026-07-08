import { describe, it, expect } from 'vitest';
import {
  pauseMenuItems as pauseMenuItemsAt,
  pageTitle,
  itemAt,
  nextSpeedMultiplier,
  PAUSE_MENU_BUTTON_W,
  PAUSE_MENU_BUTTON_H,
  PAUSE_MENU_BUTTON_GAP,
  type PauseMenuPage,
  type PauseMenuRenderContext,
  type MenuItemRect,
} from './pause-menu-layout.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';
import { CANVAS_W, CANVAS_H } from './sprites.js';
// (DEFAULT_SETTINGS no longer imported — ctx now uses in-memory boolean
// for currentPheromoneOverlay instead of a full Settings snapshot.)

// Issue #213: pauseMenuItems now takes a LayoutContext. The existing geometry
// tests assert parity at the fixed default layout (800×592); bind it here so the
// call sites stay focused on item composition. The seam describe at the bottom
// exercises a non-default LayoutContext.
const pauseMenuItems = (page: PauseMenuPage, c: PauseMenuRenderContext) =>
  pauseMenuItemsAt(page, c, DEFAULT_LAYOUT);

const ctx: PauseMenuRenderContext = {
  saveLoadEnabled: true,
  currentPheromoneOverlay: true,
  currentHintStripVisible: true,
  currentSpeedMultiplier: 1,
  quitAndSurveyEnabled: false,
};

describe('pauseMenuItems — main page', () => {
  it('returns 4 items in the documented order', () => {
    const items = pauseMenuItems('main', ctx);
    expect(items.map((i) => i.id)).toEqual(['resume', 'save-load', 'settings', 'debug-snapshot']);
  });

  it('Save/Load row is disabled when saveLoadEnabled=false (issue #115 not yet wired)', () => {
    const items = pauseMenuItems('main', { ...ctx, saveLoadEnabled: false });
    const saveLoad = items.find((i) => i.id === 'save-load')!;
    expect(saveLoad.enabled).toBe(false);
  });

  it('Save/Load row is enabled when saveLoadEnabled=true', () => {
    const items = pauseMenuItems('main', { ...ctx, saveLoadEnabled: true });
    expect(items.find((i) => i.id === 'save-load')!.enabled).toBe(true);
  });

  it('Quit & feedback row is hidden when quitAndSurveyEnabled=false (issue #122 default)', () => {
    const items = pauseMenuItems('main', { ...ctx, quitAndSurveyEnabled: false });
    expect(items.find((i) => i.id === 'quit-and-survey')).toBeUndefined();
    // The default-off path keeps the original 4-row main menu.
    expect(items).toHaveLength(4);
  });

  it('Quit & feedback row is emitted when quitAndSurveyEnabled=true (issue #122)', () => {
    const items = pauseMenuItems('main', { ...ctx, quitAndSurveyEnabled: true });
    const row = items.find((i) => i.id === 'quit-and-survey');
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    expect(items).toHaveLength(5);
    // Layout invariant: every row including the new one keeps the
    // documented w×h and the stack-gap (rebuilt against new item count).
    for (let i = 1; i < items.length; i++) {
      const prevBottom = items[i - 1]!.rect.y + items[i - 1]!.rect.h;
      const currTop = items[i]!.rect.y;
      expect(currTop - prevBottom).toBe(PAUSE_MENU_BUTTON_GAP);
    }
  });

  it('every button has the documented w×h dimensions', () => {
    const items = pauseMenuItems('main', ctx);
    for (const i of items) {
      expect(i.rect.w).toBe(PAUSE_MENU_BUTTON_W);
      expect(i.rect.h).toBe(PAUSE_MENU_BUTTON_H);
    }
  });

  it('buttons stack vertically with the documented gap', () => {
    const items = pauseMenuItems('main', ctx);
    for (let i = 1; i < items.length; i++) {
      const prevBottom = items[i - 1]!.rect.y + items[i - 1]!.rect.h;
      const currTop = items[i]!.rect.y;
      expect(currTop - prevBottom).toBe(PAUSE_MENU_BUTTON_GAP);
    }
  });

  it('buttons are horizontally centered on the canvas', () => {
    const items = pauseMenuItems('main', ctx);
    for (const i of items) {
      expect(i.rect.x + i.rect.w / 2).toBeCloseTo(CANVAS_W / 2, 5);
    }
  });

  it('vertical stack stays inside the canvas bounds', () => {
    const items = pauseMenuItems('main', ctx);
    expect(items[0]!.rect.y).toBeGreaterThanOrEqual(0);
    const lastBottom = items[items.length - 1]!.rect.y + items[items.length - 1]!.rect.h;
    expect(lastBottom).toBeLessThanOrEqual(CANVAS_H);
  });
});

describe('pauseMenuItems — settings page', () => {
  it('returns the pheromone, control-hints, reset-hints, speed, and back rows', () => {
    const items = pauseMenuItems('settings', ctx);
    expect(items.map((i) => i.id)).toEqual([
      'pheromone-toggle',
      'control-hints-toggle',
      'reset-first-use-hints',
      'speed-cycle',
      'back',
    ]);
  });

  it('control-hints toggle label reflects ON / OFF (Stage 3b)', () => {
    expect(
      pauseMenuItems('settings', { ...ctx, currentHintStripVisible: true }).find(
        (i) => i.id === 'control-hints-toggle',
      )!.label,
    ).toContain('ON');
    expect(
      pauseMenuItems('settings', { ...ctx, currentHintStripVisible: false }).find(
        (i) => i.id === 'control-hints-toggle',
      )!.label,
    ).toContain('OFF');
  });

  it('reset-first-use-hints row is present and enabled (Stage 3b)', () => {
    expect(
      pauseMenuItems('settings', ctx).find((i) => i.id === 'reset-first-use-hints')!.enabled,
    ).toBe(true);
  });

  it('pheromone toggle label reflects the current ON state', () => {
    const items = pauseMenuItems('settings', { ...ctx, currentPheromoneOverlay: true });
    expect(items.find((i) => i.id === 'pheromone-toggle')!.label).toContain('ON');
  });

  it('pheromone toggle label reflects the current OFF state', () => {
    const items = pauseMenuItems('settings', { ...ctx, currentPheromoneOverlay: false });
    expect(items.find((i) => i.id === 'pheromone-toggle')!.label).toContain('OFF');
  });

  it('speed-cycle label reflects the current speed multiplier', () => {
    expect(
      pauseMenuItems('settings', { ...ctx, currentSpeedMultiplier: 1 }).find(
        (i) => i.id === 'speed-cycle',
      )!.label,
    ).toContain('1×');
    expect(
      pauseMenuItems('settings', { ...ctx, currentSpeedMultiplier: 2 }).find(
        (i) => i.id === 'speed-cycle',
      )!.label,
    ).toContain('2×');
    expect(
      pauseMenuItems('settings', { ...ctx, currentSpeedMultiplier: 4 }).find(
        (i) => i.id === 'speed-cycle',
      )!.label,
    ).toContain('4×');
  });

  it('speed-cycle row is enabled', () => {
    expect(pauseMenuItems('settings', ctx).find((i) => i.id === 'speed-cycle')!.enabled).toBe(true);
  });
});

describe('pageTitle', () => {
  it('returns "Paused" for the main page', () => {
    expect(pageTitle('main')).toBe('Paused');
  });
  it('returns "Settings" for the settings page', () => {
    expect(pageTitle('settings')).toBe('Settings');
  });
});

describe('nextSpeedMultiplier — cycle 1→2→4→1', () => {
  it('1 → 2', () => {
    expect(nextSpeedMultiplier(1)).toBe(2);
  });
  it('2 → 4', () => {
    expect(nextSpeedMultiplier(2)).toBe(4);
  });
  it('4 → 1', () => {
    expect(nextSpeedMultiplier(4)).toBe(1);
  });
});

describe('itemAt', () => {
  it('returns the item whose rect contains the pointer', () => {
    const items = pauseMenuItems('main', ctx);
    const r = items[1]!.rect;
    const hit = itemAt(items, r.x + 5, r.y + 5);
    expect(hit?.id).toBe(items[1]!.id);
  });

  it('returns null when the pointer is outside every rect', () => {
    const items = pauseMenuItems('main', ctx);
    expect(itemAt(items, 0, 0)).toBeNull();
  });

  it('skips disabled items even when the pointer is inside their rect', () => {
    const items = pauseMenuItems('main', { ...ctx, saveLoadEnabled: false });
    const saveLoad = items.find((i) => i.id === 'save-load')!;
    expect(itemAt(items, saveLoad.rect.x + 5, saveLoad.rect.y + 5)).toBeNull();
  });
});

describe('pauseMenuItems — LayoutContext seam (issue #213)', () => {
  it('horizontally centers the buttons on the passed layout width, not a fixed 800', () => {
    const wide = createLayoutContext(1000, 700);
    for (const i of pauseMenuItemsAt('main', ctx, wide)) {
      expect(i.rect.x + i.rect.w / 2).toBeCloseTo(wide.w / 2, 5);
    }
  });

  it('shifts the vertical stack down on a taller layout', () => {
    const tall = createLayoutContext(CANVAS_W, CANVAS_H + 200);
    const def = pauseMenuItemsAt('main', ctx, DEFAULT_LAYOUT);
    const taller = pauseMenuItemsAt('main', ctx, tall);
    expect(taller[0]!.rect.y).toBeGreaterThan(def[0]!.rect.y);
  });
});

// ---------------------------------------------------------------------------
// Small-context regression fixtures (#238 PR4). Guard the PR1–3 LayoutContext
// reflow + the Phase 6 mobile work: at a phone-portrait 360×640 context every
// clickable rect must stay on-screen and none may overlap. These PASS today
// (verified in #238) — they exist to fail loudly if a future reflow regresses.
//
// Heights below ~490 need genuine reflow (scroll / re-order), NOT proportional
// row compression (which fails its own no-overlap test at real phone heights —
// see #238). That reflow is owned by Phase 6.
// ---------------------------------------------------------------------------

/** True iff rect r lies fully inside the 0..w × 0..h canvas. */
function within(r: MenuItemRect, w: number, h: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;
}

/** True iff any two rects overlap (strict — touching edges do not count). */
function anyOverlap(rects: readonly MenuItemRect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
}

describe('pause menu — small-context regression (#238 PR4, 360×640)', () => {
  const phone = createLayoutContext(360, 640);
  // The tallest stacks the layout produces: main (4), main + Quit (5), settings (5).
  const cases: Array<[string, MenuItemRect[]]> = [
    ['main', pauseMenuItemsAt('main', ctx, phone).map((i) => i.rect)],
    [
      'main+quit',
      pauseMenuItemsAt('main', { ...ctx, quitAndSurveyEnabled: true }, phone).map((i) => i.rect),
    ],
    ['settings', pauseMenuItemsAt('settings', ctx, phone).map((i) => i.rect)],
  ];

  for (const [name, rects] of cases) {
    it(`${name}: every interactive rect is within the 360×640 canvas`, () => {
      for (const r of rects) expect(within(r, 360, 640)).toBe(true);
    });
    it(`${name}: no interactive rects overlap`, () => {
      expect(anyOverlap(rects)).toBe(false);
    });
  }
});
