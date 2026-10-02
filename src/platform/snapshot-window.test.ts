// snapshot-window.test.ts — the analyze-snapshot CLI's message for a snapshot outside
// this build's simVersion window (#407). Pre-1.0 a snapshot replays only on the build
// that recorded it, so every out-of-window case must name a build to check out. That
// includes an F9 export, which has no build id.
import { describe, it, expect } from 'vitest';
import { snapshotWindowMessage } from './snapshot-window.js';
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
      `        c=$(git log --reverse --format=%h -S 'LATEST_SIM_VERSION = SIM_VERSION_V49_' -- src/sim/types.ts | sed -n 2p)\n` +
        '        git checkout "${c:?no commit moved LATEST off V49}^"',
    );
  });

  it('just above LATEST: an F9 export gets a build to fetch and check out, not only a playtrace sha', () => {
    const msg = snapshotWindowMessage(LATEST + 1, MIN, LATEST);
    expect(msg).not.toBeNull();
    expect(msg).toContain("simVersion 69, newer than this build's LATEST (68)");
    expect(msg).toContain('run git fetch origin, then check out that sha');
    // F9 export: fetch FIRST, then the last commit at V69 on origin/main, i.e. the
    // parent of the commit that moved LATEST off V69, else origin/main itself. Pinned
    // as one block so the fetch can't be dropped or reordered.
    expect(msg).toContain(
      '        git fetch origin\n' +
        `        c=$(git log origin/main --reverse --format=%h -S 'LATEST_SIM_VERSION = SIM_VERSION_V69_' -- src/sim/types.ts | sed -n 2p)\n` +
        '        git checkout "${c:-origin/main}${c:+^}"',
    );
    // The recording build is newer than this checkout, so the search must never be
    // over this checkout's own history.
    expect(msg).not.toContain('git log --reverse');
    // An export from an unmerged branch: find the commit that added the constant.
    expect(msg).toContain("git log --all --oneline -S 'SIM_VERSION_V69_' -- src/sim/types.ts");
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
