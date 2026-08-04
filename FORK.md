# This fork

A private fork of [Sienci-Labs/gsender](https://github.com/Sienci-Labs/gsender) carrying one
behavioural fix. It exists because **stock gSender cannot complete a tool change** on a machine that
needs the `Flexible Re-zero` strategy – the wizard never sends its probe G-code.

Nothing here goes back upstream. That is a settled decision, stated at the top of
[CLAUDE.md](CLAUDE.md) and enforced by a `PreToolUse` hook.

| | |
|---|---|
| Fork point | `c5fb9b7` (`Semver`) on `Sienci-Labs/gsender` master – version **1.6.4** |
| Branch | `fix/flexible-rezero-wizard-never-sends-gcode` |
| The fix | `82ec1fe9` – **one file**, +34 −39 in `src/app/src/wizards/semiautoToolchange.tsx` |
| Also on the branch | `c0c605a6` docs sync, `d9bc425f` the no-upstream guard – neither is part of the fix |
| Field-verified on | Two Trees TTC450 Ultra, GRBL 1.1 fork, macOS, 2026-08-04 |

## The defect

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

## Rebase posture

**Upstream master had no commits after the fork point** as of 2026-08-04.

More usefully, the patch restores the renderer's own declared contract rather than diverging from it.
A future upstream fix should merge cleanly or supersede it outright, and the rebase surface stays one
file.

## Further reading

- [fork/known-issues.md](fork/known-issues.md) – ten defects and behavioural traps verified in this
  codebase while fixing the above. None are patched here. One is a genuine hazard (`Resume Cutting`
  restarts the spindle unconditionally) and one changes what "job complete" means
- [fork/running-from-source.md](fork/running-from-source.md) – building, the two silent Electron
  entry-point traps, and where settings actually live
- [CLAUDE.md](CLAUDE.md) – the no-upstream rule and how it is enforced
