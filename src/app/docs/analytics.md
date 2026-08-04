# Analytics (PostHog)

Product analytics for the gSender renderer. This page covers how PostHog is wired, when it is active, and the convention for adding an event. Error reporting is a separate system – see Sentry (`src/app/src/sentry-config.ts` for the renderer, `@sentry/electron` in `src/main.js`).

## Scope

PostHog runs in the **renderer only**. The Express server and the Electron main process do not report to it. Anything you want to measure must therefore be observable from React.

## Wiring

- `src/app/src/posthog-config.tsx` – default-exports `PostHogConfig`, which wraps its children in `PostHogProvider` and `PostHogErrorBoundary`.
- `src/app/src/entry-client.tsx` – mounts `PostHogConfig` around the app.
- `posthog.register({ app_version })` attaches the version from `src/app/package.json` to every event.
- `person_profiles: 'identified_only'` – gSender does not identify users, so events are anonymous.

## When it is active

`posthog.init(...)` runs only when **all three** hold:

1. `import.meta.env.MODE !== 'development'`,
2. `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` is set,
3. `VITE_PUBLIC_POSTHOG_HOST` is set.

Otherwise `PostHogConfig` renders children unwrapped and logs a warning. **Events never fire in `npm run dev` or `npm run electron:hot`** – if you need to verify an event locally you have to run a production-mode build with the vars set.

## Configuration

| Variable | Read by |
|---|---|
| `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` | Vite, at renderer build time |
| `VITE_PUBLIC_POSTHOG_HOST` | Vite, at renderer build time |

Vite's root is `src/app`, so for local use it loads them from `src/app/.env` (git-ignored, not committed). `.env.example` at the repo root documents both. CI supplies them from repository secrets – see the `env:` block in `.github/workflows/CI.yml`.

Because these are baked in at build time, changing them requires a rebuild, not a restart.

## User consent

`src/app/src/features/DataCollection/index.tsx` owns the consent prompt:

- The sheet appears 3 s after startup, only while `workspace.collectUsageDataStatus` is `'pending'`, and never in development.
- Accept calls `posthog.opt_in_capturing()`, decline calls `posthog.opt_out_capturing()`, and the choice is persisted to `workspace.collectUsageDataStatus` (`'accepted'` / `'denied'`) in the app store.
- The same toggle is reachable later from Config – see `features/Config/assets/SettingsMenu.ts`.

Opting out stops capture at the PostHog client level, so an event added anywhere in the app respects it automatically. Do not add a capture path that bypasses the client.

## Adding an event

Preferred – the hook, used in ~27 files:

```tsx
import { usePostHog } from '@posthog/react';

const posthog = usePostHog();
posthog?.capture('job_started', { active_state: currentActiveState });
```

Outside a component (or in a non-React module) import the client directly, as `features/Macros/index.tsx` and `features/Config/assets/SettingsMenu.ts` do:

```ts
import posthog from 'posthog-js';

posthog.capture('macro:run', { name });
```

Conventions in the existing ~81 capture sites:

- Optional-chain the hook result (`posthog?.capture`) – the provider is absent whenever analytics is disabled, which includes every development run.
- Event names are `snake_case` (`machine_connected`, `zero_all_axes`). A `feature:verb` form also appears in the macro and job code (`macro:run`, `job:end`); match the file you are in rather than renaming existing events, since renaming breaks historical charts.
- Put context in properties, not in the event name – `probe_run` with a command property, not `probe_run_z_touch`.
- Never capture G-code contents, file paths, port names or anything else that could identify a user or their work.

## Where events live

Capture sites are spread across the feature folders (Connection, JobControl, DRO, Probe, Macros, Coolant, Rotary, Spindle, Visualizer, FileControl, and others). Rather than maintaining a list here that goes stale, find the current set with:

```bash
grep -rn "capture(" src/app/src --include="*.tsx" --include="*.ts"
```
