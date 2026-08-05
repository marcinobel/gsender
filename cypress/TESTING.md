# Cypress e2e test documentation (gSender)

## Purpose

This project uses **Cypress** to run **end-to-end UI tests** against the gSender app (the web UI served by the local server). The goal is to validate end-to-end flows that involve real machine state transitions – for example, connecting and moving until the UI reports `Idle` / `Running` / `Complete`.

The Cypress tests are mainly focused on CNC workflow coverage through the UI for both GRBL and grblHAL.

**These tests need real hardware.** Most specs drive an actual connection to a CNC controller, so they are not part of a normal dev loop and they do **not** run in CI – `.github/workflows/CI.yml` runs lint and the packaging build only. The repo's other workflow, `.github/workflows/test.yml`, runs `yarn test` (Jest) and fires only on pull requests into the `test/ci-validation` branch, so nothing runs Cypress automatically anywhere. For the fast, hardware-free suite see Jest (`npm test`, and `src/app/docs/testing.md`).

## What this covers

The specs are organized under:

- `cypress/e2e/grbl/*` (GRBL flows)
- `cypress/e2e/grblHal/*` (grblHAL flows)

The split is not reliable: `gotolocationgrblHal.cy.js` and `grblhaljobrun.cy.js` both sit under `cypress/e2e/grbl/` despite their names. `grblhaljobrun.cy.js` is titled `GrblHal File upload and job run`, while `gotolocationgrblHal.cy.js` is titled `CNC Machine Tests Grbl` and calls the GRBL `cy.connectMachine()`. Read the spec body, not the path or the filename.

**The window-title assertions are stale and will fail.** Three places pin the exact title to `gSender 1.6.0`:

- `cypress/support/commands.js:41` – the `expectedTitle` default in `cy.loadUI`
- `cypress/e2e/grbl/loadUI_grbl.cy.js:13`
- `cypress/e2e/grblHal/loadUI_grblHal.cy.js:13`

They were already wrong before this fork touched anything – the repo is at 1.6.4. On a fork build they are wrong twice over, because the title also carries the fork marker (`gSender 1.6.4 (Marcin Obel)`, see [FORK.md](../FORK.md)). Pinning a version string in a test guarantees this; asserting a prefix, or reading the version from `package.json`, would not. Left unfixed – these specs need a real machine to run at all, so nothing exercises them in a normal dev loop.

Overall, the suite covers:

- UI load/reload robustness
- Device connect/disconnect flows
- Unlock/homing/zeroing workflows
- Upload/load G-code and verify file UI + visualizer presence
- Jogging and go-to location behaviour (including diagonal jog buttons in some tests)
- Job lifecycle: start/run/pause/stop and job end popup verification
- Console verification for commands and "job done" type outputs
- Probing workflows (grblHAL probing and TLS green validation)
- Spindle overrides and feedrate performance comparison
- Macros: import/edit/run/delete (and some UI export interactions)
- Visualizer rendering checks (canvas exists and relevant UI is enabled)
- Additional operations: coolant, probing-related config, rotary/surfacing, parking, movement tuning, and alignment helpers

## How the implementation is wired

### Cypress configuration

`cypress.config.js` sets:

- `specPattern`: **pinned to the single file** `cypress/e2e/grblHal/A_grblHal_master_spec.cy.js`. This is the most important thing to know about the config – `cypress run` and `cypress open` will only discover that one spec. To work on any other file, either pass `--spec <path>` or temporarily widen `specPattern`.
- `baseUrl`: `process.env.BASE_URL`, defaulting to `http://localhost:8000`
- `supportFile`: `cypress/support/e2e.js`
- Reporter: `cypress-multi-reporters`, configured by `reporter-config.json`, which enables `mochawesome` (JSON only, into `cypress/reports/mochawesome/.jsons`) and `mocha-junit-reporter` (into `cypress/reports/junit/`). The HTML report is produced afterwards by the `report:*` scripts, not by the run itself.
- Timeouts: `pageLoadTimeout` 60 s, `defaultCommandTimeout` 10 s
- `env.deviceName`: from `CYPRESS_DEVICE_NAME`, defaulting to `COM`
- Browser settings: `chromeWebSecurity: false`, `experimentalModifyObstructiveThirdPartyCode: true`
- A `log` task, so specs can print to the terminal with `cy.task('log', ...)`

### Global Cypress support

`cypress/support/e2e.js` loads `./commands`, `cypress-real-events/support` (more realistic interactions), `cypress-mochawesome-reporter/register`, and `cypress-grep` (filtering/tag-like selection support).

It also globally ignores one known uncaught exception – errors containing `addUpdateRange is not a function`.

### Custom Cypress commands

`cypress/support/commands.js` defines the bulk of the reusable logic used by specs:

- Loading the UI reliably: `cy.loadUI(...)`
- Connecting and unlocking: `cy.connectMachine()` (GRBL), `cy.connectToGrblHAL()` (grblHAL), `cy.unlockMachineIfNeeded()`, `cy.autoUnlock()`, `cy.disconnectIfIdle()`
- Homing: `cy.enableAxisHomingAndHome()`, `cy.ensureHomingEnabledAndHome(...)`
- G-code upload: `cy.uploadGcodeFile(fileName?)` (defaults to `sample.gcode`)
- Motion helpers: `cy.goToLocation({ x, y, z })`, `cy.zeroXAxis()` / `Y` / `Z` / `A` / `cy.zeroAllAxes()`, and `cy.jog*Times(times, waitTime)` including the four diagonal combos
- Console helpers: `cy.sendConsoleCommand(...)`, `cy.clearConsole()`, `cy.verifyConsoleContains(...)`
- Verification helpers: `cy.verifyMachineStatus(...)`, `cy.verifyAxes(x, y, z)` (tolerance-based), `cy.checkProbingIsActive(...)`, `cy.waitUntilIdle()`
- Job helpers: `cy.stopJobAndGetDetails()` (extracts status/time/errors from the Job End popup)
- Navigation and settings: `cy.goToCarve()`, `cy.goToStats()`, `cy.goToTools()` (`commands.js:1083`), `cy.goToConfig()` (`commands.js:1087`), `cy.searchInSettings(...)`, `cy.applySettings(...)`
- Input: `cy.forceInput(selector, value)` (`commands.js:606`) – clears, types and blurs with `{ force: true }`, then asserts the field holds the value

Two names – `loadUI` and `verifyMachineStatus` – are registered more than once in this file. Cypress keeps the **last** registration, so read the bottom-most definition when debugging behaviour that does not match the first one you find.

### Entry "master" specs

The suite has "master" files that pull in many module specs and act like a runner:

- GRBL: `cypress/e2e/grbl/grbl_master_spec.cy.js`
- grblHAL: `cypress/e2e/grblHal/A_grblHal_master_spec.cy.js`

## What you need before running

1. The gSender UI/server must be reachable at the configured `BASE_URL` (default `http://localhost:8000`). Start it with `npm run dev` or a production build.
2. A CNC machine must be available and connectable through gSender – the tests perform real connection workflows via the UI.
3. The machine should be able to reach the expected states. Many tests wait for `Idle`, with timeouts from tens of seconds up to minutes for long operations.
4. You must provide `cypress.env.json` at the project root. It is git-ignored, so it stays local and private.

## Environment file

The committed template is `cypress.envexample.json` at the repo root. Copy it to `cypress.env.json` and fill it in.

| Key | Purpose |
|---|---|
| `grbl_port` | Port of your GRBL machine, used for connecting |
| `grblhal_port` | Port of your grblHAL machine, used for connecting |
| `file` | Path to the G-code file the specs load |
| `X+Y+`, `X-Y-`, `X+Y-`, `X-Y+` | Diagonal jog shortcut keys, in Cypress key syntax (for example `{alt}{leftArrow}`) |
| `devicePrefix` | **Not in the template – add it by hand.** Used by `cypress/e2e/grblHal/unlock_machine.spec.grblhal.cy.js`, which falls back to `COM` when it is missing. Set it to the prefix your port labels share in the connection dialog (for example `COM` on Windows, `tty` on macOS/Linux) |

## How to run

Interactive:

1. Start the server so the UI is available at `BASE_URL`.
2. Create or update `cypress.env.json`.
3. `npm run cypress:open`
4. Select E2E, pick a browser, then pick a spec – remembering the `specPattern` restriction above.

Headless, with the full grblHAL report pipeline: `npm run testgrblhal` – **Windows only**. It opens with `report:clean` and closes with `dashboard:open`, both `cmd.exe` syntax, so on macOS or Linux it stops at the first step.

**Three of the report scripts are Windows-only.** `report:clean` uses `cmd.exe` syntax (`if exist`, `rmdir /s /q`), and `report:open` / `dashboard:open` use `start`. `report:merge` and `report:generate` run anywhere. On macOS or Linux, run Cypress directly and then `npm run report:merge && npm run report:generate && npm run dashboard:generate`, opening the HTML yourself.

### What success looks like

The machine reaches states like `Idle`, job end popups show a completion status, and key UI components (file name, visualizer canvas, buttons) are enabled and visible.

## Reports and artifacts

- Mochawesome JSON: `cypress/reports/mochawesome/.jsons`, merged to `merged.json`, rendered to `cypress/reports/html`
- JUnit XML: `cypress/reports/junit`
- Dashboard: generated by `cypress/dashboard/generate-dashboard.js` into `cypress/dashboard/report`
- Some specs write JSON results to `cypress/results/*` via `cy.writeFile(...)` – for example the spindle and feedrate comparison outputs

All of `cypress/reports`, `cypress/results`, `cypress/screenshots`, `cypress/videos` and `cypress/downloads` are git-ignored.

## Troubleshooting

**Hover glitch during connect.** Sometimes the hover does not register. If a test hangs while trying to connect and then fails, this is the usual cause. Hover over the connection bar yourself, or retry the test until it works. The root cause is not known – it may be ours or Cypress's.

**Noisy uncaught exception.** `cypress/support/e2e.js` already ignores `addUpdateRange is not a function`; you should not need to add another ignore for it.

## Extending the suite

- Prefer reusing existing commands in `cypress/support/commands.js` over writing new selectors.
- Keep assertions tied to visible UI state or machine state transitions (`Idle`, `Running`, job end popup) rather than to internals.
- Use timeouts comparable to neighbouring specs for machine-dependent operations.
- For settings interactions, use `cy.searchInSettings(...)` / `cy.applySettings(...)` to match existing patterns.
- Cypress API reference: <https://docs.cypress.io/api/table-of-contents>
