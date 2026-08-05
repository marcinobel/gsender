# Frontend unit testing

This document is the in-repo quick reference for frontend unit tests in `gSender`. Use it for day-to-day work; keep it short and aligned with the current codebase.

For the hardware-driven end-to-end suite, see `cypress/TESTING.md`.

## Scope

- Frontend unit/component tests run with `jest` + `@testing-library/react`.
- One Jest project covers the whole repo – it picks up the server-side suites under `src/server/lib/__tests__/` and `src/server/controllers/*/__tests__/` as well as the renderer tests.
- Config lives at:
  - `jest.config.js`
  - `jest.setup.js`
  - `src/app/jest.setup.cjs`

## Run tests

From the repository root:

- Run all unit tests once: `npm test` (or `npm run test:unit`)
- Run in watch mode: `npm run test:unit:watch`
- Run a single test file: `npx jest src/app/src/components/Button/Button.test.tsx`
- Run a single test by name: `npx jest -t "renders the label"`
- Filter by path fragment: `npx jest --testPathPatterns=Button`

Note the plural – Jest 30 renamed `--testPathPattern` to `--testPathPatterns`.

**`yarn test:app` does not work on macOS or Linux.** The script in `src/app/package.json` invokes `../../node_modules/.bin/jest.cmd`, which only exists on Windows; elsewhere it fails with `No such file or directory`. Use the root-level commands above instead.

Jest prints a `jest-haste-map: Haste module naming collision: gSender` warning on every run, because `package.json` and the generated `src/package.json` share a name. It is harmless.

## Test location and naming

Both layouts are picked up by `testMatch`:

- `__tests__/...`
- `*.test.ts` / `*.test.tsx` / `*.test.js` / `*.test.jsx`

In practice the codebase keeps tests next to what they cover – `src/app/src/features/<Feature>/tests/`, or beside the component as with `src/app/src/components/Button/Button.test.tsx`. Prefer one test file per component/hook/module under test.

## Current conventions

- Prefer React Testing Library queries (`getByRole`, `getByText`, etc.) over implementation details.
- Test behaviour, not internal state.
- Keep tests deterministic and isolated (no shared mutable state across tests).
- Mock external dependencies that are not part of the unit being tested.

## Helpers and environment notes

- `@testing-library/jest-dom` is enabled globally via the setup files.
- `TextEncoder` and `TextDecoder` are polyfilled in `jest.setup.js`.
- Asset and style imports are mapped through `moduleNameMapper`, as are `react-markdown`, `react-syntax-highlighter`, `react-icons` and `@react-pdf/renderer` – see `src/app/src/__mocks__/`.
- The `app/*`, `@/*` and `app-root/*` import aliases work in tests via `moduleNameMapper`. If you add an alias, add it in `jest.config.js`, `src/app/tsconfig.json` and `src/app/vite.config.js` – all three.
- `server/*` is mapped too, but only in `jest.config.js`: server code that imports `server/lib/...` is resolved by an esbuild plugin in production, so there is no tsconfig or vite counterpart to keep in sync.

## Mocking guidance

- Mock app-level modules with `jest.mock(...)`.
- For complex mocks, prefer a dedicated file near the test or inside `__mocks__/`.
- Keep mocks minimal: only mock the behaviour the test case requires.

## What to cover in new tests

- Rendering for primary and edge states.
- User interactions (click, type, keyboard where relevant).
- Conditional UI logic and disabled/error states.
- Callback/dispatch side effects at component boundaries.

## Examples

Use these as starting templates and adapt naming and paths to your feature.

### 1) Component render + interaction

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Button from 'app/components/Button';

test('calls onClick when pressed', async () => {
    const user = userEvent.setup();
    const onClick = jest.fn();

    render(<Button onClick={onClick}>Run</Button>);
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(onClick).toHaveBeenCalledTimes(1);
});
```

### 2) Hook test with a mocked dependency

Hooks in `app/hooks` are named exports, so mock them as such.

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { useGetCollectDataStatus } from 'app/hooks/useGetDataCollectionStatus';
import api from 'app/api';

jest.mock('app/api', () => ({
    __esModule: true,
    default: {
        metrics: { getCollectDataStatus: jest.fn() },
    },
}));

test('returns the collect-data status from the API', async () => {
    (api.metrics.getCollectDataStatus as jest.Mock).mockResolvedValue({
        data: { collectUserDataStatus: 'ACCEPTED' },
    });

    const { result } = renderHook(() => useGetCollectDataStatus());
    await waitFor(() => expect(result.current[0]).toBe('ACCEPTED'));
});
```

### 3) Isolating the socket layer

Most feature code reaches the machine through the `app/lib/controller` singleton. Mock it rather than standing up a socket.

```ts
import controller from 'app/lib/controller';

jest.mock('app/lib/controller', () => ({
    __esModule: true,
    default: {
        command: jest.fn(),
        writeln: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
    },
}));

test('sends the probe G-code', () => {
    runProbe();
    expect(controller.command).toHaveBeenCalledWith(
        'gcode',
        expect.arrayContaining(['G91 G21']),
    );
});
```

## A note on types

There is currently no working type check in this repo – `npm run check-types` points at a path with no tsconfig, and the only TypeScript installed is a transitive 3.9.10 that cannot parse this config. Vite and esbuild strip types without validating them, so **tests are the main automated safety net for renderer code.** Assertions that would be caught by a compiler in another project have to be caught here instead.
