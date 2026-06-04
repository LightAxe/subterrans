import { describe, it, expect } from 'vitest';
import {
  saveLoadDialogItems,
  formatSaveInfoLine,
  formatSaveTime,
  dialogTitle,
  firstButtonY,
  itemAt,
  CANVAS_W,
  DIALOG_BUTTON_W,
  DIALOG_BUTTON_H,
  DIALOG_BUTTON_GAP,
  type SaveLoadDialogContext,
} from './save-load-dialog-layout.js';
import type { SaveInfo } from '../platform/save.js';

const baseCtx: SaveLoadDialogContext = {
  hasCompatibleSave: false,
  hasIncompatibleSave: false,
  confirming: { delete: false, newGame: false },
};

describe('saveLoadDialogItems', () => {
  it('returns 5 items in the documented order', () => {
    const items = saveLoadDialogItems(baseCtx);
    expect(items.map((i) => i.id)).toEqual(['continue', 'save-now', 'delete', 'new-game', 'back']);
  });

  it('Continue is disabled when there is no compatible save', () => {
    const items = saveLoadDialogItems(baseCtx);
    expect(items.find((i) => i.id === 'continue')!.enabled).toBe(false);
  });

  it('Continue is enabled when a compatible save exists', () => {
    const items = saveLoadDialogItems({ ...baseCtx, hasCompatibleSave: true });
    expect(items.find((i) => i.id === 'continue')!.enabled).toBe(true);
  });

  it('Delete is disabled when nothing exists in storage', () => {
    const items = saveLoadDialogItems(baseCtx);
    expect(items.find((i) => i.id === 'delete')!.enabled).toBe(false);
  });

  it('Delete is enabled when an incompatible save needs to be cleared (issue #66 path)', () => {
    const items = saveLoadDialogItems({
      ...baseCtx,
      hasCompatibleSave: false,
      hasIncompatibleSave: true,
    });
    expect(items.find((i) => i.id === 'delete')!.enabled).toBe(true);
  });

  it('Delete row swaps to "click to confirm" when confirming.delete is set', () => {
    const items = saveLoadDialogItems({
      ...baseCtx,
      hasCompatibleSave: true,
      confirming: { delete: true, newGame: false },
    });
    const del = items.find((i) => i.id === 'delete')!;
    expect(del.label.toLowerCase()).toContain('confirm');
    expect(del.confirming).toBe(true);
  });

  it('New Game does NOT show confirm when no save exists (no progress at risk)', () => {
    const items = saveLoadDialogItems({
      ...baseCtx,
      hasCompatibleSave: false,
      confirming: { delete: false, newGame: true },
    });
    const ng = items.find((i) => i.id === 'new-game')!;
    expect(ng.label.toLowerCase()).not.toContain('confirm');
  });

  it('New Game shows confirm when a save exists and confirming.newGame is set', () => {
    const items = saveLoadDialogItems({
      ...baseCtx,
      hasCompatibleSave: true,
      confirming: { delete: false, newGame: true },
    });
    const ng = items.find((i) => i.id === 'new-game')!;
    expect(ng.label.toLowerCase()).toContain('confirm');
  });

  it('every button has the documented w×h dimensions', () => {
    const items = saveLoadDialogItems(baseCtx);
    for (const i of items) {
      expect(i.rect.w).toBe(DIALOG_BUTTON_W);
      expect(i.rect.h).toBe(DIALOG_BUTTON_H);
    }
  });

  it('buttons stack vertically with the documented gap', () => {
    const items = saveLoadDialogItems(baseCtx);
    for (let i = 1; i < items.length; i++) {
      const prevBottom = items[i - 1]!.rect.y + items[i - 1]!.rect.h;
      const currTop = items[i]!.rect.y;
      expect(currTop - prevBottom).toBe(DIALOG_BUTTON_GAP);
    }
  });

  it('buttons are horizontally centered on the canvas', () => {
    const items = saveLoadDialogItems(baseCtx);
    for (const i of items) {
      expect(i.rect.x + i.rect.w / 2).toBeCloseTo(CANVAS_W / 2, 5);
    }
  });

  it('first button starts at firstButtonY()', () => {
    const items = saveLoadDialogItems(baseCtx);
    expect(items[0]!.rect.y).toBe(firstButtonY());
  });
});

describe('formatSaveInfoLine', () => {
  it('formats a fresh save with timestamp + tick + workers + food (issue #115)', () => {
    const info: SaveInfo = {
      tick: 42,
      playerWorkers: 12,
      playerFoodStored: 1500,
      // 2026-01-15 09:30 local — the formatter uses local time, so we don't
      // assert exact HH:MM strings (would be flaky across CI timezones).
      savedAtMs: new Date(2026, 0, 15, 9, 30, 0).getTime(),
    };
    const line = formatSaveInfoLine(info, false);
    expect(line.toLowerCase()).toContain('saved');
    expect(line).toContain('42');
    expect(line).toContain('12');
    expect(line).toContain('1500');
  });

  it('uses the "—" placeholder when savedAtMs is 0 (pre-issue-#115 envelope)', () => {
    const info: SaveInfo = { tick: 5, playerWorkers: 0, playerFoodStored: 0, savedAtMs: 0 };
    const line = formatSaveInfoLine(info, false);
    // Should still render a Saved prefix with the placeholder, not crash.
    expect(line).toContain('—');
  });

  it('shows the incompatible-save warning when there is no SaveInfo and bytes are unreadable', () => {
    const line = formatSaveInfoLine(null, true);
    expect(line.toLowerCase()).toContain('incompatible');
  });

  it('shows "no save in storage" when there is no SaveInfo and no bytes at all', () => {
    const line = formatSaveInfoLine(null, false);
    expect(line.toLowerCase()).toContain('no save');
  });

  it('round-3 (Codex P2): warning wins over SaveInfo when the save is incompatible (future-sim case)', () => {
    // A future-sim save has a parseable envelope (so getSaveInfo returns
    // non-null) AND fails compatibility (hasIncompatibleSave === true).
    // The dialog disables Continue; the info line must agree by showing
    // the warning, NOT the saved-line — otherwise the player sees
    // "Saved 14:30..." next to a grayed-out Continue and is confused.
    const info: SaveInfo = {
      tick: 100,
      playerWorkers: 5,
      playerFoodStored: 200,
      savedAtMs: Date.now(),
    };
    const line = formatSaveInfoLine(info, true);
    expect(line.toLowerCase()).toContain('incompatible');
    expect(line).not.toContain('Saved');
  });
});

describe('formatSaveTime', () => {
  it('returns "—" for 0 (unknown / pre-issue-#115 envelope)', () => {
    expect(formatSaveTime(0)).toBe('—');
  });

  it('returns "—" for negative values (defensive against tampered envelopes)', () => {
    expect(formatSaveTime(-1)).toBe('—');
  });

  it('formats a positive epoch ms as zero-padded HH:MM in local time', () => {
    const ts = new Date(2026, 4, 11, 7, 5).getTime(); // 07:05 local
    expect(formatSaveTime(ts)).toBe('07:05');
  });

  it('handles late-night times correctly (no AM/PM rollover surprise)', () => {
    const ts = new Date(2026, 4, 11, 23, 59).getTime();
    expect(formatSaveTime(ts)).toBe('23:59');
  });

  it('returns "—" for huge values that construct an Invalid Date (round-2 review: tampered envelope guard)', () => {
    // new Date(1e100) is Invalid Date. Without the NaN guard the formatter
    // would produce "NaN:NaN" in the dialog. Round-2 review caught this as
    // a tampered-envelope leakage path.
    expect(formatSaveTime(1e100)).toBe('—');
  });

  it('returns "—" for NaN (defensive against tampered finite-but-NaN values)', () => {
    expect(formatSaveTime(Number.NaN)).toBe('—');
  });
});

describe('dialogTitle', () => {
  it('returns "Save / Load"', () => {
    expect(dialogTitle()).toBe('Save / Load');
  });
});

describe('itemAt', () => {
  it('returns the item whose rect contains the pointer', () => {
    const items = saveLoadDialogItems({ ...baseCtx, hasCompatibleSave: true });
    const r = items[1]!.rect;
    const hit = itemAt(items, r.x + 5, r.y + 5);
    expect(hit?.id).toBe(items[1]!.id);
  });

  it('returns null when the pointer is outside every rect', () => {
    const items = saveLoadDialogItems({ ...baseCtx, hasCompatibleSave: true });
    expect(itemAt(items, 0, 0)).toBeNull();
  });

  it('skips disabled items', () => {
    const items = saveLoadDialogItems(baseCtx); // Continue and Delete disabled
    const continueItem = items.find((i) => i.id === 'continue')!;
    expect(itemAt(items, continueItem.rect.x + 5, continueItem.rect.y + 5)).toBeNull();
  });
});
