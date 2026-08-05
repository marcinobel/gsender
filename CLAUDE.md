# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## HARD RULE – this is a private fork, never contribute upstream

This checkout is a **personal fork** (`marcinobel/gsender`) of `Sienci-Labs/gsender`. Work here is **never** sent back to the original project. There is no intent to upstream anything, ever.

What the fork actually changes, and why it exists at all, is in **[FORK.md](FORK.md)** – read it before touching the tool-change wizards or the controllers' `%`-line handling.

**Forbidden – do not do these, and do not offer or suggest them:**

- Opening, drafting, or preparing a pull request against `Sienci-Labs/gsender` (or any repo other than `marcinobel/gsender`) – `gh pr create`, `gh pr edit`, the GitHub web flow, or a patch/branch prepared "in case we upstream it".
- Pushing any branch, tag, or commit to a remote other than `origin` (`https://github.com/marcinobel/gsender.git`) – `git push <other-remote>`, `git push <url>`, `git push --mirror`, or pushing to a fork of the fork.
- Adding, renaming, or repointing a remote so it targets `Sienci-Labs/*` (`git remote add upstream …`, `git remote set-url …`). **Only `origin` may exist**, and only pointing at `marcinobel/gsender`.
- Filing issues, discussions, comments, or reviews on `Sienci-Labs/gsender`.
- Any other outbound action that puts code, diffs, or bug reports from this repo in front of the upstream project.

**Allowed:** everything local, plus `git push origin <branch>` and PRs *within* `marcinobel/gsender` (e.g. feature branch → `master`).

**Read-only exception:** `git fetch` from upstream, or reading upstream code/issues/releases to compare or rebase, is fine. Pulling **in** is fine; pushing **out** is not.

**Enforced mechanically:** `.claude/settings.json` registers a `PreToolUse` hook on `Bash` that runs `.claude/hooks/block-upstream-contributions.sh`, which denies the commands above before they run. Do not disable, bypass, or edit that hook to widen what it allows.

If a task appears to require any forbidden action, stop and ask – do not improvise a workaround. Rules elsewhere in this file (Conventional Commits, CI branch names, release notes) describe upstream's own workflow and are kept for consistency; they never authorise contributing back.

## What this is

gSender is a desktop G-code sender for GRBL and grblHAL CNC machines (Sienci Labs, GPLv3). It is **three programs in one repo** that talk to each other over HTTP + socket.io:

| Process | Source | Role |
|---|---|---|
| Node/Express server | `src/server/` | Owns the serial port, parses controller output, streams G-code. Also serves the built UI. |
| React SPA (renderer) | `src/app/` | All UI. Talks to the server over socket.io – it never touches the serial port. |
| Electron main | `src/main.js`, `src/electron-app/` | Boots the server in-process, creates the window, auto-update, file associations. |

The server also runs standalone (`bin/gsender`), which is how the browser/remote-mode and Raspberry Pi use cases work – so **never assume Electron is present** in server or app code. Both use `is-electron` guards.

## Commands

Package manager is **yarn** (CI uses it; `bun.lock` is also committed but not what CI runs).

```bash
yarn install                 # root deps
yarn --cwd src/app install   # renderer deps (`npm run install:packages` is broken – see below)

npm run dev                  # server-only dev: esbuild watch + nodemon server on :8000 + tailwind watch
npm run electron:hot         # full desktop dev: above + vite on :5173 + electron pointed at it
npm run vite:dev             # renderer only on :5173 (proxies /api and /socket.io to :8000)

npm run build                # = build-prod: css + esbuild server/main/cli + vite renderer -> dist/gsender
npm run build:macos          # electron-builder packaging (also :windows, :linux, and per-arch variants)

npm test                     # jest, all suites
npm run test:unit:watch      # jest --watch

npm run eslint               # eslint – `npm run lint` is broken, and this one has caveats (see below)
npm run cypress:open         # e2e against a running app; needs real hardware for most specs
```

Dev vs prod output dirs differ: dev builds go to `output/`, production builds to `dist/gsender/`. `npm run clean` wipes both.

To launch a production build from this checkout it must be `electron dist/gsender` – the **directory**. `electron .` starts the headless server (the root `main` is `./dist/gsender/server-cli`) and `electron dist/gsender/main.js` boots with factory-default settings under a different app identity. Both fail silently. **A fresh `npm run build` will not launch even with the directory form**: the generated `dist/gsender/package.json` has no `main`, so Electron looks for `index.js` and shows an error dialog while staying alive. Add `"main": "./main.js"` to that file first (electron-builder does it during packaging, `npm run build` does not). Under Electron the server binds an ephemeral port, not `8000`. Details and the config-store consequences: [fork/running-from-source.md](fork/running-from-source.md).

The window title carries a fork marker – `gSender <version> (Marcin Obel)` – set in `src/app/src/workspace/index.tsx` and `src/main.js`. It is **display only**. Never put the marker in `build.productName` or `src/app/package.json`'s `name`: those derive `app.getPath('userData')`, so changing them moves the settings directory and the app boots factory-default.

`prebuild-*` runs `scripts/package-sync.js`, which regenerates `src/package.json` (the manifest that ships inside the Electron bundle) and `src/app/package.json` from the root `package.json`. Bump versions in the **root** `package.json`; the others are generated.

**Release notes live in the README.** `scripts/readme_sync.js` parses the `### X.Y.Z (Date)` headings under "Development History" and package-sync bakes the three most recent entries into the build – so that section is the changelog, not decoration, and its heading format is load-bearing. There is no `CHANGELOG.md`.

### Known-broken scripts

- `npm run lint` – the `concurrently` invocation has a missing space between `--names "..."` and the first command, so eslint never runs. Use `npm run eslint`, with the caveat below.
- `npm run eslint` – expands to `eslint --ext .js --ext .jsx *.js scripts test --fix`. There is **no `test/` directory** in this repo, so eslint fails on the missing path, and `--fix` **rewrites your files**. Call eslint on a real path yourself (`npx eslint scripts`) if you want neither.
- `npm run install:packages` – `yarn install && yarn install --prefix /src/app`. The leading slash makes `/src/app` an **absolute** path; the renderer is at `src/app`. Use `yarn --cwd src/app install`.
- `yarn test:app` – invokes `../../node_modules/.bin/jest.cmd`, which exists only on Windows. Fails on macOS/Linux; use the root `npm test`.
- Three Cypress scripts are `cmd.exe`-only: `report:clean` (`if exist`, `rmdir /s /q`), `report:open` and `dashboard:open` (`start`). `report:merge`, `report:generate` and `cypress:open` are cross-platform. `npm run testgrblhal` and `npm run test:report` both open with `report:clean`, so on macOS/Linux they stop at their first step.
- `npm run check-types` – points at `./src/app/src`, but the tsconfig lives at `./src/app`. Also, the only TypeScript in `node_modules` is a transitive **3.9.10**, which cannot parse this tsconfig (`moduleResolution: Bundler`, `noUncheckedIndexedAccess`, …). **There is no working typecheck in this repo** – Vite/esbuild strip types without checking them, so type errors surface only at runtime. Don't claim "types check out" without installing a modern TypeScript yourself. This is not hypothetical: a wizard's action objects were never typed against the `WizardAction` interface the renderer reads, so a shipped feature could not work at all. See [FORK.md](FORK.md).

## Architecture

### How a UI action reaches the machine

```
React component
  → app/lib/controller.ts        (singleton socket.io client, 76 named events)
  → socket 'command' / 'write'
  → src/server/services/cncengine/CNCEngine.js   (socket ↔ controller registry, per-port)
  → GrblController / GrblHalController .command(cmd, ...args)   (big handler map: 'gcode:start', 'gcode:pause', 'homing', …)
  → Feeder (one-off commands) or Sender (streaming a job) → SerialConnection
```

Everything coming back travels the same path in reverse: `GrblLineParser` / `GrblHalLineParser` turn serial lines into typed results, `GrblRunner` / `GrblHalRunner` fold them into controller state, and the controller emits socket events (`controller:state`, `serialport:read`, `sender:status`, …) that `controller.ts` fans out to listeners.

Key server pieces in `src/server/lib/`:
- `Sender.js` – job streaming with char-counting flow control; owns progress/hold state.
- `Feeder.js` – queue for interactive commands issued while not streaming.
- `Workflow.js` – `idle | running | paused` state machine.
- `ToolChanger.js`, `homing.js`, `rotary.js` – higher-level macro sequences.

**Grbl and grblHAL are two near-parallel implementations** – `src/server/controllers/Grbl/GrblController.js` is 2,463 lines and `Grblhal/GrblHalController.js` is 2,957, and that is only the controller class in each directory, which also carries its own line parsers, runner and constants. A change to firmware behaviour usually needs applying in **both**, and the grblHAL one additionally handles SD card, ATC, alarm/error detail codes, and settings descriptions.

### Renderer structure (`src/app/src/`)

- `features/<Name>/` – the main unit of organisation (~40 of them: Probe, Jogging, Spindle, Rotary, Surfacing, Config, …). A feature typically has `index.tsx`, `components/`, `utils/actions.ts`, sometimes `assets/` and `tests/`.
- `workspace/` – the shell that composes features into the main screen (TopBar, Sidebar, Carve, ToolArea).
- `react-routes.tsx` – routes for full-page views (configuration, tools, stats) **and** for remote-mode single-widget views.
- Two stores, both in use:
  - `app/store` – an `ImmutableStore` of user preferences, persisted to `~/.../gsender-0.5.6.json` via Electron fs or to the server via `api`. This is the settings/profile store.
  - `app/store/redux` – Redux Toolkit slices (`controller`, `connection`, `fileInfo`, `console`, `visualizer`, …) fed by `sagas/controllerSagas.tsx`, which subscribes to the socket events. This is live machine state.
- `lib/` – non-UI logic worth knowing: `GCodeVirtualizer.ts` (~1.8k lines, streaming G-code parse for the visualizer/estimates), `GCodeParser.ts`, `Probing.ts`, `shuttleEvents.ts` + `useKeybinding.ts` (the shortcut system), `toolChangeUtils.ts`.
- `workers/` – `Visualize.worker.ts` and `Outline.worker.ts` keep toolpath processing off the main thread.
- Wizards (`wizards/*.tsx` + `features/Helper/Wizard.tsx`) drive interactive multi-step procedures like tool changes; they run steps that emit G-code through `controller`.

### Path aliases

Four aliases exist and **no two config files declare the same set** – check this before adding one:

| Alias | `src/app/tsconfig.json` | `src/app/vite.config.js` | `jest.config.js` | Target |
|---|---|---|---|---|
| `app/*` | yes | yes | yes | `src/app/src/*` |
| `@/*` | **no** | yes | yes | `src/app/src/*` |
| `app-root/*` | yes | **no** | yes | repo root in jest; in the tsconfig the mapping is `./*` against `baseUrl: "."`, so for `tsc` it means `src/app/*` |
| `server/*` | **no** | **no** | yes | `src/server/*` |

`vite.config.js` also loads `vite-tsconfig-paths`, so whatever the tsconfig declares resolves under vite as well – that is how `app-root/*` works there without being in `resolve.alias`. The reverse does not hold: `@/*` is a vite alias and a jest `moduleNameMapper` entry only, so `tsc` and anything driven by the tsconfig cannot see it. `server/*` is jest-only, added for the controller tests; the server build instead resolves bare `server/`, `app/` and `electron-app/` prefixes through a custom esbuild plugin in `esbuild.config.js`. Adding an alias means editing every file it has to work in.

## Conventions

- **Server code is JavaScript, renderer code is TypeScript.** `src/server` is excluded from prettier (`.prettierignore`) and uses tabs/different style – match the file you're in rather than reformatting.
- Every source file carries the GPLv3 header block. Keep it on new files.
- UI is Tailwind + Radix primitives wrapped in `components/shadcn/`.
- Socket event names are string literals duplicated between `controller.ts`'s `ControllerListeners` interface and the server emitters. Adding an event means editing both `listeners` and `ControllerListeners`.
- Conventional Commits. CI (`.github/workflows/CI.yml`) builds packages on `master`, `dev`, `features/*`, `bugfix/*` and on tags; it runs `yarn lint` (which, per above, currently only runs stylint) but **not** the jest suite – `test.yml` only fires on PRs into `test/ci-validation`. Run `npm test` locally.

## Testing

- **Jest** (`jest.config.js`, jsdom): ~100 tests across ~11 suites, covering `src/server/lib/__tests__/`, both controllers (`src/server/controllers/*/__tests__/` – these construct a real controller against a fake connection and need the logger mocked), a few feature computations (Surfacing output, XY squaring, movement tuning) and component smoke tests. Fast – run it. Details and mocking patterns: `src/app/docs/testing.md`.
- **Cypress** (`cypress/e2e/grbl/`, `cypress/e2e/grblHal/`): drives the real UI at `http://localhost:8000` and expects an actual connected machine for most specs, so it does not run in CI or in a normal dev loop. Note `specPattern` in `cypress.config.js` is pinned to a single grblHAL master spec – pass `--spec` to run anything else. Details: `cypress/TESTING.md`.

## Further documentation

- `FORK.md` – why this fork exists, the two defects it patches, how each was verified, and the rebase posture.
- `fork/known-issues.md` – defects and behavioural traps verified in this codebase. Two are tagged as hazards: `Resume Cutting` restarts the spindle unconditionally, and a `%` expression in a G-code file can execute arbitrary JavaScript.
- `fork/running-from-source.md` – building, the two silent Electron entry-point traps, where settings actually live, and the CLI options.
- `src/app/docs/testing.md` – frontend unit testing: how to run, where tests live, mocking the controller singleton and app hooks.
- `src/app/docs/analytics.md` – PostHog wiring, the consent gate, and the convention for adding an event.
- `cypress/TESTING.md` – e2e suite: config, custom commands, env file, reports.
- `README.md` – user-facing feature overview and the release-notes history.

## Gotchas

- `jest-haste-map` warns about a naming collision between `package.json` and `src/package.json` (both named `gSender`). Harmless, expected output.
- The generated `src/package.json` and `src/app/package.json` are committed but overwritten by `package-sync`; edit the root one.
- `.env.dev` / `.env.prod` are loaded by `esbuild.config.js` (Sentry, PostHog). See `.env.example`.
- **Wizard actions must be declared as `{ label, gcodeLines }`.** `features/Helper/components/Actions.tsx` reads `action.gcodeLines` and nothing ever invokes a `cb` callback – a wizard action declared with `cb` renders, clicks, and sends nothing, hanging on `Running…` for ever. The objects are not typed, so nothing warns you.
- **Never mutate `line` on the `%` path.** In both controllers' sender `dataFilter` a line starting with `%` is JavaScript, not G-code – `(…)` is a function call and `,` is a sequence operator – so the comment regexes would silently corrupt it. That is what the `if (line[0] !== "%")` guard exists for. Compare against the `%` tokens using `stripSemicolonComment(line)`, a throwaway copy, and hand the evaluator the original line.
- **Grbl and grblHAL have drifted apart in `gcode:load`.** The Grbl controller appends a `%wait` dwell to every program (`GrblController.js:1630`); grblHAL appends none, deliberately (`GrblHalController.js:1922-1942` records why). See `fork/known-issues.md` item 2.
