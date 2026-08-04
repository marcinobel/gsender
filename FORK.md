# This fork

A private fork of [Sienci-Labs/gsender](https://github.com/Sienci-Labs/gsender) carrying two
behavioural fixes. It exists because **stock gSender cannot complete a tool change** on a machine
that needs the `Flexible Re-zero` strategy – the wizard never sends its probe G-code. The second fix
came out of the first: gSender's end-of-job planner drain had stopped working on Grbl, so "job
complete" could be reported while the machine was still moving.

Nothing here goes back upstream. That is a settled decision, stated at the top of
[CLAUDE.md](CLAUDE.md) and enforced by a `PreToolUse` hook.

| | |
|---|---|
| Fork point | `c5fb9b7` (`Semver`) on `Sienci-Labs/gsender` master – version **1.6.4** |
| Fix 1 – tool-change wizard | `82ec1fe9` on `fix/flexible-rezero-wizard-never-sends-gcode` – **one file**, +34 −39 in `src/app/src/wizards/semiautoToolchange.tsx`. Field-verified on a Two Trees TTC450 Ultra, GRBL 1.1 fork, macOS, 2026-08-04 |
| Fix 2 – `%wait` planner drain | `fix/1-wait-planner-drain-never-fires-appended-dwell-line` – both controllers plus a new `src/server/lib/` helper, with the repo's first server-side controller tests. **Hardware verification pending** |
| Also on the branches | `c0c605a6` docs sync, `d9bc425f` the no-upstream guard – neither is part of either fix |

## Fix 1 – the tool-change wizard never sends its probe G-code

**The `Flexible Re-zero` tool-change wizard never sends its probe G-code.** Pressing **Probe Changed
Tool** does nothing at all – no motion, no error, no timeout. The step displays `Running…` and
**Next** stays disabled for ever while the machine sits `Idle`.

Present in 1.6.3 as shipped and in upstream master at 1.6.4.

### Mechanism

Wizard action buttons are rendered by `src/app/src/features/Helper/components/Actions.tsx`, which
declares its contract as

```ts
interface WizardAction {
    label: string;
    gcodeLines: string[];
}
```

and on click runs `controller.command('wizard:step', …)` followed by
`controller.command('gcode', action.gcodeLines)` (`Actions.tsx:175-180`).

`semiautoToolchange.tsx` was the only wizard still declaring its actions the older way, as `cb`
callbacks. **Nothing in the application ever invokes `action.cb`.** So `action.gcodeLines` was
`undefined` for all three of that wizard's buttons – **Probe Initial Tool**, **Probe Changed Tool**
and **Resume Cutting** – and the intended G-code never left the app.

The click still set `isLoading`, which is cleared only when the backend publishes `wizard:next` after
the G-code completes. No G-code, no event, permanent `Running…`.

Two reasons it survived, both worth remembering when working in this codebase:

- **TypeScript did not catch it.** The wizard objects are never typed against `WizardAction`. This is
  the concrete cost of the missing typecheck described in [CLAUDE.md](CLAUDE.md) – a shipped feature
  that could not work at all.
- **It was a half-finished migration.** Upstream `8b3e86a9 "JSX->TSX for helper"` converted
  `Actions.jsx → Actions.tsx` and introduced the `WizardAction` interface, but touched **no wizard
  files**. The other wizards already happened to use `gcodeLines`; `semiautoToolchange` used `cb` and
  was orphaned.

### The fix

Convert the three actions to `gcodeLines`. **The emitted G-code is byte-identical** – this is a
plumbing fix, not a change to what the machine is asked to do.

`getUnitModal()` moves from click time to wizard-construction time. That is equivalent because it
reads `$13`, a controller setting that cannot change mid-job (`src/app/src/lib/toolChangeUtils.ts:56`).

No `cb:` action declarations remain anywhere under `src/app/src/wizards/` or
`src/app/src/features/Helper/`, so the migration is now complete.

### Verified on real hardware

Two independent confirmations, both 2026-08-04:

1. **The probe alarm is the proof.** Running an air program on the patched build, the wizard executed
   a real `G38.2`, failed to reach the puck, and the controller raised **`ALARM:5`** – GRBL's
   probe-fail alarm. GRBL can only raise `ALARM:5` *after executing a probe move*. Before the fix no
   probe command reached the controller, so no alarm of any kind was possible.
2. **It then did the real job.** The patched build ran a five-operation programme with two cutter
   swaps and three wizard stops to `COMPLETE` – all 104,779 lines in 47 min 24 s.

## Fix 2 – the `%wait` planner drain stopped firing on Grbl

**Every job on Grbl ended without draining the planner.** gSender appends a `%wait` line to the end
of every program precisely so that "job complete" means the machine has stopped. Since `93a0e53fc`
(2026-05-26) that line no longer matched, so the sender never held, and completion could be reported
while the machine was still retracting and spinning down. Every job load also logged a parse error in
`server.log`.

Tracked as [issue #1](https://github.com/marcinobel/gsender/issues/1). Present in upstream master at
1.6.4.

### Mechanism

The controller built the appended line as `"%wait ; Wait for the planner to empty"`, while the sender
compared for exact equality against the constant `WAIT` (`"%wait"`) – and comments are stripped only
from lines that do *not* start with `%`:

```js
if (line[0] !== "%") {        // GrblController.js:482
    line = line.replace(bracketCommentLine, "").trim();
    line = line.replace(commentMatcher, "").trim();
}
…
if (line === WAIT) {          // WAIT = "%wait"
```

The comparison failed, the line fell through to the JavaScript expression evaluator, that tried to
parse `wait ; Wait for the planner to empty` and threw, and the filter returned `""`. **GRBL
acknowledges a line when it is accepted into the planner buffer, not when the move has finished** –
the dwell is the only thing that closes that gap, and it was inert.

Two things are worth carrying forward:

- **It was a regression, not old breakage.** The drain worked from 2018 until `93a0e53fc`
  (2026-05-26, "Fix for regex stripping comments stripping out evaluated expressions") added the
  `line[0] !== "%"` guard – correctly, to stop the bracket regex mangling `%` expressions. Two days
  later `50e63eb54` ("Bracket comment updates for feeder only") restored unconditional stripping on
  the **feeder** path only. The asymmetry is that pair of commits, and it is 1.6.x-era.
- **One string, two files, no shared constant.** The literal was built in the `gcode:load` handler
  and matched a thousand lines away in the sender's filter. Nothing tied them together, so nothing
  broke when one of them moved.

### The fix

Two independent halves. Either alone makes the drain work; both are applied because they fail
independently.

- **The token comparison.** A new `src/server/lib/strip-semicolon-comment.js`; both controllers now
  compare `%` lines against the tokens using a throwaway `;`-stripped copy
  (`const token = stripSemicolonComment(line)`). `line` itself is never mutated on this path, so the
  evaluator receives byte-identical input to before. **Brackets are deliberately never stripped from
  a `%` line:** there `(…)` is a function call, and Grbl's greedy `/\s*\(.*\)*\)/gm` would reduce the
  documented `%global.tool = Number(tool) || 0` to `%global.tool = Number || 0` – which still parses,
  and silently assigns the `Number` function as a tool number. A `token === "%"` short-circuit was
  added alongside, so a `%` line that is only a comment stops producing evaluator errors.
- **The constructed line.** `GrblController.js:1630` reads `const dwell = WAIT;` instead of restating
  the literal with a comment baked in, so the two strings cannot drift apart again. The kill switch
  for the behaviour change is `const dwell = "";` – `Sender.load()` drops blank lines, so line
  accounting is unaffected.

**grblHAL keeps no end-of-program dwell**, so nothing about its job completion changes. It was
disabled deliberately by `982a4ec31` (2023-10-18, "Fix for motor holding is removing the dwell")
after being active when that controller was forked from the Grbl one (`4fa9480c1`); the commit
records no mechanism, so re-enabling it is not a call to make from the code alone. grblHAL does get
the token half, so a `%wait` a user puts in their own file – with or without a trailing comment – is
honoured there now. That is a widening of what is recognised, not a change to end of job.

### Verified by tests – hardware verification pending

`npm test`: 11 suites, 97 tests, 94 passed, 3 skipped (all three pre-existing). Three of the suites
are new, including the repo's **first server-side controller tests**. They cover the appended line
being exactly `%wait`, the hold firing for `%wait` both with and without a trailing comment, line
accounting staying put, `%` expressions evaluating untouched, and grblHAL still appending nothing.

**This has not been run on a machine.** What the tests cannot show, and what should be confirmed
before trusting it mid-project:

1. A program ending in a long rapid shows one `G4 P0.5` after the last line, and "job complete"
   arrives *after* the machine stops rather than during the retract.
2. The job does not stall on that last line. The sender now waits for one more `ok` than it used to;
   if the machine alarms or disconnects during the dwell, that `ok` never arrives – and the error
   path does not release a sender hold (item 14 in [fork/known-issues.md](fork/known-issues.md)).
3. grblHAL end-of-job behaviour is bit-identical to before.

## Rebase posture

**Upstream master had no commits after the fork point** as of 2026-08-04.

More usefully, neither patch diverges from what the code already claims to do. Fix 1 restores the
renderer's own declared contract; fix 2 makes the sender recognise the line the controller was
already appending. A future upstream fix should merge cleanly or supersede either outright.

The rebase surface is one renderer file plus three hunks in each controller – and the controllers are
the files upstream churns most. The comparison logic itself lives in a new file under
`src/server/lib/`, which is a conflict-free add, so what has to be re-applied by hand is one import
and one changed comparison per controller. The new tests are add-only; `jest.config.js` carries one
added `moduleNameMapper` line.

## Further reading

- [fork/known-issues.md](fork/known-issues.md) – seventeen defects and behavioural traps verified in
  this codebase while fixing the above. One of them (the `%wait` planner drain) is patched here; the
  rest are not. Two are genuine hazards – `Resume Cutting` restarts the spindle unconditionally, and
  a G-code file can execute arbitrary JavaScript
- [fork/running-from-source.md](fork/running-from-source.md) – building, the two silent Electron
  entry-point traps, and where settings actually live
- [CLAUDE.md](CLAUDE.md) – the no-upstream rule and how it is enforced
