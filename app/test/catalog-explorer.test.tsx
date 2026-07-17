import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/store", () => ({
  searchCatalog: vi.fn().mockResolvedValue({
    rows: [{ schema: "authco", table: "authco.users", columns: ["plan_type", "country"] }],
    total: 1,
    schemas: [{ schema: "authco", tables: 1 }],
  }),
  deriveCanonical: vi.fn(),
  useCanEdit: () => true,
}));
vi.mock("../src/api", () => ({
  fetchWarehouseDatabases: vi.fn().mockResolvedValue([{ id: "db1", databaseName: "analytics", label: null, lastProbeError: null }]),
}));

async function renderExplorer() {
  const { CatalogExplorer } = await import("../src/components/CatalogExplorer");
  return render(<CatalogExplorer dims={[]} database="db1" onClose={vi.fn()} />);
}

describe("CatalogExplorer (drawer)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the 'Wire a source' header and a search box, no schema-facet rail", async () => {
    await renderExplorer();
    expect(screen.getByText(/wire a source/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search tables, columns/i)).toBeInTheDocument();
    // the old 'all systems' facet is gone
    expect(screen.queryByText(/all systems/i)).toBeNull();
  });

  it("lists tables from searchCatalog", async () => {
    await renderExplorer();
    await waitFor(() => expect(screen.getByText("authco.users")).toBeInTheDocument());
  });
});
