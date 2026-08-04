# Known issues and behavioural traps

Defects and surprising behaviours found in gSender **1.6.4** while diagnosing the wizard bug this
fork patches ([FORK.md](../FORK.md)). All were exercised on a Two Trees TTC450 Ultra running a
GRBL 1.1 fork, on macOS, on 2026-08-04.

**None of these are fixed here** – the fork carries exactly one patch. They are recorded so the next
person does not re-diagnose them, and because two of them change what you should do at the machine.

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
> wizard. This is the one item here that can hurt you.

## 2. The `%wait` planner drain has never fired **[source]**

Tracked as [issue #1](https://github.com/marcinobel/gsender/issues/1).

`GrblController.js:1610` appends a dwell line to **every program it loads**:

```js
const dwell = "%wait ; Wait for the planner to empty";
…
const ok = this.sender.load(name, gcode + "\n" + dwell, context);
```

The sender path then strips comments only from lines that do *not* begin with `%`:

```js
if (line[0] !== "%") {          // GrblController.js:481
    line = line.replace(bracketCommentLine, "").trim();
    line = line.replace(commentMatcher, "").trim();
}
…
if (line === WAIT) {            // GrblController.js:491, WAIT = "%wait"
```

`"%wait ; Wait for the planner to empty" !== "%wait"`, so the comparison fails, the line falls
through to the expression evaluator, and that tries to parse `wait ; Wait for the planner to empty`
as JavaScript and throws `Unexpected token` – visible in `server.log` on every job.

The codebase builds a string in one place that it cannot match in another. Two details sharpen it:

- **The feeder path would have matched.** At `GrblController.js:296` comments are stripped
  unconditionally, before the same `line === WAIT` test. The two paths disagree about whether `%`
  lines carry comments, and only the sender path is wrong.
- **grblHAL is unaffected** – `GrblHalController.js:1911` has the same line commented out, so no
  dwell is appended there at all.

> **At the machine:** `sender.hold({ data: WAIT })` never fires, so the planner is never drained at
> end of program. **GRBL acknowledges a line when it is accepted into the planner buffer, not when
> the move has finished** – so gSender reporting "job complete" does **not** mean the machine has
> stopped moving. A program ending `G0 Z40`, `M5`, `M30` may still be raising Z and spinning down at
> "complete". Wait for actual stillness before reaching in.

The fix is one line – drop the comment from the constructed string so it matches the constant. Left
unapplied deliberately: it changes job-completion semantics, which is not something to alter casually
between cutting sessions.

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
