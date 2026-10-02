// snapshot-window.test.ts — the analyze-snapshot CLI's message for a snapshot outside
// this build's simVersion window (#407). Pre-1.0 a snapshot is only guaranteed to
// replay on the build that recorded it, so every out-of-window case must name a build
// to check out. That includes an F9 export, which has no build id.
import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(msg).toContain('only guaranteed to replay on the build that recorded them');
    expect(msg).toContain(
      'the recording build itself; run git fetch origin, then check out that sha',
    );
    // The F9 fallback is only a commit at that simVersion, and the message says so.
    expect(msg).toContain('not necessarily the recording build');
    expect(msg).toContain('constant retune at the same simVersion');
    // The parent of the LATEST departure from V49 (the newest pickaxe hit), searched in
    // this checkout's own history (every older commit is an ancestor), and checked out
    // only once that parent is confirmed to be at V49.
    expect(msg).toContain(
      `        c=$(git log -1 --format=%h --pickaxe-regex -S 'LATEST_SIM_VERSION = (SIM_VERSION_V)?49[^0-9]' -- src/sim/types.ts)\n` +
        `        if [ -n "$c" ] && git grep -qE 'LATEST_SIM_VERSION = (SIM_VERSION_V)?49[^0-9]' "$c^" -- src/sim/types.ts 2>/dev/null; then git checkout "$c^"\n` +
        "        else echo 'no commit at V49 found in this history (ask for the playtrace)'; fi",
    );
  });

  it('just above LATEST: an F9 export gets a build to fetch and check out, not only a playtrace sha', () => {
    const msg = snapshotWindowMessage(LATEST + 1, MIN, LATEST);
    expect(msg).not.toBeNull();
    expect(msg).toContain("simVersion 69, newer than this build's LATEST (68)");
    expect(msg).toContain('run git fetch origin, then check out that sha');
    // F9 export, pinned as one block so no step can be dropped or reordered:
    //   1. fetch first;
    //   2. origin/main itself, but ONLY if its LATEST is V69 (a tip at V69 has no
    //      departure yet, so without this step it would be refused);
    //   3. else the parent of the latest commit that moved LATEST off V69 on origin/main,
    //      once that parent is confirmed to be at V69;
    //   4. else (no commit at V69 on origin/main) list the branch commits touching it.
    // Without the step-2 guard, a version origin/main never reached would check out a
    // build that refuses the snapshot again (CodeRabbit on #407).
    expect(msg).toContain(
      '        git fetch origin\n' +
        `        c=$(git log origin/main -1 --format=%h --pickaxe-regex -S 'LATEST_SIM_VERSION = (SIM_VERSION_V)?69[^0-9]' -- src/sim/types.ts)\n` +
        "        if git grep -qE 'LATEST_SIM_VERSION = (SIM_VERSION_V)?69[^0-9]' origin/main -- src/sim/types.ts; then git checkout origin/main\n" +
        `        elif [ -n "$c" ] && git grep -qE 'LATEST_SIM_VERSION = (SIM_VERSION_V)?69[^0-9]' "$c^" -- src/sim/types.ts 2>/dev/null; then git checkout "$c^"\n` +
        "        else echo 'no commit at V69 identified on origin/main; branch commits that touched SIM_VERSION_V69 (none listed? ask for the playtrace):'; git log --all --oneline --pickaxe-regex -S 'SIM_VERSION_V69[^0-9]' -- src/sim/types.ts; fi",
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
    expect(msg).not.toContain('git log -1');
    expect(msg).toContain('not necessarily the recording build');
  });

  it('well above LATEST: every command names the snapshot version, not LATEST + 1', () => {
    const msg = snapshotWindowMessage(LATEST + 5, MIN, LATEST) ?? '';
    expect(msg).toContain("simVersion 73, newer than this build's LATEST (68)");
    for (const v of [
      '(SIM_VERSION_V)?73[^0-9]',
      "-S 'SIM_VERSION_V73[^0-9]'",
      'no commit at V73 identified',
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

// The recipes run for real (bash, as an operator would paste them) in scratch git
// repos whose history moves LATEST around. In the main case V70 lands, is reverted,
// re-lands and is then left for V71. The last commit at V70 is the re-land, the parent
// of the LATEST departure. Taking the first departure would give the first V70 commit,
// a different build (CodeRabbit on #407). Each recipe also checks that the parent it
// picked really is at N before checking it out.
describe('the F9 recipes against a real git history', () => {
  const TYPES = 'src/sim/types.ts';
  // Isolate from the user's git: drop every inherited GIT_* variable (a hook's
  // GIT_INDEX_FILE / GIT_DIR would point into the real repo) and the user's config
  // (commit signing, hooks, default branch).
  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' }).trim();

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Write types.ts with LATEST at `v` (a unique suffix per step) and commit it. */
  function commitLatest(dir: string, v: number, step: string): string {
    writeFileSync(
      join(dir, TYPES),
      `export const SIM_VERSION_V${v}_${step} = ${v} as const;\n` +
        `export const LATEST_SIM_VERSION = SIM_VERSION_V${v}_${step};\n`,
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `${step}: V${v}`);
    return git(dir, 'rev-parse', 'HEAD');
  }

  /** A fresh repo on `main` with nothing committed yet. */
  function emptyRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-window-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '--initial-branch=main');
    mkdirSync(join(dir, 'src/sim'), { recursive: true });
    return dir;
  }

  /** A repo whose LATEST takes each of `versions` in turn, one commit each; origin/main = tip. */
  function repoWithLatest(versions: readonly number[]): { dir: string; commits: string[] } {
    const dir = emptyRepo();
    const commits = versions.map((v, i) => commitLatest(dir, v, `STEP${i}`));
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    return { dir, commits };
  }

  /** Run the message's recipe block in bash (no fetch: there is no remote); return stdout. */
  function runRecipe(dir: string, msg: string | null, firstLine: string): string {
    const text = msg ?? '';
    const block = text
      .slice(text.indexOf(firstLine))
      .split('\n')
      .map((l) => l.replace(/^ {8}/, ''))
      .map((l) => (l === 'git fetch origin' ? ':' : l))
      .join('\n');
    return execFileSync('bash', ['-c', block], { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
  }

  const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
  const NEWER = '        git fetch origin';
  const OLDER = '        c=$(';

  it('newer snapshot: the last commit at V70 is the re-land, not the first V70 commit', () => {
    const { dir, commits } = repoWithLatest([69, 70, 69, 70, 71]);
    runRecipe(dir, snapshotWindowMessage(70, MIN, LATEST), NEWER);
    expect(head(dir)).toBe(commits[3]);
  });

  it('older snapshot: the same history, searched from this checkout, also gives the re-land', () => {
    const { dir, commits } = repoWithLatest([69, 70, 69, 70, 71]);
    runRecipe(dir, snapshotWindowMessage(70, 71, 71), OLDER);
    expect(head(dir)).toBe(commits[3]);
  });

  it('newer snapshot at the tip: origin/main itself', () => {
    // V70 re-landed and still LATEST: it has no departure, and its newest pickaxe hit
    // is the re-land (an arrival), which the parent guard rejects. Only the tip check
    // can find it. HEAD starts elsewhere so the checkout is observable.
    const { dir, commits } = repoWithLatest([69, 70, 69, 70]);
    git(dir, 'checkout', '-q', '--detach', commits[0] ?? '');
    const out = runRecipe(dir, snapshotWindowMessage(70, MIN, LATEST), NEWER);
    expect(out).not.toContain('no commit at V70');
    expect(head(dir)).toBe(commits[3]);
  });

  it('newer snapshot origin/main never reached: lists branch commits and checks nothing out', () => {
    const { dir, commits } = repoWithLatest([69, 70, 71]);
    const out = runRecipe(dir, snapshotWindowMessage(75, MIN, LATEST), NEWER);
    expect(out).toContain('no commit at V75 identified on origin/main');
    expect(head(dir)).toBe(commits[2]);
  });

  it('older recipe run where HEAD is itself at N: refuses rather than checking out N-1', () => {
    // E.g. pasted into a checkout with an uncommitted LATEST/MIN bump: the newest hit
    // for V70 is its arrival, whose parent is V69.
    const { dir, commits } = repoWithLatest([68, 69, 70]);
    const out = runRecipe(dir, snapshotWindowMessage(70, 71, 71), OLDER);
    expect(out).toContain('no commit at V70 found in this history');
    expect(head(dir)).toBe(commits[2]);
  });

  it('a departure made only inside a merge: refuses rather than checking out the wrong build', () => {
    // main V68; a branch and main both land V69; the merge resolves LATEST to V70.
    // Pickaxe skips merge diffs, so the newest V69 hit is an arrival (parent V68).
    const dir = emptyRepo();
    commitLatest(dir, 68, 'BASE');
    git(dir, 'checkout', '-q', '-b', 'feat');
    commitLatest(dir, 69, 'FEAT');
    git(dir, 'checkout', '-q', 'main');
    commitLatest(dir, 69, 'MAIN');
    git(dir, 'merge', '-q', '-s', 'ours', '--no-commit', 'feat');
    const merge = commitLatest(dir, 70, 'MERGE');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const older = runRecipe(dir, snapshotWindowMessage(69, 71, 71), OLDER);
    expect(older).toContain('no commit at V69 found in this history');
    expect(head(dir)).toBe(merge);
    const newer = runRecipe(dir, snapshotWindowMessage(69, MIN, LATEST), NEWER);
    expect(newer).toContain('no commit at V69 identified on origin/main');
    expect(head(dir)).toBe(merge);
  });
});
