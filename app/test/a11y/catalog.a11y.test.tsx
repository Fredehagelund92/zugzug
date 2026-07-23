/**
 * Accessibility smoke test for CatalogModal (axe-core via vitest-axe).
 * Mocks match the shape used in app/src/components/catalog/CatalogModal.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { axe } from "vitest-axe";
import { CatalogModal } from "../../src/components/catalog/CatalogModal";

// ── mocks (hoisted by vitest) ────────────────────────────────────────────────

vi.mock("../../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({
    settings: "/app/test/settings",
  }),
}));

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

// ── a11y tests ───────────────────────────────────────────────────────────────

describe("a11y: CatalogModal", () => {
  it("has no axe violations when open (catalog loaded)", async () => {
    const { container } = render(<CatalogModal open={true} onClose={() => {}} />);
    await screen.findByText("md:demo");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
