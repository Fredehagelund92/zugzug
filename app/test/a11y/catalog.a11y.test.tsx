/**
 * Accessibility smoke test for the Catalog page (axe-core via vitest-axe).
 * Mocks match the shape used in app/src/routes/Catalog.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Catalog } from "../../src/routes/Catalog";

// ── mocks (hoisted by vitest) ────────────────────────────────────────────────

vi.mock("../../src/api", () => ({
  fetchWarehouseInfo: () => Promise.resolve({ adapter: "duckdb", databaseTerm: "database" }),
  fetchWarehouseDatabases: () =>
    Promise.resolve([
      {
        id: "db-1",
        databaseName: "md:demo",
        label: null,
        lastProbeError: null,
        schemaCount: 1,
      },
    ]),
}));

vi.mock("../../src/store", async (orig) => ({
  ...(await orig<typeof import("../../src/store")>()),
  listSchemas: () => Promise.resolve([{ schema: "authco", tables: 1 }]),
  useDimensions: () => [{ id: "country", dimension: "Country" }],
}));

afterEach(cleanup);

// ── a11y test ────────────────────────────────────────────────────────────────

describe("a11y: Catalog page", () => {
  it("has no axe violations (tree loaded, no table selected)", async () => {
    const { container } = render(<Catalog />);
    await waitFor(() => screen.getByText("md:demo"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
