// scripts/version.mjs
// Single source of truth for the __APP_VERSION__ build define shared by
// vite.config.ts, vite.lib.config.ts and vitest.config.ts (#122, #239).
//
// Reports `${pkg.version}+${short git SHA}` so uploaded playtraces correlate to
// the exact deployed build — package.json version has been 0.0.1 since the
// initial commit and no release process bumps it, so version alone couldn't
// identify a build (the deployed identity is the vendor/game submodule SHA).
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * e.g. "0.0.1+abc1234". Falls back to bare pkg.version outside a git checkout
 * (rev-parse throws) so a tarball / vendored export still emits a valid
 * gameVersion. The website deploy builds inside the vendor/game submodule
 * checkout, whose .git is a gitdir-pointer file — rev-parse resolves the
 * submodule HEAD there.
 */
export function appVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha ? `${pkg.version}+${sha}` : pkg.version;
  } catch {
    return pkg.version;
  }
}
