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

## Selectors (for end-to-end tests)

Prefer role, label, and visible text. Add a `data-testid` only when the
semantics are ambiguous (for example, a specific grid cell). Do not litter
test ids across the UI.

## Flaky tests

A test that fails intermittently is a bug. Do not add retries to hide it —
open an issue and quarantine with a clear `// FLAKY: #<issue>` comment.
