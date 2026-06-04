# Contributing to Subterrans

Thanks for your interest! Subterrans is a spiritual successor to SimAnt (1991), built in the open. This guide explains how to get set up, find work, and submit changes.

## License & Inbound=Outbound

Subterrans is licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)). By submitting a contribution you agree it is licensed under the same terms. We do not require a CLA — your copyright stays yours, we just need the AGPL license to the project.

If you can't accept AGPL terms for your employer or other reason, please don't submit code changes; issue reports and documentation corrections are still welcome.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). By participating you agree to uphold it. Reports go through the same channel as security issues (see [SECURITY.md](SECURITY.md)).

## Getting Started

```bash
git clone https://github.com/LightAxe/subterrans.git
cd subterrans/code
npm install
npm run dev        # launches Vite dev server
npm run verify     # lint + typecheck + sim-boundary check + tests
```

Requirements:

- Node.js 22 LTS or newer
- A Chromium-based browser for Playwright E2E tests (`npx playwright install` on first run)

Useful scripts:

- `npm test` — Vitest unit/integration suite
- `npm run test:watch` — Vitest in watch mode
- `npm run test:e2e` — Playwright browser tests
- `npm run typecheck` — TypeScript in noEmit mode
- `npm run lint` / `npm run lint:fix` — ESLint

## Finding Something to Work On

1. **[ROADMAP.md](ROADMAP.md)** — high-level direction and upcoming phases. Work that's on the roadmap is pre-approved in principle; scope details still need alignment.
2. **GitHub Issues** — filter for `good first issue` or `help wanted`.
3. **Small fixes welcome unannounced** — typos, doc improvements, failing-test reproductions, boundary-rule enforcement.
4. **For anything larger or off-roadmap, talk first.** The project lead is opinionated about how the game should feel and play — that's not a bug, it's the thesis of the project. If you have a significant gameplay, systems, or design change in mind that isn't already on the roadmap, open a discussion or issue _before_ you start coding. Either convince us it fits, or save us both the awkward "this doesn't match the vision" PR review.

If you're unsure whether an idea fits, open a discussion or draft issue — we'd rather talk early than reject a finished PR.

## AI-First Contribution Norm

Subterrans is partly an experiment in AI-driven software development. **Contributions should be written primarily by AI coding assistants** (Claude Code, Codex, Cursor, Aider, etc.) with human guidance, review, and judgment. Human-written code is welcome as a last resort — for example, when an AI is stuck, when fine-grained control matters, or when you're fixing something trivial and writing it yourself is faster than prompting.

What we actually care about:

- The code is correct, tested, and follows the architectural rules.
- You understand and take responsibility for what you submit — reviewers will ask questions, and "the AI wrote it" is not an answer.
- You disclose AI involvement honestly in the PR description if it's the bulk of the work. We're not gatekeeping; we're curious about what works.

This norm is a preference, not a hard rule. Good human-written contributions won't be rejected for being human-written.

## Architectural Rules (Read Before Coding)

Subterrans has strict architectural boundaries that a reviewer _will_ block on. Skim these first:

- **[AGENTS.md](AGENTS.md)** — the contributor quick-reference (directory layout, banned APIs, testing expectations).
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — full explanations with examples.

Highlights:

- `src/sim/` is a pure, deterministic, integer-math simulation. **No Phaser, no DOM, no `Math.random`, no `Date`, no floats** — ever.
- Render and input layers read simulation state; they never mutate it.
- Fixed 20 Hz tick. No variable timestep.
- Every simulation change needs unit tests; deterministic-replay tests must still pass.

## Development Workflow

1. **Fork & branch.** Branch off `main` with a short descriptive name: `fix/rally-oscillation`, `feat/scent-trails`.
2. **Write tests first where practical.** Simulation bugs almost always have a minimal reproducer — prefer a failing test in `src/sim/` over a console log.
3. **Keep commits small and focused.** One logical change per commit. Commit message style:

   ```
   feat(sim): rally hold radius prevents fighter stutter

   Explain *why* in the body when the diff doesn't make it obvious.
   ```

   Prefixes we use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.

4. **Run `npm run verify` before pushing.** Same command CI runs.
5. **Open a PR** against `main`. Fill out the PR template (summary + test plan).

## PR Review

Every PR is reviewed by at least one human maintainer and, for now, by AI reviewers (Claude Code + Codex) that check architectural compliance. Expect to see comments about:

- Boundary crossings (Phaser imports in `src/sim/`, raw `Math.random`, floats in simulation math)
- Missing tests on simulation logic
- Determinism regressions — replay tests must pass
- Scope creep — please split unrelated changes

Owner may override an AI block if it's a false positive; if you disagree with a bot's review, tag a maintainer rather than re-running the bot.

## Reporting Bugs

Open an issue with:

- What you did (steps, seed if relevant)
- What you expected
- What actually happened
- Browser + OS
- Attach a debug snapshot if you have one (see in-game debug menu)

For deterministic reproducers: **the seed is gold.** Include it.

## Security Issues

Please do **not** open a public issue for security-sensitive bugs. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Attribution

Contributors are credited in [CONTRIBUTORS.md](CONTRIBUTORS.md) (alphabetical). Add yourself in the same PR as your first substantive change.

Welcome aboard — we're glad you're here.
