// snapshot-window.test.ts — the analyze-snapshot CLI's message for a snapshot outside
// this build's simVersion window (#407). Pre-1.0 a snapshot replays only on the build
// that recorded it, so every out-of-window case must name a build to check out. That
// includes an F9 export, which has no build id.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  latestLinePattern,
  registryNamePattern,
  snapshotWindowMessage,
} from './snapshot-window.js';
import { MIN_ACCEPTED_SIM_VERSION } from './save.js';
import { LATEST_SIM_VERSION } from '../sim/types.js';

const MIN = 50;
const LATEST = 68;

describe('snapshotWindowMessage (analyze-snapshot out-of-window guidance)', () => {
  it('is null for every simVersion this build can load, at both window edges', () => {
    for (let v = MIN; v <= LATEST; v++) {
      expect(snapshotWindowMessage(v, MIN, LATEST), `V${v}`).toBeNull();
    }
    expect(
      snapshotWindowMessage(MIN_ACCEPTED_SIM_VERSION, MIN_ACCEPTED_SIM_VERSION, LATEST_SIM_VERSION),
    ).toBeNull();
    expect(
      snapshotWindowMessage(LATEST_SIM_VERSION, MIN_ACCEPTED_SIM_VERSION, LATEST_SIM_VERSION),
    ).toBeNull();
  });

  it('just below MIN: names the playtrace sha and, for an F9 export, the last commit at that simVersion', () => {
    const msg = snapshotWindowMessage(MIN - 1, MIN, LATEST);
    expect(msg).not.toBeNull();
    expect(msg).toContain("simVersion 49, below this build's minimum (50)");
    expect(msg).toContain('replay only on the build that recorded them');
    expect(msg).toContain('run git fetch origin, then check out that sha');
    // The F9 fallback: the parent of the commit that first moved LATEST off V49,
    // searched in this checkout's own history (every older commit is an ancestor).
    expect(msg).toContain(
      `        c=$(git log --reverse --format=%h --pickaxe-regex -S 'LATEST_SIM_VERSION = (SIM_VERSION_V)?49[^0-9]' -- src/sim/types.ts | sed -n 2p)\n` +
        '        git checkout "${c:?no commit moved LATEST off V49}^"',
    );
  });

  it('just above LATEST: an F9 export gets a build to fetch and check out, not only a playtrace sha', () => {
    const msg = snapshotWindowMessage(LATEST + 1, MIN, LATEST);
    expect(msg).not.toBeNull();
    expect(msg).toContain("simVersion 69, newer than this build's LATEST (68)");
    expect(msg).toContain('run git fetch origin, then check out that sha');
    // F9 export, pinned as one block so no step can be dropped or reordered:
    //   1. fetch first;
    //   2. origin/main itself, but ONLY if its LATEST is V69 (checked first, so a
    //      reverted and re-landed V69 still resolves to the tip);
    //   3. else the parent of the commit that moved LATEST off V69 on origin/main;
    //   4. else (origin/main never reached V69) list the branch commits touching it.
    // Without the step-2 guard, a version origin/main never reached would check out a
    // build that refuses the snapshot again (CodeRabbit on #407).
    expect(msg).toContain(
      '        git fetch origin\n' +
        `        c=$(git log origin/main --reverse --format=%h --pickaxe-regex -S 'LATEST_SIM_VERSION = (SIM_VERSION_V)?69[^0-9]' -- src/sim/types.ts | sed -n 2p)\n` +
        "        if git grep -qE 'LATEST_SIM_VERSION = (SIM_VERSION_V)?69[^0-9]' origin/main -- src/sim/types.ts; then git checkout origin/main\n" +
        '        elif [ -n "$c" ]; then git checkout "$c^"\n' +
        "        else echo 'origin/main never reached V69; branch commits that touched SIM_VERSION_V69 (none listed? ask for the playtrace):'; git log --all --oneline --pickaxe-regex -S 'SIM_VERSION_V69[^0-9]' -- src/sim/types.ts; fi",
    );
    // Every checkout of origin/main is behind the LATEST check on the same line.
    const lines = (msg ?? '').split('\n');
    const tipCheckouts = lines.filter((l) => l.includes('git checkout origin/main'));
    expect(tipCheckouts).toHaveLength(1);
    expect(tipCheckouts[0]).toMatch(
      /^ {8}if git grep -qE 'LATEST_SIM_VERSION = \(SIM_VERSION_V\)\?69\[\^0-9\]' origin\/main -- src\/sim\/types\.ts; then git checkout origin\/main$/,
    );
    // The recording build is newer than this checkout, so the search must never be
    // over this checkout's own history.
    expect(msg).not.toContain('git log --reverse');
  });

  it('well above LATEST: every command names the snapshot version, not LATEST + 1', () => {
    const msg = snapshotWindowMessage(LATEST + 5, MIN, LATEST) ?? '';
    expect(msg).toContain("simVersion 73, newer than this build's LATEST (68)");
    for (const v of [
      '(SIM_VERSION_V)?73[^0-9]',
      "-S 'SIM_VERSION_V73[^0-9]'",
      'never reached V73',
    ]) {
      expect(msg).toContain(v);
    }
    expect(msg).not.toContain('V69');
  });

  it('missing or invalid simVersion: says so and does not invent a build', () => {
    for (const bad of [null, Number.NaN, 3.5]) {
      const msg = snapshotWindowMessage(bad, MIN, LATEST);
      expect(msg, String(bad)).toContain('missing or invalid simVersion');
      expect(msg, String(bad)).toContain('there is no build to point at');
      expect(msg, String(bad)).not.toContain('git checkout');
    }
  });
});

// The git searches only work if the patterns match every form the LATEST line and
// the registry names have taken (Codex on #407): the bare number at V3, suffixed names
// from V4, and an unsuffixed name like SIM_VERSION_V3. Each POSIX ERE here is also a
// valid JS RegExp, so the semantics are checked directly.
describe('latestLinePattern / registryNamePattern (every naming form, exact version)', () => {
  const latestLine = (n: number) => new RegExp(latestLinePattern(n));
  const registryName = (n: number) => new RegExp(registryNamePattern(n));

  it('matches the LATEST line in every historical and plausible form, for exactly that version', () => {
    expect(latestLine(3).test('export const LATEST_SIM_VERSION = 3 as const;')).toBe(true);
    expect(latestLine(3).test('export const LATEST_SIM_VERSION = SIM_VERSION_V3;')).toBe(true);
    expect(
      latestLine(69).test('export const LATEST_SIM_VERSION = SIM_VERSION_V69_FOOD_FAIRNESS;'),
    ).toBe(true);
    expect(latestLine(71).test('export const LATEST_SIM_VERSION = SIM_VERSION_V71;')).toBe(true);
    // Never a longer number that starts with the same digits.
    expect(latestLine(3).test('export const LATEST_SIM_VERSION = 30 as const;')).toBe(false);
    expect(
      latestLine(3).test('export const LATEST_SIM_VERSION = SIM_VERSION_V31_SPIDER_TERRAIN;'),
    ).toBe(false);
    expect(
      latestLine(7).test('export const LATEST_SIM_VERSION = SIM_VERSION_V70_EGG_RESERVE;'),
    ).toBe(false);
    // Never a registry entry that is not the LATEST line.
    expect(latestLine(3).test('export const SIM_VERSION_V3 = 3 as const;')).toBe(false);
  });

  it("matches this tree's own LATEST line, so a reformat of it fails here first", () => {
    const types = readFileSync(new URL('../sim/types.ts', import.meta.url), 'utf8');
    const lines = types.split('\n').filter((l) => latestLine(LATEST_SIM_VERSION).test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^export const LATEST_SIM_VERSION = /);
    // The search counts every match in the file, for any version. A second
    // `LATEST_SIM_VERSION =` line, e.g. a comment quoting an older one, would add hits
    // and shift which hit is the move-off commit.
    expect(types.split('\n').filter((l) => /LATEST_SIM_VERSION\s*=/.test(l))).toHaveLength(1);
  });

  it('matches a registry name suffixed or not, for exactly that version', () => {
    expect(registryName(3).test('export const SIM_VERSION_V3 = 3 as const;')).toBe(true);
    expect(registryName(71).test('export const SIM_VERSION_V71_FOO = 71 as const;')).toBe(true);
    expect(registryName(3).test('export const SIM_VERSION_V30_UNDERGROUND = 30 as const;')).toBe(
      false,
    );
    expect(registryName(7).test('world.simVersion >= SIM_VERSION_V70_EGG_RESERVE')).toBe(false);
  });
});
