# Testing guide

This project keeps a green CI honest. A merge should mean "safe to ship."
Here is how the tests are organized and how to add one.

## The layers

| Layer                       | Where                                                | Command                          |
| --------------------------- | ---------------------------------------------------- | -------------------------------- |
| Unit (app)                  | `app/test/` + colocated `app/src/**/*.test.ts(x)`    | `cd app && bun run test`         |
| Component (app)             | `app/test/` + datagrid `test-kit`                    | `cd app && bun run test`         |
| Unit + integration (server) | `server/test/` + colocated `server/src/**/*.test.ts` | `cd server && bun run test`      |
| End-to-end (Playwright)     | `e2e/`                                               | `cd e2e && bunx playwright test` |

Run everything the way CI does with one command from the repo root:

    make test

See coverage locally:

    make cover

## Coverage

Every PR reports **patch coverage** — the share of the lines _your PR changed_
that are covered by tests. Legacy untested code never blocks you; you only owe
tests for what you touch. The gate is enforced: a PR whose changed lines are
under 80% covered fails CI. External-integration code (AI providers, warehouse
SDK adapters) is excluded from coverage. Shared setup lives in
`server/test/factories/`.

## Writing a unit test (server, pure logic)

    // server/test/example.test.ts
    import { test, expect } from "bun:test";
    import { signPayload } from "../src/webhook-signing";

    test("signPayload is deterministic for the same input", () => {
      const a = signPayload("{}", "secret", "current", 0);
      const b = signPayload("{}", "secret", "current", 0);
      expect(a).toBe(b);
    });

## Writing an integration test (server, hits Postgres)

    // server/test/example-db.test.ts
    import { test, expect, beforeEach } from "bun:test";
    import { resetDb } from "./setup";

    beforeEach(async () => {
      await resetDb();
    });

    test("a fresh database has no records", async () => {
      // build data with factories from server/test/factories (added in Phase 2)
      expect(true).toBe(true);
    });

Bring the database up first with `cd server && bun run test:db:up`.

## Writing a component test (app, React + Testing Library)

    // app/test/example.test.tsx
    import { render, screen } from "@testing-library/react";
    import { test, expect } from "vitest";

    test("renders a heading", () => {
      render(<h1>Tables</h1>);
      expect(screen.getByRole("heading", { name: "Tables" })).toBeTruthy();
    });

For the grid, use the helpers in `app/src/components/datagrid/test-kit/`.

### Frontend: MSW + renderWithProviders

- `renderWithProviders(ui, { route })` (`app/test/render.tsx`) renders a component
  inside `MemoryRouter`.
- For tests that exercise the API client, opt into MSW: import `server` from
  `app/test/msw/server.ts`, call `server.listen()/resetHandlers()/close()` in
  `beforeAll/afterEach/afterAll`, and add/override handlers in `app/test/msw/handlers.ts`.
  Handlers match the REWRITTEN URLs (`/api/t/:slug/...`); set the workspace with
  `window.history.pushState({}, "", "/app/<slug>/x")`.
- Datagrid cells are `{ Renderer, Editor }` with no providers — render the `Renderer`
  directly with a `CellCtx`-shaped prop.

## End-to-end (Playwright)

The `e2e/` suite covers the critical journeys through the real Docker stack: first-admin
signup, workspace creation, table and source wiring, grid editing, and the scan-to-mapping
flow (including the seed route used by the map-values spec). There are currently ~9 specs.

**Run locally:**

1. Bring up the stack with the e2e override:

       bash scripts/e2e-up.sh

   The `compose.e2e.yml` override sets `ZUGZUG_E2E_TEST_ROUTES=1`, which enables a
   test-only seed endpoint used by the map-values spec. This route is off in production.

2. Run the suite:

       cd e2e && bunx playwright test

   Playwright's global setup signs up and authenticates as the first admin against the
   running stack before any spec runs.

3. Tear down when done:

       bash scripts/e2e-down.sh

**Reports and traces** land in `e2e/playwright-report/` and `e2e/test-results/`. On CI,
they are uploaded as artifacts on failure so you can open the HTML report or replay traces.

## Accessibility (axe)

Key components are checked for accessibility violations with
[`vitest-axe`](https://github.com/chaance/vitest-axe), which runs axe-core against
a component rendered in jsdom and asserts there are no violations. The checks live
in `app/test/a11y/components.a11y.test.tsx` and cover the auth pages, a settings
form, the dashboard, and the data grid.

**Run them:**

    cd app && bun run test test/a11y

Each check is `render → axe → toHaveNoViolations`:

    import { axe } from "vitest-axe";

    test("Login has no accessibility violations", async () => {
      const { container } = withRouter(<Login />);
      expect(await axe(container)).toHaveNoViolations();
    });

(`withRouter`/`withAll` are small local wrappers in the test file that supply the
router and workspace context each component needs.)

The matcher is wired once in `app/test/setup.ts` (`expect.extend(axeMatchers)`).
When axe reports a real violation, fix the component (a missing label, role, or
accessible name) — do not weaken or skip the assertion to get green.

## Grid performance budget

`app/src/components/datagrid/scale.test.tsx` guards against a catastrophic grid
performance regression. jsdom timing is too coarse for a micro-benchmark, so the
**primary** guard is timing-independent: at 20k rows the grid must still mount only
a bounded number of `[role="row"]` elements (virtualization holds). A
de-virtualization regression that rendered all 20k rows would blow this bound and
tank real-world performance. A generous wall-clock ceiling (`elapsed < 5000ms`,
observed ~170ms) is a coarse backstop only — tune it up if it flakes on a loaded
machine; the mounted-count bound is the real test.

## Visual regression

Deferred. Playwright screenshot snapshots are high-maintenance (platform-baseline flake) and
additive to correctness; axe covers a11y regressions and the grid perf budget covers
the highest-risk rendering regression, so visual diffing waits until it can run in a
pinned image.

## Selectors (for end-to-end tests)

Prefer role, label, and visible text. Add a `data-testid` only when the
semantics are ambiguous (for example, a specific grid cell). Do not litter
test ids across the UI.

## Flaky tests

A test that fails intermittently is a bug. Do not add retries to hide it —
open an issue and quarantine with a clear `// FLAKY: #<issue>` comment.
