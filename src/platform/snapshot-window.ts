// snapshot-window.ts — the analyze-snapshot CLI's explanation for a debug snapshot
// whose simVersion is outside this build's window.
//
// A snapshot (an F9 export, or the one inside a playtrace) whose simVersion is outside
// [MIN_ACCEPTED_SIM_VERSION, LATEST_SIM_VERSION] can be neither loaded nor replayed by
// this build. Pre-1.0 (AGENTS.md "simVersion and saves"), sim behaviour changes are not
// version-gated, so a snapshot replays only on the build that recorded it. This builds
// the message telling the operator which build to check out. It is pure, with no I/O,
// so it can be unit-tested. scripts/analyze-snapshot.ts prints it and exits 2.
//
// A playtrace names its build: the envelope's `gameVersion` is "<version>+<git sha>".
// An F9 export carries no build id, so the message falls back to a commit at the
// snapshot's simVersion n:
//   - If n is older than this build, use the parent of the commit that first moved
//     LATEST_SIM_VERSION off n.
//   - If n is newer, fetch first. Use origin/main's tip if its LATEST is n, else that
//     same parent on origin/main. If origin/main never reached n, list the branch
//     commits that touched SIM_VERSION_V<n>_.
// A constant retune made later at the same simVersion can still make that replay
// differ.
//
// The search finds the commits that add or remove the line
// `LATEST_SIM_VERSION = SIM_VERSION_V<n>_`. The first one sets LATEST to n and the
// second moves it off n, whatever the next version is, so a skipped version number
// cannot mislead it.

const SAME_BUILD_RULE =
  `  Snapshots replay only on the build that recorded them: before 1.0, sim changes ` +
  `are not version-gated, so a different build does not run the rules it was recorded under.\n`;

/** Shell assigning `c` the commit that first moved LATEST_SIM_VERSION off `n` (empty if none). */
function commitMovingLatestOff(n: number, ref: string): string {
  return (
    `c=$(git log ${ref}--reverse --format=%h ` +
    `-S 'LATEST_SIM_VERSION = SIM_VERSION_V${n}_' -- src/sim/types.ts | sed -n 2p)`
  );
}

const PLAYTRACE =
  `    - playtrace: the envelope's gameVersion is "<version>+<git sha>"; ` +
  `run git fetch origin, then check out that sha.\n`;

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
      `  Check out the recording build and analyze it there:\n` +
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
      `  Check out the recording build and analyze it there:\n` +
      PLAYTRACE +
      `    - F9 export (no build id): use the last commit at simVersion ${simVersion}, the ` +
      `parent of the commit that first moved LATEST off it (a constant retune made at the ` +
      `same simVersion after the capture can still make the replay differ):\n` +
      `        ${commitMovingLatestOff(simVersion, '')}\n` +
      `        git checkout "\${c:?no commit moved LATEST off V${simVersion}}^"`
    );
  }

  if (simVersion > latest) {
    // The recording build is newer than this checkout, so fetch it first. The tip of
    // origin/main is checked first: if its LATEST is N, the tip is the last commit at
    // N, even if N was reverted and re-landed. Otherwise use the parent of the commit
    // that moved LATEST off N. If origin/main never reached N, the export came from an
    // unmerged branch: list the commits on any branch that touched that version,
    // rather than check out a build that would refuse the snapshot again. `git grep`
    // tests the tip without a pipe, so a shell with `pipefail` can't misread a SIGPIPE
    // as "no match".
    const v = `SIM_VERSION_V${simVersion}_`;
    return (
      `${header}was captured on simVersion ${simVersion}, newer than this build's LATEST ` +
      `(${latest}); this build cannot load or replay it.\n` +
      SAME_BUILD_RULE +
      `  Fetch the recording build, check it out and analyze it there:\n` +
      PLAYTRACE +
      `    - F9 export (no build id): origin/main itself if its LATEST is ${simVersion}, ` +
      `else the last commit at simVersion ${simVersion} on origin/main (the parent of the ` +
      `commit that moved LATEST off it); if origin/main never reached ${simVersion}, the ` +
      `branch commits that touched it. One block, bash or zsh:\n` +
      `        git fetch origin\n` +
      `        ${commitMovingLatestOff(simVersion, 'origin/main ')}\n` +
      `        if git grep -q 'LATEST_SIM_VERSION = ${v}' origin/main -- src/sim/types.ts; ` +
      `then git checkout origin/main\n` +
      `        elif [ -n "$c" ]; then git checkout "$c^"\n` +
      `        else echo 'origin/main never reached V${simVersion}; branch commits that ` +
      `touched ${v} (none listed? ask for the playtrace):'; ` +
      `git log --all --oneline -S '${v}' -- src/sim/types.ts; fi`
    );
  }

  return null;
}
