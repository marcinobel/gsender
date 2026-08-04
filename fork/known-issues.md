# Known issues and behavioural traps

Defects and surprising behaviours found in gSender **1.6.4**, first while diagnosing the wizard bug
this fork patches and then while fixing the `%wait` planner drain ([FORK.md](../FORK.md)). The
hardware-marked ones were exercised on a Two Trees TTC450 Ultra running a GRBL 1.1 fork, on macOS, on
2026-08-04.

**One of these is fixed here** – item 2, the `%wait` planner drain, which is the fork's second patch.
The rest are recorded so the next person does not re-diagnose them, and because three of them change
what you should do at the machine: item 1 (the spindle restarts on its own), item 2 (what "complete"
means, on grblHAL) and item 11 (what a G-code file from a stranger can do).

Each entry is marked either **[source]** – mechanism read in this codebase – or **[hardware]** –
observed at the machine, mechanism not confirmed here.

## 1. `Resume Cutting` restarts the spindle unconditionally – hazard **[source]**

`src/app/src/wizards/semiautoToolchange.tsx:212` emits a hardcoded `M3`:

```
'M3 [global.toolchange.UNITS] [global.toolchange.DISTANCE] [global.toolchange.FEEDRATE]'
```

The wizard *does* record the real spindle state one step earlier
(`%global.toolchange.SPINDLE=modal.spindle`, line 121) – and then never reads it back. So resuming
after a tool change starts the spindle **even for a programme that never started it**, and it starts
in `M3` even if the job was running `M4`.

The other two wizards get this right and are the model to copy: `automaticToolchange.tsx:214-215` and
`probeToolLength.tsx:131` both restore `[global.toolchange.SPINDLE] S[global.toolchange.SPINDLE_RATE]`.

> **At the machine:** isolate the spindle at the switch before any air test of the Flexible Re-zero
> wizard. This is the one item here that can physically injure you – item 11 is the other hazard, of
> a different kind.

## 2. The `%wait` planner drain did not fire on Grbl – **fixed here** **[source]**

Tracked as [issue #1](https://github.com/marcinobel/gsender/issues/1). This is the fork's second
patch; see [FORK.md](../FORK.md).

The Grbl controller appends a dwell line to **every program it loads**, and the sender is meant to
recognise it, hold, and wait for the planner to empty before the job is called done. It did not.
The appended line was

```js
const dwell = "%wait ; Wait for the planner to empty";
…
const ok = this.sender.load(name, gcode + "\n" + dwell, context);
```

while the sender path strips comments only from lines that do *not* begin with `%`, then compared
for exact equality:

```js
if (line[0] !== "%") {          // GrblController.js:482
    line = line.replace(bracketCommentLine, "").trim();
    line = line.replace(commentMatcher, "").trim();
}
…
if (line === WAIT) {            // WAIT = "%wait"
```

`"%wait ; Wait for the planner to empty" !== "%wait"`, so the comparison failed, the line fell
through to the expression evaluator, and that tried to parse `wait ; Wait for the planner to empty`
as JavaScript and threw `Unexpected token` – visible in `server.log` on every job. The codebase built
a string in one place that it could not match in another.

The feeder path was never affected: at `GrblController.js:297` comments are stripped unconditionally,
before the same `line === WAIT` test. The two paths disagreed about whether `%` lines carry comments,
and only the sender path was wrong.

### It was a 1.6.x regression, not ancient breakage

The drain worked from 2018 until `93a0e53fc` (2026-05-26, "Fix for regex stripping comments stripping
out evaluated expressions"), which added the `if (line[0] !== "%")` guard – correctly, to stop the
bracket regex mangling `%` expressions, in which `(…)` is a function call and not a comment. Two days
later `50e63eb54` ("Bracket comment updates for feeder only") restored unconditional stripping on the
**feeder** path only. The asymmetry that broke the drain is that pair of commits, not the original
design.

### What changed here

Two independent halves, both applied:

- **Token comparison.** Both controllers now compare `%` lines against the tokens using a throwaway
  `;`-stripped copy from the new `src/server/lib/strip-semicolon-comment.js`
  (`const token = stripSemicolonComment(line)`). The original `line` still reaches the evaluator
  untouched – brackets are deliberately **never** stripped from a `%` line, because
  `%global.tool = Number(tool) || 0` is documented macro syntax and the greedy
  `/\s*\(.*\)*\)/gm` would silently reduce it to `%global.tool = Number || 0`, assigning the `Number`
  *function* as the tool number. A `token === "%"` short-circuit was added at the same time, so a
  `%` line that is nothing but a comment no longer produces an evaluator error.
- **The constructed line.** `GrblController.js:1630` now reads `const dwell = WAIT;` instead of
  restating the literal with a comment baked in, so the two strings cannot drift apart again.

**grblHAL keeps no end-of-program dwell.** It was disabled deliberately by `982a4ec31` (2023-10-18,
"Fix for motor holding is removing the dwell") after being active when that controller was forked
from the Grbl one (`4fa9480c1`); the commit records no mechanism, so re-enabling it is not a decision
to make from the code alone. grblHAL *does* get the token fix, so a `%wait` a user puts in their own
file – with or without a trailing comment – is now honoured there.

Covered by unit tests (the repo's first server-side controller tests). **Not yet exercised at the
machine** at the time of writing.

> **At the machine:** on Grbl the planner is now drained at end of program, so "job complete" arrives
> after the machine has stopped rather than during the last move – and arrives correspondingly later
> on a program ending in a long rapid. **GRBL acknowledges a line when it is accepted into the
> planner buffer, not when the move has finished**, which is the whole reason the drain exists. On
> **grblHAL** nothing changed: with no dwell appended, "complete" can still precede the final move
> finishing, so a program ending `G0 Z40`, `M5`, `M30` may still be raising Z and spinning down.
> Wait for actual stillness before reaching in.

## 3. The probe Start button has no escape hatch **[source]**

`RunProbe.tsx:181` renders the Start button as `disabled={!connectionMade}`. `connectionMade` starts
`false` (`features/Probe/index.tsx:162`) and is only set true by the touch-test observing the probe
pin change state.

On firmware that never reports probe pin state in its status reports, that never happens, so probing
is blocked outright – with no override and no explanation of why the button is dead. Probing itself
works fine on such a machine; only gSender's gate does not.

## 4. The `Code` tool-change strategy silently swallows everything **[source]**

`Code` looks like the scriptable option and is a trap. Its pre-hook block ends in a marker that
triggers `this.feeder.hold({ data: "%toolchange" })` (`GrblController.js:306-310`), and the feeder is
only released when the change is acknowledged. Every one-off command issued in between – **including
a probe, which is fed the same way** – queues up and does nothing visible.

It reproduces exactly the failure mode this fork exists to fix, which makes it an easy wrong turn
when the wizard appears broken.

## 5. `Standard Re-zero` does not clamp its probe distance **[source]**

`semiautoToolchange.tsx:40-59` (`calculateMaxZProbeDistance`) clamps the probe distance against `$132`
(max Z travel) and the current machine Z when soft limits are on, so the probe cannot trip a soft
limit. `automaticToolchange.tsx` and `probeToolLength.tsx` do the same.

`manualToolchange.tsx` – the `Standard Re-zero` wizard – passes `settings.zProbeDistance` straight
through (line 40) with no clamp.

## 6. The "Initiated probing cycle" toast proves nothing **[source]**

`RunProbe.tsx:122-127` fires the toast immediately after handing the commands to the socket, with no
check that the machine received or accepted anything:

```ts
actionsRef.current.runProbeCommands(probeCommands);
toast.info('Initiated probing cycle', { position: 'bottom-right' });
```

During the wizard investigation this toast appeared on every click while the machine never moved. Do
not read it as confirmation of anything.

## 7. Flexible Re-zero shows imperial units on a metric machine **[source]**

`semiautoToolchange.tsx:31-38`:

```ts
const $13 = get(reduxStore.getState(), 'controller.settings.settings.$13', '0');
return $13 ? '0.4in' : '10mm';
```

`$13` arrives as the **string** `'0'`, which is truthy in JavaScript, so the imperial branch is always
taken – including when the setting is absent and the `'0'` default applies. It should test
`$13 === '1'`, which is exactly what `getUnitModal()` in `lib/toolChangeUtils.ts:56-63` does
correctly.

Cosmetic only: 0.4 in = 10.16 mm, so the distance advice is right and only the unit label is wrong.

## 8. Jogging and probing are unavailable during an `M0`/`M1` pause **[hardware]**

A pause is not a stop you can work in – Probe, `Z+` and `Z-` are all inert while the program is
paused that way. This is why a tool-change *wizard* strategy is required for a multi-tool job rather
than a plain `Pause`; Sienci's own guidance says the same. Confirmed at the machine on 2026-08-03.

## 9. Unparsed controller settings render as `[object Object]` **[hardware]**

Settings a firmware fork exposes but gSender's parser does not know (`$28`, `$43`, `$44`, `$47`,
`$133` on the machine tested) render as `[object Object]` in the Config screen. They are visible but
not editable – the Console is the workaround. `$133` is the A-axis travel, so the settings screen is
effectively 3-axis only on such firmware.

## 10. The grblHAL controller flag is silently discarded **[source]**

`--controller grblHAL` does nothing. `parseController` in `src/server-cli.js:63-71` lowercases the
value and then tests it against a **mixed-case** array:

```js
val = val ? (val + '').toLowerCase() : '';
if (['grbl', 'grblHAL'].includes(val)) {
    return val;
}
return '';
```

`'grblHAL'.toLowerCase()` is `'grblhal'`, which is not `'grblHAL'`, so the value is thrown away and
replaced with `''`. Only `--controller Grbl` survives, in any casing.

An empty controller is not an error – `CNCEngine.js:136-141` registers **both** controller classes
when it is empty, which is the auto-detect default. So the flag quietly means "auto" instead of
"force grblHAL", and nothing is logged to say so.

Ironically the engine's own comparison is case-insensitive (`caseInsensitiveEquals`,
`CNCEngine.js:57-61`) and would have accepted the value. The CLI parser is the only case-sensitive
link in the chain.

## 11. A G-code file can execute arbitrary JavaScript – hazard **[source]**

The `%` expression evaluator is a JavaScript interpreter, and it is handed the globals it needs to
escape itself. `GLOBAL_OBJECTS` (`src/server/controllers/constants.js:25-46`) exposes `Function`,
`Object`, `String` and `RegExp`, and `populateContext` spreads it into every evaluation context
(`GrblController.js:1365`). `src/server/lib/evaluate-expression.js` then implements `CallExpression`
(`:173-194`) and a `FunctionExpression` branch that calls `Function(…)` on generated source (`:263`).

Verified by execution, not by reading:

```
%x = Function("return typeof process.env.HOME")()   →   "string"
```

gSender registers `.gcode`/`.nc` file associations, so opening a file someone sent you and pressing
play is the whole of it. The server process owns the serial port and the user's filesystem.

Removing `Function` from `GLOBAL_OBJECTS` does not close it – `Object.constructor` and
`String.constructor` both reach `Function` anyway. Closing it properly means removing the call
machinery from the evaluator, which would break documented macro syntax
(`%global.tool = Number(tool) || 0`).

lodash's `_.set` does block the separate `__proto__`/`constructor`/`prototype` prototype-pollution
route (verified against the installed 4.17.23), which is moot while the above stands.

Not fixed here: the fix is a redesign of the evaluator, not a patch, and it is orthogonal to why this
fork exists. It is upstream's defect and, per [CLAUDE.md](../CLAUDE.md), nothing from this repo is
reported to them.

## 12. The comment-stripping regexes are quadratic **[source]**

`/\s*;.*/g` backtracks: the leading `\s*` makes the engine retry from every position in a whitespace
run that contains no `;`, so it is Θ(n²) in the length of the run. Measured at ~4.5 s for a single
100,000-character line – on the server process that owns the serial port, so the event loop stalls
with a job in flight.

Present at `GrblController.js:291` and `:471`, `GrblHalController.js:322` and `:497`, and
`src/server/lib/rotary.js:2`. Grbl's greedy `/\s*\(.*\)*\)/gm` at `GrblController.js:472` has the
same shape.

The two controllers have drifted here and **grblHAL has the better version**: its bracket matcher is
`/\([^\)]*\)/gm`, which is linear. `strip-semicolon-comment.js` avoids the problem by not having a
leading `\s*` at all (it uses `/;.*/` and trims afterwards).

A 100,000-character line is not something a CAM program emits, which is why this is recorded rather
than fixed – but a hostile file is a file like any other, and see item 11 for what else one can do.

## 13. Every `%` expression dumps its AST to stdout **[source]**

`src/server/lib/evaluate-expression.js:39` opens the tree walk with a live `console.log(node)`. It
fires for **every visited node of every `%` expression**, in production, unconditionally.

## 14. An `error:` response does not release a sender hold **[source]**

`GrblController.js:897-931`: when an error arrives while the workflow is running or paused, the
handler emits the error, pauses the workflow, then calls `this.sender.ack()` and `this.sender.next()`
– but never `this.sender.unhold()`. The `ok` handler two blocks up (`:826-831`) is the only place
that unholds, so a job that errors while the sender is holding recovers only through a UI resume
(`workflow.on("resume")` → `sender.unhold()`).

Untouched by item 2's fix, but newly *exercised* by it: the end-of-program dwell is now the last
thing acked, so it is the last thing that can error. This is the path to watch during hardware
verification.

## 15. `%expr ; comment` still logs a parse error **[source]**

A `%` line carrying **both** an expression and a trailing comment still reaches the evaluator with
the comment attached and still fails to parse. Item 2 fixed only the token comparison, which uses a
throwaway copy; the evaluator deliberately receives the line unstripped.

Feeding it the stripped copy instead would reintroduce exactly what `93a0e53fc` fixed – a `;` inside
a string literal (`%global.msg = "a;b"`) would truncate the expression. A documented limitation, not
a regression: it behaves today exactly as it did before the fix.

## 16. A dead BOM strip in `GrblHalController.js` **[source]**

`GrblHalController.js:510` chains `.replace("/uFEFF", "")` – a **literal string** with a forward
slash where a backslash escape was meant. `"/uFEFF"` never occurs in G-code, so the call does
nothing. The intent was evidently to strip a UTF-8 BOM.

Left alone deliberately. It sits on the non-`%` path that item 2's change never enters, and
"fixing" it would newly strip BOM characters from every line of every job – an untested behaviour
change on the streaming hot path, bundled into a commit that already alters job-completion
semantics.

## 17. The REST upload path loads with no filename on Grbl **[source]**

`src/server/api/api.gcode.js:56` calls `controller.command("gcode:load", name, gcode, context, cb)`
with `name` as a **string**. The grblHAL controller destructures it as a string
(`GrblHalController.js:1916`), but Grbl's handler expects an object:

```js
let [meta, gcode, context = {}, callback = noop] = args;
const { name } = meta;         // GrblController.js:1614-1615
```

so `name` is `undefined` for every file loaded over the REST API on Grbl. The socket path passes the
object and is unaffected, which is why the UI never shows it. Pre-existing, unrelated to anything
this fork changes.

## Not a gSender bug: the CH340 serial wedge **[hardware]**

Recorded because it presents convincingly as an application defect.

Symptom: the app connects and disconnects on a ~25 second cycle – port opens, `Emitting Sender`, an
uncaught `Canceled` from the serialport poller, then `autoReconnect` reopens. The UI shows the port
chip with a green tick **and** a `Disconnected` banner simultaneously. Both are true: the port is
open at OS level while the protocol never comes up.

Root cause is a wedged CH340 driver instance – `tcsetattr` returns `EINVAL` for every setting,
*including writing back the exact attributes just read from the device*, and `stty` fails identically,
so it is not application-specific. **Only unplugging and replugging the USB cable recovers it.**
Nothing in software does.

If a reconnect-loop bug report looks like this, check the driver before reading gSender's serial code.
