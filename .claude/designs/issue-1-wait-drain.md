# Issue #1 — `%wait` planner drain (design record)

> **Superseded — historical record only.** This is the point-in-time architecture plan written
> *before* implementation. It is kept for the reasoning it captures, not as a description of what
> shipped. **For the current state of the fix, read [FORK.md](../../FORK.md) and
> [fork/known-issues.md](../../fork/known-issues.md) item 2** — those are maintained; this is not.
>
> Do not treat anything below as a description of the code. Review rounds changed the plan in
> several places, listed immediately below.

Target: `marcinobel/gsender` (private fork). Shipped on branch
`fix/1-wait-planner-drain-never-fires-appended-dwell-line` (this document's original
`bugfix/wait-planner-drain` was never used).

> **Corrections, added after implementation.** Four things below are stale:
>
> 0. **"Has never fired" (title, §0) is wrong.** The drain worked from 2018 until `93a0e53fc`
>    (2026-05-26) added the `line[0] !== "%"` guard; `50e63eb54` two days later restored unconditional
>    stripping on the feeder path only. It is a 1.6.x regression, not original breakage.
> 1. **The helper was renamed.** `stripLineComment` → `stripSemicolonComment`, and
>    `src/server/lib/strip-line-comment.js` → `src/server/lib/strip-semicolon-comment.js` (the test
>    file likewise). The old name appears 8 times below; read it as the new one.
> 2. **The helper's regex lost its leading `\s*`.** It ships as `/;.*/`, not `/\s*;.*/`: the `\s*`
>    made the match quadratic on a long whitespace run containing no `;`, and the `.trim()` removes
>    that whitespace anyway. §1.5 and §2.1 still show the old form.
> 3. **§7.5 step 1 is wrong.** See the correction note in that section.
>
> Also worth knowing: the grblHAL comment as written (§4.1) hedges the motor-holding mechanism as a
> reconstruction rather than stating it as the reason, because `982a4ec31` records none.

---

## 0. Overview

The Grbl controller appends `%wait ; Wait for the planner to empty` to every loaded program, but the
sender's `%`-token comparison is an exact string equality against `"%wait"`, and `%` lines are
deliberately exempted from comment stripping. The token never matches, the line falls through to the
JavaScript expression evaluator, that logs a parse error, and the filter returns `""` — so the drain
has never happened and "job complete" does not mean "machine stopped".

The fix has two independent halves, deliberately both applied:

| Half | What it does | Protects against |
|---|---|---|
| A. Token comparison | Compare `%` lines against the tokens on a **throwaway** `;`-stripped copy | Any `%wait` that arrives carrying a comment — from a user's file, a macro, or a future upstream change |
| B. Constructed line | `const dwell = WAIT;` instead of a literal with a comment baked in | The controller's own appended line, independent of the filter logic |

Half A never mutates `line`. The line handed to `evaluateAssignmentExpression` is byte-identical to
today's. This is the property that makes the broad fix safe, and it is the design's load-bearing
constraint.

---

## 1. Design decision on the fix shape

### 1.1 The constraint that dictates the shape

`93a0e53fc` (2026-05-26, "Fix for regex stripping comments stripping out evaluated expressions")
added the `if (line[0] !== "%")` guard on purpose. In gSender's `%` syntax, parentheses are
**function calls**, not G-code comments. `src/server/lib/evaluate-assignment-expression.js` runs the
line through esprima and supports the full JavaScript expression grammar (`CallExpression`,
`SequenceExpression`, member access). The user-facing macro docs at
`src/app/src/features/Macros/constants.ts:30-79` ship exactly this:

```
%global.tool = Number(tool) || 0
%prevTool = Number(global.tool) || 0, global.tool = tool
```

Grbl's `bracketCommentLine` is `/\s*\(.*\)*\)/gm` — **greedy**, spanning the first `(` to the last
`)`. Applying it to the first example yields `%global.tool = Number || 0`, which still *parses*, so
the corruption would be **silent**: `global.tool` would be set to the `Number` function
(`Number` is in `GLOBAL_OBJECTS`, `src/server/controllers/constants.js:36`) instead of a tool number.
A wrong tool number is a machine-safety concern, not a cosmetic one.

**Therefore:** the fix must not put `line` through any regex on the `%` path. It may derive a
throwaway copy for the token comparison only.

### 1.2 Chosen shape

Compare against a local `const token` produced by a shared helper that removes only a `;` comment.
The guard at `GrblController.js:481-484` / `GrblHalController.js:507-510` is **not touched at all** —
the diff is confined to the `if (line[0] === "%")` block. That is deliberate: 93a0e53fc's fix stays
exactly as its author wrote it.

### 1.3 Grbl — `src/server/controllers/Grbl/GrblController.js`

Import, after line 44 (`extract-realtime-commands`):

```diff
 import { extractRealtimeCommands } from "../../lib/extract-realtime-commands";
+import { stripLineComment } from "../../lib/strip-line-comment";
```

Sender `dataFilter`, lines 489-503 (tabs, double quotes, matching the file):

```diff
 				if (line[0] === "%") {
+					// Compare against the % tokens on a throwaway copy with any `;`
+					// comment removed. `line` itself must stay untouched: in a %
+					// line the parentheses and commas are JavaScript, not G-code
+					// comments, and stripping them would silently corrupt the
+					// expression (see 93a0e53fc). The feeder has stripped `;`
+					// before the same comparison since 50e63eb54; this restores
+					// parity on the sender path.
+					const token = stripLineComment(line);
+
 					// %wait
-					if (line === WAIT) {
+					if (token === WAIT) {
 						log.debug(
 							`Wait for the planner to empty: line=${sent + 1}, sent=${sent}, received=${received}`,
 						);
 						this.sender.hold({ data: WAIT }); // Hold reason
 						return "G4 P0.5"; // dwell
 					}
 
+					// A % line that is nothing but a comment carries no expression
+					if (token === "%") {
+						return "";
+					}
+
 					// Expression
 					// %_x=posx,_y=posy,_z=posz
 					evaluateAssignmentExpression(line.slice(1), context);
 					return "";
 				}
```

Lines 481-488 (`if (line[0] !== "%") { … }`, `populateContext`, `const { sent, received }`) are
unchanged.

### 1.4 grblHAL — `src/server/controllers/Grblhal/GrblHalController.js`

Import after line 44, identical. Sender `dataFilter`, lines 515-529: **character-identical
replacement to §1.3.** Lines 507-514, including the dead `.replace("/uFEFF", "")` at 509, are
unchanged (see §4.2).

### 1.5 The three questions, answered explicitly

**Does the comparison copy get `.trim()`?** Yes, inside the helper.
`/\s*;.*/` swallows the whitespace *before* the `;`, so `"%wait ; drain"` → `"%wait"` with no
trailing space, and `Sender.js:213` already trims before calling `dataFilter`. The `.trim()` is
therefore redundant on the sender path today — it is kept because (a) it matches the feeder's
`.replace(commentMatcher, "").trim()` exactly, and (b) the helper must be correct for callers that
do not pre-trim. Cost: nothing.

**Does it handle a `%` line that is only a comment (`%; note`)?** Yes, and this is new behaviour.
The copy becomes `"%"`, which matches no token, so today the line reaches the evaluator as
`"; note"`; esprima parses that as an `EmptyStatement`, `.body[0].expression` is `undefined`,
reading `.type` throws, the `catch` at `evaluate-assignment-expression.js:134` logs two errors, and
`""` is returned. The new `if (token === "%") return "";` short-circuit produces the same return
value with no error log. This is included because AC5 ("no evaluator error for a clean program
load") is otherwise violated by any job file containing a `%`-prefixed comment line. It cannot
affect an expression: a line that is `%` plus a comment has no expression by construction.

**What happens to a line that becomes empty after stripping?** On the `%` path it cannot: the copy
always retains the leading `%`, so it is never empty. On the non-`%` path nothing changes — an empty
`line` still returns from the filter as `""`, and `Sender.js:230-233` increments `sent`, calls
`ack()`, and continues. Line accounting is untouched (AC6).

### 1.6 Why this cannot corrupt expressions — the argument in one line

`line` is read-only on the `%` path. The only observable change for a non-`%wait` `%` line is the
`token === "%"` short-circuit, which returns the same `""` the evaluator path already returns. For
every other input in the language, the function is byte-for-byte the same as today.

### 1.7 Known limitation, accepted and documented

`%x = 1 ; set x` still reaches the evaluator with the comment attached and still logs a parse error.
Fixing that would require feeding the stripped copy to the evaluator, which reintroduces exactly the
corruption 93a0e53fc fixed (a `;` inside a string literal, e.g. `%global.msg = "a;b"`). The
fidelity-preserving choice is correct: it changes behaviour for **one** input class (a line whose
stripped form is a recognised token) and is a no-op for everything else. Record this in
`fork/known-issues.md`; do not fix it here.

---

## 2. Shared helper vs duplicated inline code

**Recommendation: shared helper**, `src/server/lib/strip-line-comment.js`.

Reasoning specific to this repository:

1. **The two controllers have already drifted on this exact code.** `bracketCommentLine` is
   `/\s*\(.*\)*\)/gm` in Grbl and `/\([^\)]*\)/gm` in grblHAL — same variable name, different
   semantics. `gcode:load` takes `meta` (an object) in Grbl and `name` (a string) in grblHAL. The
   `/uFEFF` no-op exists only in grblHAL. Copy-pasting a fourth divergent copy of comment-stripping
   into both files is how this bug class reproduces.
2. **A tiny pure function in `src/server/lib/` is the established convention**, not an invention:
   `delay.js` is 3 lines, `ensure-positive-number.js`, `decimal-places.js`,
   `extract-realtime-commands.js` (the newest of them, and the closest structural template) are all
   single-function modules.
3. **Fork-rebase economics.** This fork rebases onto upstream. A brand-new file in
   `src/server/lib/` is a conflict-free add. Putting the logic there shrinks each controller hunk to
   one added `const` plus a changed comparison — the smallest possible footprint in the two files
   upstream churns most.
4. **Testability.** The strip semantics become testable with zero mocking and zero controller
   construction (§5.1), which matters given the import-time hazards documented in §5.4.

Counter-argument considered and rejected: "the controllers are intentionally parallel, keep them
self-contained." They already import eight shared helpers each (`delay`, `translate-expression`,
`evaluate-assignment-expression`, `extract-realtime-commands`, …). One more is consistent, not novel.

### 2.1 The helper

Path: `/Users/marcinobel/Projects/gsender/src/server/lib/strip-line-comment.js`
Style: 4 spaces, single quotes, named export, JSDoc, GPLv3 header — matching
`extract-realtime-commands.js` (its nearest neighbour), **not** the controllers' tabs/double quotes.
`.prettierignore` excludes all of `src/server`, so this is a judgement call; matching the file it
sits next to is the right one.

```js
/*
 * Copyright (C) 2021 Sienci Labs Inc.
 *
 * This file is part of gSender.
 *
 * gSender is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, under version 3 of the License.
 *
 * gSender is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with gSender.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Contact for information regarding this program and its license
 * can be sent through gSender@sienci.com or mailed to the main office
 * of Sienci Labs Inc. in Waterloo, Ontario, Canada.
 *
 */

// A `;` line comment and any whitespace in front of it. Deliberately not
// global: on a single line the first match already runs to end-of-line, and a
// module-level /g regex carries lastIndex state that is easy to misuse later.
const LINE_COMMENT = /\s*;.*/;

/**
 * Removes a trailing `;` line comment from a single line.
 *
 * Intended for *comparing* a line against the `%` command tokens (`%wait`,
 * `%pause_start`, …) without mutating the line. A `%` line is a JavaScript
 * expression, where parentheses and commas are syntax rather than G-code
 * comments, so callers must keep the original line for the evaluator and use
 * this result only for the comparison.
 *
 *   '%wait'                     → '%wait'
 *   '%wait ; drain the planner' → '%wait'
 *   '%; note'                   → '%'
 *   'G0 X1 ; move'              → 'G0 X1'
 *
 * @param {string} line  A single line of G-code or a `%` command.
 * @returns {string} The line with any `;` comment removed, trimmed.
 */
export function stripLineComment(line) {
    return String(line).replace(LINE_COMMENT, '').trim();
}
```

**Not changed:** the feeder's `dataFilter` in either controller. It strips `;` unconditionally into
`line` because it also needs `commentString` for the M0/M1/M6 events — different semantics, working
today, out of scope.

---

## 3. The `const dwell` change

`GrblController.js:1610`:

```diff
 				// G4 P0 or P with a very small value will empty the planner queue and then
 				// respond with an ok when the dwell is complete. At that instant, there will
 				// be no queued motions, as long as no more commands were sent after the G4.
 				// This is the fastest way to do it without having to check the status reports.
-				const dwell = "%wait ; Wait for the planner to empty";
+				const dwell = WAIT;
```

The four-line explanatory block above it stays. Line 1637 (`this.sender.load(name, gcode + "\n" +
dwell, context)`) is unchanged.

**Reuse `WAIT`, not a new literal** — that satisfies AC1 ("the appended line is exactly the WAIT
constant") and AC8 (one `"%wait"` literal per controller), and removes the possibility of the two
strings drifting again, which is the entire defect.

**Is it still necessary given the dataFilter fix?** No — either half alone makes the drain work.
**Do both anyway.** Justification:

- The two halves fail independently. Half B protects the controller's own line even if someone later
  narrows the token comparison; half A protects every *other* source of `%wait` — a user's file, a
  macro pasted into a job, a future upstream edit that re-adds the comment.
- Half B costs one line and is the **rollback lever**: reverting `const dwell = WAIT;` back to the
  commented literal disables the drain at the machine while leaving the correctness fix in place. A
  one-line, zero-risk kill switch for a change that alters job-completion semantics is worth having.
- Nothing is lost by dropping the inline comment text. `sender.on("data")`
  (`GrblController.js:644-660`) emits the **filtered** line — `G4 P0.5` — to `serialport:read`, so
  the words "Wait for the planner to empty" never reach the user's console or the serial log.
- Verified no side effect on rotary detection: `checkIfRotaryFile` (`src/server/lib/rotary.js:1-6`)
  runs on `gcode + "\n" + dwell` and strips `;` comments before testing `content.includes('A')`.
  Both the old and the new dwell reduce to `%wait`, which contains no capital `A`.

---

## 4. grblHAL changes

### 4.1 The disabled dwell at `GrblHalController.js:1911`

Do **not** enable it. Replace the broken commented-out line so it cannot be re-enabled in a form the
sender rejects, and record why it is off:

```diff
 				// G4 P0 or P with a very small value will empty the planner queue and then
 				// respond with an ok when the dwell is complete. At that instant, there will
 				// be no queued motions, as long as no more commands were sent after the G4.
 				// This is the fastest way to do it without having to check the status reports.
-				//const dwell = '%wait ; Wait for the planner to empty';
+				//
+				// Deliberately not done on grblHAL. The dwell was active when this
+				// controller was forked from the Grbl one (4fa9480c1) and was removed by
+				// 982a4ec31, "Fix for motor holding is removing the dwell": grblHAL can
+				// de-energize steppers per axis after an idle delay ($1/$37), which Grbl
+				// cannot, and the buffer sync a dwell forces at end of program can start
+				// that timer while the machine is still settling. If it is ever
+				// re-enabled it must be the bare token — `const dwell = WAIT;` — because
+				// the sender compares `%` lines against the token, not against a token
+				// plus a comment. See issue #1.
```

Line 1925 (`this.sender.load(name, gcode + "\n", context)`) is unchanged. There is **no functional
change to grblHAL's `gcode:load`** — AC7 is a regression guard, not a new behaviour.

Note this also keeps AC8 satisfiable for grblHAL: the replacement text contains no quoted `"%wait"`
literal, so line 103 remains the only one.

### 4.2 The dead `.replace("/uFEFF", "")` at line 509 — **leave it**

It is a literal string `"/uFEFF"` (forward slash, not a backslash escape), which never occurs in
G-code, so the call is a no-op. The author almost certainly meant `/﻿/g` — stripping a UTF-8
BOM.

Recommendation: **do not touch it.**

- It sits on the non-`%` path, which this change never enters. Touching it widens the diff into code
  the fix has no business in.
- "Fixing" it is not cosmetic — it would newly strip BOM characters from every line, a real,
  untested behaviour change on the streaming hot path, bundled into a change that already alters
  job-completion semantics. Two behaviour changes in one commit is how you lose the ability to
  bisect a field report.
- Merely deleting it is behaviour-neutral but still an extra hunk in a file this fork must rebase
  onto upstream.

Record it in `fork/known-issues.md` instead. This fork already has the convention (commit
`78d815be2`, "docs: record what the fork patches, and what it found but did not").

---

## 5. Test plan

Two new test files plus one `jest.config.js` line. This is the repo's first controller-level server
test; the pure-helper file exists so that the *logic* is covered even if the controller harness
proves brittle.

### 5.1 `src/server/lib/__tests__/strip-line-comment.test.js`

No mocks, no timers, no imports beyond the helper. Follows `GcodeToolpath.test.js` (plain imports,
no GPLv3 header — tests are exempt by precedent).

| # | Case | Assertion |
|---|---|---|
| S1 | `'%wait'` | → `'%wait'` (no comment, unchanged) |
| S2 | `'%wait ; Wait for the planner to empty'` | → `'%wait'` |
| S3 | `'%wait;drain'` | → `'%wait'` (no space before `;`) |
| S4 | `'%global.tool = Number(tool) \|\| 0'` | unchanged — parentheses survive |
| S5 | `'%prevTool = Number(global.tool) \|\| 0, global.tool = tool'` | unchanged — commas and nesting survive |
| S6 | `'%; note'` | → `'%'` |
| S7 | `'G0 X1 ; move'` | → `'G0 X1'` |
| S8 | `'  %wait  '` | → `'%wait'` |

### 5.2 `src/server/controllers/Grbl/__tests__/GrblController.test.js`

**Mock (required — see §5.4):**

```js
jest.mock('../../../lib/logger', () => {
    const entry = {
        error: jest.fn(), warn: jest.fn(), info: jest.fn(),
        verbose: jest.fn(), debug: jest.fn(), silly: jest.fn(),
    };
    const logger = () => entry;
    logger.__entry = entry;
    return { __esModule: true, default: logger, levels: [], getLevel: () => 'error', setLevel: () => {} };
});
```

One factory covers every consumer — `Sender`, `Feeder`, `configstore`,
`evaluate-assignment-expression` and both controllers all resolve to the same module path, so all of
them share `__entry` and AC5 can assert on `__entry.error`.

**Fakes (corrected — the brief's shape is missing `emitToSockets`):**

```js
const makeConnection = () => ({
    isOpen: false,
    setWriteFilter: jest.fn(),
    write: jest.fn(),
    writeImmediate: jest.fn(),
    isNetwork: () => false,
    emitToSockets: jest.fn(),   // REQUIRED: GrblController.emit() (:1538-1540) delegates here
});
const engine = {};              // truthiness only (:228-230)
```

**Harness:**

```js
beforeEach(() => {
    connection = makeConnection();
    controller = new GrblController(engine, connection, { port: '/dev/null', baudrate: 115200 });
    controller.settings = { settings: {} };  // populateContext (:1271) destructures this
});
afterEach(() => {
    controller.destroy();   // clears the 250ms queryTimer (:1155, cleared at :1364-1367)
    jest.clearAllMocks();
});
```

Verified: the constructor creates exactly one interval (`this.queryTimer`, 250 ms, `:1155`);
`_.throttle(…, 500)` at `:1115-1153` is a throttle, not a timer; `ToolChanger` creates no interval
until `addInterval()` is called. `destroy()` is sufficient — no fake timers needed.

**Cases:**

| # | AC | Test | Assertion |
|---|---|---|---|
| T1 | AC1 | `controller.command('gcode:load', { name: 'job' }, 'G21\nG0 X1\nG0 X2')` | `sender.state.lines.at(-1) === '%wait'` — exact equality, not `startsWith` |
| T2 | AC6 | same load | `sender.state.total === 4`; `sender.state.sent === 0`; `sender.state.received === 0`; blank/whitespace lines in the input are still dropped (`Sender.js:335`) |
| T3 | AC2 | `sender.dataFilter('%wait', {})` | returns `'G4 P0.5'`; `sender.state.hold === true`; `sender.state.holdReason.data === '%wait'` |
| T4 | AC3 | `sender.dataFilter('%wait ; Wait for the planner to empty', {})` | identical to T3 — **this is the regression test for the defect** |
| T5 | AC3 | `sender.dataFilter('%wait;x', {})` and `sender.dataFilter('%wait   ; x', {})` | identical to T3 |
| T6 | AC4 | `sender.dataFilter('%global.width = Number(xmax) \|\| 0', { xmax: 42 })` | returns `''`; **`controller.sharedContext.width === 42`** |
| T7 | AC5 | after a load of a clean program, drive every line through `sender.dataFilter` | `logger.__entry.error` not called |
| T8 | AC5 | `sender.dataFilter('%; a comment line', {})` | returns `''`; `logger.__entry.error` not called |
| T9 | — | end-to-end hold/release: after T3, `controller.runner.emit('ok', …)` with `workflow.state === 'running'` | `sender.state.hold === false` (the unhold at `:809-814` fires) — optional depth, not an AC |
| T10 | AC8 | `fs.readFileSync(GrblController.js, 'utf8').match(/['"]%wait['"]/g).length === 1` | source-text guard |

**Why T6 is written that way.** The obvious `%global.tool = Number(tool) || 0` does **not**
discriminate: `populateContext` (`:1336`) overwrites `context.tool` from the runner, which is `0` at
rest, and a bracket-stripped `Number || 0` would also land on a falsy-ish value. `xmax` survives as
`Number(context.xmax) || 0` (`:1299`), so a correct evaluation gives exactly `42` while the
corrupted `global.width = Number || 0` gives the `Number` **function** (`Number` is in
`GLOBAL_OBJECTS`). `sharedContext` is the same object `populateContext` exposes as `global`
(`:214`, `:1295`), so asserting on `controller.sharedContext` reads the evaluator's actual output.

### 5.3 `src/server/controllers/Grblhal/__tests__/GrblHalController.test.js`

Same harness. Cases:

| # | AC | Test | Assertion |
|---|---|---|---|
| H1 | AC7 | `controller.command('gcode:load', 'job', 'G21\nG0 X1\nG0 X2')` — note grblHAL takes `name` as a **string**, Grbl takes a `{ name }` **object** | `sender.state.lines.at(-1) === 'G0 X2'`; `sender.state.total === 3`; no line equals `'%wait'` |
| H2 | AC2/AC3 | `sender.dataFilter('%wait ; drain')` | returns `'G4 P0.5'`, holds — the token fix applies to grblHAL too, even though nothing appends the token today |
| H3 | AC4 | as T6 | expression survives |
| H4 | AC8 | `/['"]%wait['"]/g` count in the source | `=== 1` |

### 5.4 `jest.config.js` — two required changes

**(a) `server/` path mapping — required for §5.3 only.** `GrblHalController.js:100` imports
`"server/lib/YModemUSB"`; `GrblHalRunner.js` and `GrblHalLineParser.js` use the same bare prefix
(5 files total, verified). Without a mapping the grblHAL controller cannot be imported under jest at
all.

```diff
   '^app-root/(.*)$': '<rootDir>/$1',
+  '^server/(.*)$': '<rootDir>/src/server/$1',
```

Risk: **low.** The pattern only matches bare specifiers beginning with `server/`; there is no
`node_modules/server` package (verified); no app-side code uses the prefix (verified by grep). It
mirrors the existing `^app/(.*)$` and `^app-root/(.*)$` entries and the esbuild plugin's server-side
resolution, so it makes jest agree with the production bundler rather than inventing a rule.

Secondary risk, to confirm at implementation time: importing the grblHAL controller pulls in
`@serialport/parser-byte-length`, `@serialport/parser-readline`, `crc-full`, `buffer-chunks` (via
`YModemUSB`) and `basic-ftp` (via `GrblHALFTP`). All are CJS with a `main` entry (verified for
`@serialport/parser-byte-length`, `crc-full`, `basic-ftp`), so `transformIgnorePatterns` should not
need widening. If one turns out to be ESM-only, add it to `transformIgnorePatterns` rather than
mocking the controller.

**(b) The `logger` mock is not optional — this is the trap.** `jest.config.js:18` maps
`'^(\\.{1,2}/)*config/settings$'` to the **app's** settings mock. `src/server/lib/logger.js:29`
imports `'../config/settings'`, which matches that pattern, so under jest the server logger receives
`src/app/src/config/__mocks__/settings.ts` — a module whose entire content is `{ version: '1.6.0' }`.
`logger.js:63` then evaluates `settings.winston.level` at module scope and throws
`TypeError: Cannot read properties of undefined`. `Sender.js:26` imports the logger, so **any**
controller test hits this.

This is why `GcodeToolpath.test.js` passes today: `GcodeToolpath.js` imports only
`gcode-interpreter`, so it never touches the logger.

I am confident in the file contents (all four read directly) but have **not executed jest** — treat
the failure mode as inferred-with-high-confidence and confirm on the first run. Mitigations, in
order of preference:

1. **`jest.mock('../../../lib/logger', …)` in the test file** (recommended). Scoped, deterministic,
   silences winston, prevents the `gsender_server_log.txt` File transport from being created in the
   repo root during tests, and gives AC5 its assertion target.
2. Narrow the `config/settings` mapping to app paths only. Broader blast radius across the existing
   app test suites; do not bundle it into this fix.

### 5.5 Coverage and hardware split

| AC | Covered by | Hardware needed? |
|---|---|---|
| AC1 | T1 | no |
| AC2 | T3, H2 | no |
| AC3 | T4, T5 | no |
| AC4 | T6, H3, S4, S5 | no |
| AC5 | T7, T8 | no |
| AC6 | T2 | no |
| AC7 | H1 | no |
| AC8 | T10, H4 | no |

All eight ACs are unit-testable. What is **not** unit-testable, and must be verified at the machine
before this is called done:

- **HW1.** Load and run a short program ending in a long rapid (e.g. `G0 Z40`). Confirm the console
  shows one `G4 P0.5` after the last program line, and that "job complete" now appears **after** the
  machine has stopped, not during the retract.
- **HW2.** Confirm no stall: the job reaches 100% and `workflow` returns to idle.
- **HW3.** Confirm a job containing a `%` expression line still sets the variable correctly (run a
  file with `%global.width = Number(xmax) || 0` and a macro that echoes it).
- **HW4.** grblHAL: confirm end-of-job behaviour is bit-identical to before (no dwell, motor holding
  unaffected).

Coverage target for the new code: the helper is 100% line/branch; the two `dataFilter` `%` branches
are fully exercised by T3-T8/H2-H3. Repo-wide coverage is not measured (`jest.config.js` sets no
`collectCoverage`) — do not add it in this change.

---

## 6. Files to change

| # | Path | Action | Nature |
|---|---|---|---|
| 1 | `src/server/lib/strip-line-comment.js` | **create** | Pure helper, ~10 lines of code + GPLv3 header + JSDoc. 4 spaces, single quotes, named export. |
| 2 | `src/server/controllers/Grbl/GrblController.js` | modify | Add import after `:44`. Rewrite the `%` branch at `:489-503` (add `const token`, compare `token === WAIT`, add the `token === "%"` short-circuit). Change `:1610` to `const dwell = WAIT;`. **Three hunks. `:481-488` untouched.** |
| 3 | `src/server/controllers/Grblhal/GrblHalController.js` | modify | Add import after `:44`. Same `%`-branch rewrite at `:515-529`. Replace the commented-out dwell at `:1911` with the explanatory block. **Three hunks. `:507-514` (incl. the `/uFEFF` no-op) untouched. No functional change.** |
| 4 | `jest.config.js` | modify | One line: `'^server/(.*)$': '<rootDir>/src/server/$1'`. |
| 5 | `src/server/lib/__tests__/strip-line-comment.test.js` | **create** | 8 cases, no mocks. |
| 6 | `src/server/controllers/Grbl/__tests__/GrblController.test.js` | **create** | 10 cases, logger mock + fake engine/connection. |
| 7 | `src/server/controllers/Grblhal/__tests__/GrblHalController.test.js` | **create** | 4 cases, same harness. |

Phase 10 documentation (noted here, **not written in this phase**):

- `fork/known-issues.md` — rewrite item 2 from "never fires" to "fixed in this fork", keeping the
  at-the-machine warning as a *historical* note; add two new "found but did not fix" entries: the
  dead `/uFEFF` no-op (`GrblHalController.js:509`) and the still-broken `%expr ; comment` case (§1.7).
- `FORK.md` — this becomes the fork's second patch; document what changed, why grblHAL was left
  disabled, and the hardware verification (HW1-HW4).
- `README.md` — a `### X.Y.Z (Date)` release-note entry under Development History (the heading format
  is load-bearing; `scripts/readme_sync.js` parses it).
- `CLAUDE.md` — the "Gotchas" bullet claiming the Grbl `%wait` "has never worked" needs updating, as
  does the `fork/known-issues.md` cross-reference in "Further documentation".

Not changed, deliberately: either feeder `dataFilter`; the `if (line[0] !== "%")` guards; the
`bracketCommentLine` regexes; `Sender.js`.

---

## 7. Risks and rollback

### 7.1 What actually changes at the machine

Only on Grbl. At the end of **every** job, one extra `G4 P0.5` is now written and the sender holds
until its `ok`. The `ok` releases the hold at `GrblController.js:809-814`, `ack()` + `next()` then
sees `received >= total` and emits `end` (`Sender.js:509-516`), which sets `senderFinishTime` and
lets the 250 ms loop (`:1219-1234`) call `gcode:stop` once the machine is idle. Because GRBL acks a
line when it *accepts it into the planner*, not when the move finishes, this is the difference
between "we have sent everything" and "the machine has stopped".

Line accounting does not move: the dwell line was already counted in `total` (it is non-blank, so
`Sender.js:335` keeps it); today it returns `""` and is acked immediately at `:230-233`, after the
fix it is sent and acked on the controller's `ok`.

### 7.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Job hangs at the last line.** The sender now holds waiting for one `ok`. If the machine alarms, resets, or disconnects during the dwell, that `ok` never arrives and progress sticks at 100%-minus-one. Today the job would "complete" regardless. | low | medium | The alarm/disconnect paths already run `workflow.stop()` → `sender.rewind()`, which clears `hold` (`Sender.js:573`). Verify in HW2. This is the one genuinely new failure mode. |
| **Pause exactly on the final line.** With `workflow` paused, the `ok` takes the `:820-833` branch, which acks but does not unhold. | very low | low | `workflow.on('resume')` calls `sender.unhold()` (`:708`) before `next()`. Recovers on resume. Verified by reading. |
| **A job file containing `%wait` mid-program now actually drains.** Previously a silent no-op. | low | low-medium | This is the documented behaviour (`features/Macros/constants.ts:31`, `GCodeParser.ts:260`) finally working. Call it out in the release note. |
| **The broad token fix widens what the sender recognises.** Any `%` line whose `;`-stripped form is `%wait` now holds. | certain (by design) | low | The sender recognises exactly one token; the exposure is precisely `%wait`, which is the intent. The feeder's five tokens are untouched. |
| **Expression corruption.** | ~zero | high if it happened | Structurally excluded: `line` is never mutated on the `%` path. T6/H3/S4/S5 are the standing guard. |
| **Perceived slowdown at end of job.** "Complete" now arrives later by however long the queued motion takes. | certain | low (perception) | Document in the release note: the delay is the machine actually finishing. |
| **grblHAL regression.** | ~zero | — | The grblHAL diff is comment text plus a token comparison nothing currently produces. H1 guards the absence of the dwell. |
| **jest `server/` mapping breaks an existing suite.** | low | low | Test-only; `npm test` (8 suites, ~2 s) is the check. Revert the one line if so. |
| **Controller test proves flaky** (timers, module-scope side effects). | medium | low | The helper test (§5.1) covers the logic independently; the controller test can be quarantined without losing the safety property. `destroy()` in `afterEach` handles the only interval. |

### 7.3 Blast radius

- **Grbl end-of-job sequencing.** Every job, every user of this fork. That is the point of the
  change, and it is the only functional behaviour that moves.
- **grblHAL: none.** Comment text and an inert comparison path.
- **`%` expression evaluation: none.** Byte-identical input to the evaluator, except that a
  comment-only `%` line no longer logs an error.
- **Everything else (feeder, macros, wizards, tool change, M0/M1/M6, rotary, visualizer): none.**

### 7.4 How a user would notice a regression

1. `G4 P0.5` appearing in the console after the last line of every job — expected, and the fastest
   confirmation the fix is live. Today no such line appears (the filter returns `""` and
   `Sender.js:230` skips the emit).
2. "Job complete" arriving noticeably later than before on programs ending in a long move —
   expected.
3. Progress freezing at the final line and never completing — **not** expected; that is the failure
   mode of §7.2 row 1.
4. `server.log` no longer carrying an `evaluate-assignment-expression … Unexpected token` error on
   every job load — expected, and the second confirmation the fix is live.

### 7.5 Rollback

> **Correction, added after implementation — step 1 below is wrong.** Reverting
> `const dwell = WAIT;` to the commented literal does **not** disable the drain: half A strips the
> `;` comment before the token comparison, so `"%wait ; Wait for the planner to empty"` now matches
> too. The kill switch is `const dwell = "";` — verified: `Sender.load()` drops blank lines, so line
> accounting is unaffected. It also turns tests **T1 and T2 red**, so it is one line *plus* a test
> update, not the zero-cost revert step 1 describes. The in-code comment at
> `GrblController.js:1627-1629` says the same thing.

Three levels, cheapest first:

1. **Disable the behaviour, keep the correctness fix:** revert `GrblController.js:1610` to a
   commented literal (or `const dwell = "";`… no — to the previous string). No dwell is matched, the
   drain stops happening, everything else stays correct. One line.
2. **Revert the controller hunks:** `git revert` the commit's changes to the two controllers. The
   helper and tests can stay (the helper becomes unused — remove or leave).
3. **Full revert:** single commit on `bugfix/wait-planner-drain`, `git revert` it.

Because the change is one commit on a branch off `master` with no schema, settings, or protocol
implications, rollback is a pure code revert with no migration.

---

## 8. Uncertainties flagged

1. **The jest/logger/settings collision (§5.4b) is inferred from reading four files, not from
   running jest.** The mapping match and the `settings.winston.level` dereference are both verified
   by direct read; the resulting `TypeError` is a deduction. Confirm on the first `npm test` run. The
   prescribed logger mock makes the question moot either way.
2. **Whether `buffer-chunks` is CJS** was not checked (the other four transitive deps were). If the
   grblHAL suite fails to parse, that is the first place to look.
3. **`src/server/controllers/constants.js:24`** reads `/ https://developer.mozilla.org/…` — a
   comment that appears to have lost a slash. It evidently parses (the module is in production use),
   but it is not a comment. Out of scope; worth a line in `fork/known-issues.md` under "found but did
   not fix".
4. **The commit rationale for `982a4ec31`** (grblHAL motor holding) is taken from the established
   facts supplied to this phase, not re-derived from the diff. The explanatory comment in §4.1 states
   it as the reason the dwell is disabled; if the implementer reads the commit and finds a different
   emphasis, adjust the wording — the *decision* (leave it disabled) does not change.
