import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { CatalogBrowser } from "./CatalogBrowser";

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
}));

afterEach(cleanup);

describe("CatalogBrowser", () => {
  it("renders the filter box and loads the connection tree", async () => {
    render(<CatalogBrowser />);
    expect(screen.getByPlaceholderText(/filter/i)).toBeTruthy();
    await waitFor(() => screen.getByText("md:demo"));
  });

  it("renders a vertical separator (divider) between tree and detail panes", () => {
    render(<CatalogBrowser />);
    const separator = screen.getByRole("separator");
    expect(separator).toBeTruthy();
    const orientation = separator.getAttribute("aria-orientation");
    expect(orientation).toBe("vertical");
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
