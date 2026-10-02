// snapshot-window.ts — the analyze-snapshot CLI's explanation for a debug snapshot
// whose simVersion is outside this build's window.
//
// A snapshot (an F9 export, or the one inside a playtrace) whose simVersion is outside
// [MIN_ACCEPTED_SIM_VERSION, LATEST_SIM_VERSION] can be neither loaded nor replayed by
// this build. Pre-1.0 (AGENTS.md "simVersion and saves"), sim behaviour changes are not
// version-gated, so a snapshot is only guaranteed to replay on the build that recorded
// it. This builds the message telling the operator which build to check out. It is
// pure, with no I/O, so it can be unit-tested. scripts/analyze-snapshot.ts prints it
// and exits 2.
//
// A playtrace names its build: the envelope's `gameVersion` is "<version>+<git sha>",
// so its sha is the recording build itself. An F9 export carries no build id, so the
// message can only point at a commit at the snapshot's simVersion n, the last one:
//   - If n is older than this build, use the parent of the latest commit that moved
//     LATEST_SIM_VERSION off n.
//   - If n is newer, fetch first. Use origin/main's tip if its LATEST is n, else that
//     same parent on origin/main. If origin/main never reached n, list the branch
//     commits that touched SIM_VERSION_V<n>.
// That commit is not necessarily the recording build. A bare constant retune never
// bumps simVersion, so one made at the same simVersion can still make the replay
// diverge. Each recipe checks that the chosen parent's LATEST really is n before
// checking it out. That covers a departure made only inside a merge (pickaxe skips
// merge diffs, so the newest hit could be an arrival) and a HEAD that is itself at n,
// e.g. an uncommitted bump. If the check fails, the recipe says so instead of
// checking out the wrong build.
//
// The search counts matches of `latestLinePattern(n)`, using `git log -S` with
// `--pickaxe-regex`. That lists the commits that add or remove the LATEST line for n,
// newest first, and `-1` keeps the newest. When the searched ref's LATEST is not n,
// the line occurs 0 times there, so on a linear history the newest change to that
// count is the latest departure from n, whatever the next version was. If n was
// landed, left, re-landed and left again, that is the second departure, and its parent
// is the last commit at n. A skipped version number cannot mislead it, and neither can
// a revert. The newer case tests the tip on its own, because a tip still at n has no
// departure yet. The LATEST line has had two forms:
//   - `export const LATEST_SIM_VERSION = 3 as const;` (V3, a bare number);
//   - `export const LATEST_SIM_VERSION = SIM_VERSION_V<n>_<SUFFIX>;` (V4 on).
// A registry name may also have no suffix (`SIM_VERSION_V3`). The patterns cover all
// of these and stop at a non-digit, so V3 never matches V30 or V31.

const SAME_BUILD_RULE =
  `  Snapshots are only guaranteed to replay on the build that recorded them: before 1.0, sim changes ` +
  `are not version-gated, so a different build does not run the rules it was recorded under.\n`;

/**
 * POSIX extended regex for the line that sets LATEST_SIM_VERSION to exactly `n`. It
 * covers the bare-number form, the suffixed form and an unsuffixed form. It is also
 * valid as a JS RegExp, and the tests use it that way.
 */
export function latestLinePattern(n: number): string {
  return `LATEST_SIM_VERSION = (SIM_VERSION_V)?${n}[^0-9]`;
}

/**
 * POSIX extended regex for any use of the registry constant for exactly `n`,
 * suffixed or not (`SIM_VERSION_V3`, `SIM_VERSION_V71_FOO`).
 */
export function registryNamePattern(n: number): string {
  return `SIM_VERSION_V${n}[^0-9]`;
}

/**
 * Shell assigning `c` the latest commit that moved LATEST_SIM_VERSION off `n`, i.e.
 * the newest pickaxe hit (empty if none). Only valid where the ref's LATEST is not `n`.
 */
function latestDepartureFrom(n: number, ref: string): string {
  return (
    `c=$(git log ${ref}-1 --format=%h --pickaxe-regex ` +
    `-S '${latestLinePattern(n)}' -- src/sim/types.ts)`
  );
}

/** Shell test: `c` is set and its parent's LATEST is exactly `n`. */
function parentAtVersion(n: number): string {
  return `[ -n "$c" ] && git grep -qE '${latestLinePattern(n)}' "$c^" -- src/sim/types.ts 2>/dev/null`;
}

const WHERE = `  Check out a build that can load it and analyze it there:\n`;

const PLAYTRACE =
  `    - playtrace: the envelope's gameVersion is "<version>+<git sha>", the recording ` +
  `build itself; run git fetch origin, then check out that sha.\n`;

/** Why an F9 export's commit is only a close match. */
const F9_NOT_EXACT =
  `This is a commit at that simVersion, not necessarily the recording build: a bare ` +
  `constant retune at the same simVersion (retunes never bump it) can still make the ` +
  `replay diverge.`;

/**
 * The message for a snapshot outside `[min, latest]`, or `null` when this build can
 * load it. A `simVersion` that is `null` or not an integer counts as missing or invalid.
 */
export function snapshotWindowMessage(
  simVersion: number | null,
  min: number,
  latest: number,
): string | null {
  const header = '[analyze-snapshot] This snapshot ';

  if (simVersion === null || !Number.isInteger(simVersion)) {
    return (
      `${header}has a missing or invalid simVersion, so this build (minimum ${min}) ` +
      `cannot place it; its saved state cannot be loaded here.\n` +
      SAME_BUILD_RULE +
      WHERE +
      PLAYTRACE +
      `    - F9 export: its simVersion is unreadable, so there is no build to point at.`
    );
  }

  if (simVersion < min) {
    // Every commit at an older simVersion is an ancestor of this checkout.
    return (
      `${header}was captured on simVersion ${simVersion}, below this build's minimum ` +
      `(${min}); its saved state cannot be loaded here.\n` +
      SAME_BUILD_RULE +
      WHERE +
      PLAYTRACE +
      `    - F9 export (no build id): the last commit at simVersion ${simVersion}, the ` +
      `parent of the latest commit that moved LATEST off it. ${F9_NOT_EXACT}\n` +
      `        ${latestDepartureFrom(simVersion, '')}\n` +
      `        if ${parentAtVersion(simVersion)}; then git checkout "$c^"\n` +
      `        else echo 'no commit at V${simVersion} found in this history (ask for the ` +
      `playtrace)'; fi`
    );
  }

  if (simVersion > latest) {
    // The recording build is newer than this checkout, so fetch it first. The tip of
    // origin/main is checked first: if its LATEST is N, the tip is the last commit at
    // N, and N has no departure yet. Otherwise use the parent of the latest commit
    // that moved LATEST off N, once that parent is checked to be at N. If neither
    // identifies a commit (usually because origin/main never reached N, so the export
    // came from an unmerged branch), list the commits on any branch that touched that
    // version rather than check out a build that would refuse the snapshot again.
    // `git grep` tests the tip without a pipe, so a shell with `pipefail` can't misread
    // a SIGPIPE as "no match".
    const name = `SIM_VERSION_V${simVersion}`;
    return (
      `${header}was captured on simVersion ${simVersion}, newer than this build's LATEST ` +
      `(${latest}); this build cannot load or replay it.\n` +
      SAME_BUILD_RULE +
      WHERE +
      PLAYTRACE +
      `    - F9 export (no build id): origin/main itself if its LATEST is ${simVersion}, ` +
      `else the last commit at simVersion ${simVersion} on origin/main (the parent of the ` +
      `latest commit that moved LATEST off it); if origin/main never reached ` +
      `${simVersion}, the branch commits that touched it. ${F9_NOT_EXACT} ` +
      `One block, bash or zsh:\n` +
      `        git fetch origin\n` +
      `        ${latestDepartureFrom(simVersion, 'origin/main ')}\n` +
      `        if git grep -qE '${latestLinePattern(simVersion)}' origin/main -- src/sim/types.ts; ` +
      `then git checkout origin/main\n` +
      `        elif ${parentAtVersion(simVersion)}; then git checkout "$c^"\n` +
      `        else echo 'no commit at V${simVersion} identified on origin/main; branch commits that ` +
      `touched ${name} (none listed? ask for the playtrace):'; ` +
      `git log --all --oneline --pickaxe-regex -S '${registryNamePattern(simVersion)}' ` +
      `-- src/sim/types.ts; fi`
    );
  }

  return null;
}
