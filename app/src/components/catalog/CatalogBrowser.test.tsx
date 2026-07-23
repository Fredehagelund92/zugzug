import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogBrowser } from "./CatalogBrowser";
import { searchCatalog } from "../../store";

vi.mock("../../api", () => ({
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

vi.mock("../../store", async (orig) => ({
  ...(await orig<typeof import("../../store")>()),
  listSchemas: () => Promise.resolve([{ schema: "authco", tables: 1 }]),
  useDimensions: () => [{ id: "country", dimension: "Country" }],
  searchCatalog: vi.fn(() =>
    Promise.resolve({
      rows: [{ schema: "authco", table: "authco.users", columns: ["id", "email"] }],
      total: 1,
      schemas: [{ schema: "authco", tables: 1 }],
    }),
  ),
}));

afterEach(cleanup);

describe("CatalogBrowser", () => {
  it("renders the search box and loads the connection tree", async () => {
    render(<CatalogBrowser />);
    expect(screen.getByPlaceholderText(/search tables/i)).toBeTruthy();
    await waitFor(() => screen.getByText("md:demo"));
  });

  it("renders a vertical separator (divider) between tree and detail panes", () => {
    render(<CatalogBrowser />);
    const separator = screen.getByRole("separator");
    expect(separator).toBeTruthy();
    const orientation = separator.getAttribute("aria-orientation");
    expect(orientation).toBe("vertical");
  });

  it("shows search results when user types and clears back to tree", async () => {
    const user = userEvent.setup({ delay: null });
    render(<CatalogBrowser />);

    // Wait for tree to load
    await waitFor(() => screen.getByText("md:demo"));

    // Type in the search box
    const input = screen.getByPlaceholderText(/search tables/i);
    await user.type(input, "users");

    // Results should appear
    await screen.findByText("authco.users");

    // Clear the input — tree should return
    await user.clear(input);
    await waitFor(() => screen.getByText("md:demo"));
  });

  it("does not crash and clears searching when searchCatalog rejects", async () => {
    vi.mocked(searchCatalog).mockRejectedValueOnce(new Error("db down"));

    const user = userEvent.setup({ delay: null });
    render(<CatalogBrowser />);
    await waitFor(() => screen.getByText("md:demo"));

    const input = screen.getByPlaceholderText(/search tables/i);
    await user.type(input, "users");

    // searching indicator should clear even on rejection
    await waitFor(() => {
      expect(screen.queryByText("searching…")).toBeNull();
    });
  });

  describe("tree width persistence", () => {
    beforeEach(() => {
      localStorage.setItem("zz.catalog.tree-width", "400");
    });
    afterEach(() => {
      localStorage.removeItem("zz.catalog.tree-width");
    });

    it("initialises tree pane width from localStorage", () => {
      const { container } = render(<CatalogBrowser />);
      const grid = container.firstElementChild as HTMLElement;
      expect(grid.style.gridTemplateColumns).toMatch(/^400px/);
    });
  });
});
