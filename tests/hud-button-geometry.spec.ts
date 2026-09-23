// hud-button-geometry.spec.ts — #320: every HUD button label paints INSIDE the
// click rect that owns it, measured in the real renderer with the real font.
//
// A HUD Text that paints its own background is sized by its TEXT, not by the
// HudLayout rect that the click handler hit-tests and isPointerOverHUD masks.
// When a label outgrows its rect the visible pill spills into a band no HUD zone
// covers, and a click on what looks like the button falls through as a WORLD
// click — a dig or command order. VIEW_TOGGLE shipped 26px over. Glyph widths
// are a property of the font, and CI's Linux resolves Courier differently from
// macOS, so this measures a running game instead of reasoning about metrics.
//
// Every label variant is visited: each toggle is sampled in both of its states.

import { test, expect, type Page } from '@playwright/test';
import type { HudButtonGeometry } from '../src/render/hud-controls.js';
import { CONTEXT_MENU, CONTEXT_MENU_ITEMS } from '../src/render/context-menu-layout.js';
import { activeView, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { COLONY_TOGGLE_RECT, TOOL_BUTTON_RECTS } from './helpers/geometry.js';

/** Sub-pixel slack for float bounds. Far below any real overhang (#320's was 26px). */
const EPS = 0.01;

async function geometry(page: Page): Promise<HudButtonGeometry[]> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __phase9_test?: { getHudButtonGeometry?: () => HudButtonGeometry[] };
    };
    return w.__phase9_test?.getHudButtonGeometry?.() ?? [];
  });
}

async function labelOf(page: Page, id: string): Promise<string> {
  return (await geometry(page)).find((g) => g.id === id)?.text ?? '<missing>';
}

async function uiField(
  page: Page,
  field: 'alarmActive' | 'activeUndergroundLabel',
): Promise<unknown> {
  return await page.evaluate(
    (f) => (window as unknown as { __phase9_ui?: Record<string, unknown> }).__phase9_ui?.[f],
    field,
  );
}

/** RGBA bytes of a w×h canvas area, as rendered on the next frame. */
async function sampleArea(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<number[]> {
  return await page.evaluate(
    ([ax, ay, aw, ah]) => {
      const t = (
        window as unknown as {
          __phase9_test?: {
            sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
          };
        }
      ).__phase9_test;
      if (t?.sampleArea === undefined) throw new Error('__phase9_test.sampleArea is not installed');
      return t.sampleArea(ax, ay, aw, ah);
    },
    [x, y, w, h] as const,
  );
}

const box = (r: { x: number; y: number; w: number; h: number }): string =>
  `x ${r.x.toFixed(2)}..${(r.x + r.w).toFixed(2)}  y ${r.y.toFixed(2)}..${(r.y + r.h).toFixed(2)}`;

/** Assert every VISIBLE label paints inside its click rect and is not clipped by
 *  it. Returns the visible labels so the caller can track variant coverage. */
async function expectAllInside(page: Page, state: string): Promise<HudButtonGeometry[]> {
  const all = await geometry(page);
  expect(all.length, 'the __phase9_test geometry hook returned nothing').toBeGreaterThan(0);
  const visible = all.filter((g) => g.visible);
  for (const g of visible) {
    const { rect: r, painted: p, content: c } = g;
    const where = `[${state}] ${g.id} "${g.text}": painted ${box(p)}, click rect ${box(r)}`;
    // Nothing painted outside the click rect — the #320 fall-through band.
    expect(p.x, where).toBeGreaterThanOrEqual(r.x - EPS);
    expect(p.y, where).toBeGreaterThanOrEqual(r.y - EPS);
    expect(p.x + p.w, where).toBeLessThanOrEqual(r.x + r.w + EPS);
    expect(p.y + p.h, where).toBeLessThanOrEqual(r.y + r.h + EPS);
    // And nothing clipped: a label pinned to its rect that is too long for it is
    // cut off instead of spilling, which is a different visible defect.
    const clip = `[${state}] ${g.id} "${g.text}" needs ${c.w.toFixed(2)}×${c.h.toFixed(2)}, paints ${p.w.toFixed(2)}×${p.h.toFixed(2)}`;
    expect(c.w, clip).toBeLessThanOrEqual(p.w + EPS);
    expect(c.h, clip).toBeLessThanOrEqual(p.h + EPS);
  }
  return visible;
}

/** Start a round, switch to the underground view, and pause (so nothing changes
 *  the tile under a right-click). */
async function bootUnderground(page: Page): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await settleToPlaying(page);
  await page.keyboard.press('Tab');
  await expect.poll(() => activeView(page)).toBe('underground');
  await page.keyboard.press(' ');
}

/**
 * Open the chamber menu so the text-free right end of its FIRST row lies over
 * `probe` (a patch of HUD label glyphs inside `owner`, the label's click rect),
 * then assert every probed pixel is that row's stripe: nothing of the HUD
 * control — no label glyph, no background — is drawn over the open menu. The first
 * row's item label ends well short of WIDTH - 19, so the probe sees only stripe.
 */
async function expectMenuDrawnOver(
  page: Page,
  probe: { x: number; y: number; w: number; h: number },
  owner: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const anchor = { x: probe.x - (CONTEXT_MENU.WIDTH - 19), y: probe.y - 8 };
  // The probe must sit inside the control's click rect and the menu's first row
  // (stripe inset 2px), right of every menu item label.
  expect(probe.x).toBeGreaterThanOrEqual(owner.x);
  expect(probe.x + probe.w).toBeLessThanOrEqual(owner.x + owner.w);
  expect(probe.y).toBeGreaterThanOrEqual(owner.y);
  expect(probe.y + probe.h).toBeLessThanOrEqual(owner.y + owner.h);
  expect(probe.y).toBeGreaterThanOrEqual(anchor.y + 2);
  expect(probe.y + probe.h).toBeLessThanOrEqual(anchor.y + CONTEXT_MENU.ITEM_HEIGHT - 2);
  expect(probe.x + probe.w).toBeLessThanOrEqual(anchor.x + CONTEXT_MENU.WIDTH - 2);

  const before = await sampleArea(page, probe.x, probe.y, probe.w, probe.h);
  // The probe must actually contain label ink before the menu opens, or the
  // test is vacuous: a plain button background turning into plain stripe would
  // pass even with the menu drawn UNDER the labels. Ink = more than one colour.
  const beforeColours = new Set<string>();
  for (let i = 0; i < before.length; i += 4) beforeColours.add(before.slice(i, i + 3).join(','));
  expect(beforeColours.size, 'the probe misses the label glyphs it should cover').toBeGreaterThan(
    1,
  );
  const canvasBox = await page.locator('canvas').first().boundingBox();
  if (!canvasBox) throw new Error('canvas has no bounding box');
  await page.mouse.click(canvasBox.x + anchor.x, canvasBox.y + anchor.y, { button: 'right' });
  // The menu is up once the first row's label-free left edge shows one of the
  // menu's own stripe colours. Matching the known colours (rather than "the
  // pixel changed") keeps the signal independent of the unseeded terrain under
  // the anchor; which row-0 item shows depends on colony state, hence the set.
  const stripeColours = new Set(
    CONTEXT_MENU_ITEMS.map((item) =>
      [
        (item.stripeColor >> 16) & 0xff,
        (item.stripeColor >> 8) & 0xff,
        item.stripeColor & 0xff,
      ].join(','),
    ),
  );
  let want = '';
  await expect
    .poll(
      async () => {
        want = (await sampleArea(page, anchor.x + 4, anchor.y + 12, 1, 1)).slice(0, 3).join(',');
        return want;
      },
      { message: 'the chamber menu never opened at the probe anchor' },
    )
    // A matcher that prints the colour it saw when it times out.
    .toMatch(new RegExp(`^(${[...stripeColours].join('|')})$`));

  const after = await sampleArea(page, probe.x, probe.y, probe.w, probe.h);
  const offStripe: string[] = [];
  for (let i = 0; i < after.length; i += 4) {
    const px = after.slice(i, i + 3).join(',');
    if (px !== want) offStripe.push(`(${(i / 4) % probe.w},${Math.floor(i / 4 / probe.w)})=${px}`);
  }
  expect(offStripe, `probe pixels not the menu stripe ${want}`).toEqual([]);
}

test.describe('#320 — HUD button labels stay inside their click rects', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* private-mode / blocked storage — the boot path handles it */
      }
    });
  });

  test('every label variant of every HUD button, on both views', async ({ page }) => {
    await page.goto('/');
    await waitForUiHook(page);
    await settleToPlaying(page);

    const seen = new Map<string, Set<string>>();
    const record = (labels: HudButtonGeometry[]): void => {
      for (const g of labels) {
        const texts = seen.get(g.id) ?? new Set<string>();
        texts.add(g.text);
        seen.set(g.id, texts);
      }
    };

    // 1. Surface, alarm off.
    await expect.poll(() => activeView(page)).toBe('surface');
    await expect.poll(() => uiField(page, 'alarmActive')).toBe(false);
    record(await expectAllInside(page, 'surface, alarm off'));

    // 2. Alarm on — its other label.
    const alarmOff = await labelOf(page, 'alarm-toggle');
    await page.keyboard.press('r');
    await expect.poll(() => uiField(page, 'alarmActive')).toBe(true);
    await expect.poll(() => labelOf(page, 'alarm-toggle')).not.toBe(alarmOff);
    record(await expectAllInside(page, 'surface, alarm on'));

    // 3. Underground — the view toggle's other label, and the colony toggle
    //    (drawn on this view only) in its first state.
    const surfaceView = await labelOf(page, 'view-toggle');
    await page.keyboard.press('Tab');
    await expect.poll(() => activeView(page)).toBe('underground');
    await expect.poll(() => labelOf(page, 'view-toggle')).not.toBe(surfaceView);
    record(await expectAllInside(page, 'underground, own colony'));

    // 4. The colony toggle's other label.
    const ownColony = await labelOf(page, 'colony-toggle');
    await page.keyboard.press('x');
    await expect.poll(() => uiField(page, 'activeUndergroundLabel')).toBe('Enemy Colony');
    await expect.poll(() => labelOf(page, 'colony-toggle')).not.toBe(ownColony);
    record(await expectAllInside(page, 'underground, enemy colony'));

    // Coverage: each toggle was measured in BOTH of its states, and every tool and
    // speed button was measured at least once. Asserted from what was actually
    // sampled, so a walk that silently stopped reaching a state fails here.
    for (const id of ['view-toggle', 'alarm-toggle', 'colony-toggle']) {
      expect(seen.get(id)?.size ?? 0, `${id} variants measured`).toBe(2);
    }
    for (const id of [
      'tool:command',
      'tool:dig',
      'tool:chamber',
      'speed:pause',
      'speed:1',
      'speed:2',
      'speed:4',
    ]) {
      expect(seen.has(id), `${id} measured`).toBe(true);
    }
  });

  // The mismatch in reverse. The chamber menu used to be drawn into the shared
  // depth-0 HUD Graphics, which every HUD label renders above: the depth-0 toggle
  // labels because they are created after it, the tool / hint / speed labels
  // because they sit at depth 5. The click handler gives an open menu priority,
  // so a label painted over the menu while a click there went to the menu row
  // beneath it. The menu now has its own layer above every HUD label; the two
  // cases below cover one label of each depth.

  test('an open chamber menu is drawn over a toggle label (depth 0)', async ({ page }) => {
    await bootUnderground(page);
    await expect.poll(() => labelOf(page, 'colony-toggle')).toContain('Your Colony');
    // Probe the end of "Your Colony" ("ny") inside the colony toggle.
    const t = COLONY_TOGGLE_RECT;
    await expectMenuDrawnOver(page, { x: t.x + 69, y: t.y + 5, w: 16, h: 12 }, t);
  });

  test('an open chamber menu is drawn over a tool label (depth 5)', async ({ page }) => {
    await bootUnderground(page);
    // Probe the second tool button's label ("Dig"), which UIScene draws at
    // (button.x + 4, button.y + button.h / 2 - 6).
    const b = TOOL_BUTTON_RECTS[1]!;
    await expectMenuDrawnOver(page, { x: b.x + 4, y: b.y + b.h / 2 - 6, w: 16, h: 11 }, b);
  });
});
