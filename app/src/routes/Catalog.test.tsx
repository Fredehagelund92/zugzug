import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { Catalog } from "./Catalog";

vi.mock("../api", () => ({
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

vi.mock("../store", async (orig) => ({
  ...(await orig<typeof import("../store")>()),
  listSchemas: () => Promise.resolve([{ schema: "authco", tables: 1 }]),
  useDimensions: () => [{ id: "country", dimension: "Country" }],
}));

afterEach(cleanup);

describe("Catalog page", () => {
  it("renders the connection tree and a filter box", async () => {
    render(<Catalog />);
    expect(screen.getByPlaceholderText(/filter/i)).toBeTruthy();
    await waitFor(() => screen.getByText("md:demo"));
  });
});
