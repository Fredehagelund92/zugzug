import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { CatalogModal } from "./CatalogModal";

vi.mock("../../lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({
    settings: "/app/test/settings",
  }),
}));

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
  useRefTables: () => [{ id: "country", refTable: "Country" }],
}));

afterEach(cleanup);

describe("CatalogModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<CatalogModal open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the dialog and catalog browser when open", async () => {
    render(<CatalogModal open={true} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Add source" })).toBeTruthy();
    // The header title is present
    expect(screen.getByText("Add source")).toBeTruthy();
    // CatalogBrowser loads the connection tree
    await waitFor(() => screen.getByText("md:demo"));
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<CatalogModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
