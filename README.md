# Subterrans

A modern ant colony simulation game, built for the web. A spiritual successor to Maxis's _SimAnt_ (1991) — same core idea (you are the colony, not an individual ant; you influence behavior through allocation and pheromones rather than direct control), with contemporary design, determinism, and moddability baked in from the start.

> **Status:** early development. The simulation is working end-to-end and playable at a rough level; art, audio, and polish are ongoing. Expect things to change. See the [roadmap](https://subterrans.com/roadmap) for the current phase structure and what's next.

---

## What's In The Box Today

- A deterministic, headlessly-runnable ant colony simulation (20 Hz fixed tick, integer math, seeded PRNG).
- Queens laying eggs, larvae maturing into workers, workers foraging, digging, nursing, and dying of starvation when you mismanage them.
- Food pheromone trails and danger trails that decay over time.
- Per-colony underground excavation with chambers and nest entrances.
- Surface and underground views with a toggle, camera pan, minimap, HUD, and a Forage↔Fight allocation slider.
- Colony-vs-colony combat, rally points, and cross-grid invasions (rally fighters on an enemy entrance and they go underground).
- Full save/load with deterministic replay — the same seed plus the same input log reproduces a session exactly.

See the [roadmap](https://subterrans.com/roadmap) for the current phase structure and what's explicitly out of scope.

---

## Play It

Subterrans is a browser game. Play the current build in your browser at **[subterrans.com/demo](https://subterrans.com/demo)** — auto-deployed from this repo on every push to `main`. To run it locally instead, see [Build & Run](#build--run) below.

## Build & Run

```bash
git clone https://github.com/LightAxe/subterrans.git
cd subterrans
npm install
npm run dev       # launches Vite dev server, opens in browser
```

Requirements:

- **Node.js 22 LTS or newer**
- A Chromium-based browser for the Playwright E2E suite (`npx playwright install` on first run).

Useful scripts:

| Command             | What it does                                                 |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | Vite dev server with hot reload                              |
| `npm run build`     | Production build                                             |
| `npm test`          | Vitest unit/integration tests                                |
| `npm run test:e2e`  | Playwright browser tests                                     |
| `npm run typecheck` | TypeScript in `--noEmit` mode                                |
| `npm run lint`      | ESLint                                                       |
| `npm run verify`    | Format check + lint + typecheck + type-aware lint + sim-boundary/asset-path/e2e-geometry/ant-cycle guards + unit tests (CI's verify job; e2e is a separate job) |

---

## How This Is Built

Subterrans has strict architectural rules that exist to support determinism, testability, and long-term portability. The short version:

- **`src/sim/` is pure TypeScript.** No Phaser, no DOM, no browser APIs, no `Math.random`, no `Date`, no floating-point math. The simulation runs in Node headlessly.
- **Fixed 20 Hz tick.** Rendering interpolates between ticks; simulation never sees wall-clock time.
- **Render and input layers read simulation state; they never mutate it.** All state changes go through a typed command queue.
- **Everything is deterministic.** A recorded seed plus input log reproduces a run tick-for-tick.

Full detail in [ARCHITECTURE.md](ARCHITECTURE.md). A condensed contributor reference lives in [AGENTS.md](AGENTS.md).

---

## Contributing

We welcome contributions, and the project is partly an experiment in AI-driven development — so contributions written with AI coding assistants are the norm, not the exception. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the full guide, and [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) for community expectations.

Quick pointers:

- Small fixes: open a PR.
- Anything on the roadmap: open an issue to claim it, then PR.
- Anything _off_ the roadmap: talk to us first — open an issue or discussion before starting work.

Past and present contributors are listed in [CONTRIBUTORS.md](.github/CONTRIBUTORS.md).

## Security

Please don't report security issues in public. See [SECURITY.md](.github/SECURITY.md) for the private reporting process.

## License

Subterrans is licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.

In plain English: you can use, modify, and redistribute Subterrans freely, but any derivative work must be licensed under the same terms, and if you run a modified version as a network service, you must share your modifications with the users of that service. Your surrounding website, infrastructure, and account systems are not derivative works and are not covered.

Subterrans additionally grants the **Subterrans App Store Exception**, an AGPL section 7 additional permission that lets anyone distribute the project through app stores whose terms would otherwise conflict with the AGPL, while it stays fully open source. See [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md) for the exact grant, conditions, and scope.

## Acknowledgements

- Maxis and the original _SimAnt_ (1991) team, for making the game that made this one necessary.
- The Phaser, Vite, Vitest, and Playwright communities for the tools this project stands on.
