import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCatalogTree } from "./useCatalogTree";

vi.mock("../../api", () => ({
  fetchWarehouseInfo: () => Promise.resolve({ adapter: "duckdb", databaseTerm: "database" }),
  fetchWarehouseDatabases: () =>
    Promise.resolve([
      {
        id: "db-1",
        databaseName: "zebra:db",
        label: null,
        lastProbeError: null,
      },
      {
        id: "db-2",
        databaseName: "alpha:db",
        label: null,
        lastProbeError: null,
      },
      {
        id: "db-dead",
        databaseName: "dead:db",
        label: null,
        lastProbeError: "connection refused",
      },
    ]),
}));
vi.mock("../../store", () => ({
  // schemas returned count-desc from backend (z before a)
  listSchemas: () =>
    Promise.resolve([
      { schema: "zoo_schema", tables: 10 },
      { schema: "alpha_schema", tables: 2 },
      { schema: "middle_schema", tables: 5 },
    ]),
  // tables returned in reverse order
  listTablesInSchema: () =>
    Promise.resolve([
      { schema: "alpha_schema", table: "alpha_schema.zebra_table", columns: ["id"] },
      { schema: "alpha_schema", table: "alpha_schema.apple_table", columns: ["id"] },
      { schema: "alpha_schema", table: "alpha_schema.mango_table", columns: ["id"] },
    ]),
  fetchColumns: () => Promise.resolve([{ name: "id", type: "INTEGER" }]),
}));
afterEach(() => vi.restoreAllMocks());

describe("useCatalogTree", () => {
  it("builds a connection root with registered databases", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots.length).toBe(1));
    expect(result.current.roots[0].kind).toBe("connection");
    expect(result.current.roots[0].children[0].name).toBe("alpha:db");
  });

  it("sorts databases alphabetically (case-insensitive)", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots[0].children.length).toBe(3));
    const names = result.current.roots[0].children.map((c) => c.name);
    expect(names).toEqual(["alpha:db", "dead:db", "zebra:db"]);
  });

  it("lazily loads schema children sorted alphabetically", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots.length).toBe(1));
    // alpha:db is now first child after sort
    await act(async () => result.current.toggle("conn/db-2"));
    await waitFor(() => expect(result.current.roots[0].children[0].children.length).toBe(3));
    const schemaNames = result.current.roots[0].children[0].children.map((c) => c.name);
    expect(schemaNames).toEqual(["alpha_schema", "middle_schema", "zoo_schema"]);
  });

  it("sorts tables within a schema alphabetically", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots.length).toBe(1));
    // expand database (alpha:db is first)
    await act(async () => result.current.toggle("conn/db-2"));
    await waitFor(() => expect(result.current.roots[0].children[0].children.length).toBe(3));
    // expand first schema (alpha_schema)
    await act(async () => result.current.toggle("conn/db-2/alpha_schema"));
    await waitFor(() =>
      expect(result.current.roots[0].children[0].children[0].children.length).toBe(3),
    );
    const tableNames = result.current.roots[0].children[0].children[0].children.map((c) => c.name);
    expect(tableNames).toEqual(["apple_table", "mango_table", "zebra_table"]);
  });

  it("marks database node as unreachable when lastProbeError is set", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots[0].children.length).toBe(3));
    const reachable = result.current.roots[0].children.find((c) => c.name === "alpha:db");
    const unreachable = result.current.roots[0].children.find((c) => c.name === "dead:db");
    expect(reachable?.unreachable).toBeFalsy();
    expect(unreachable?.unreachable).toBe(true);
  });
});
