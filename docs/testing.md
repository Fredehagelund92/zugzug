# Testing guide

This project keeps a green CI honest. A merge should mean "safe to ship."
Here is how the tests are organized and how to add one.

## The layers

| Layer | Where | Command |
|---|---|---|
| Unit (app) | `app/test/` + colocated `app/src/**/*.test.ts(x)` | `cd app && bun run test` |
| Component (app) | `app/test/` + datagrid `test-kit` | `cd app && bun run test` |
| Unit + integration (server) | `server/test/` + colocated `server/src/**/*.test.ts` | `cd server && bun run test` |
| End-to-end | `e2e/` (added in a later phase) | see below |

Run everything the way CI does with one command from the repo root:

    make test

See coverage locally:

    make cover

## Coverage

Every PR reports **patch coverage** — the share of the lines *your PR changed*
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

## Selectors (for end-to-end tests)

Prefer role, label, and visible text. Add a `data-testid` only when the
semantics are ambiguous (for example, a specific grid cell). Do not litter
test ids across the UI.

## Flaky tests

A test that fails intermittently is a bug. Do not add retries to hide it —
open an issue and quarantine with a clear `// FLAKY: #<issue>` comment.
