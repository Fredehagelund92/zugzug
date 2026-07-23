import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCatalogTree } from "./useCatalogTree";

vi.mock("../../api", () => ({
  fetchWarehouseInfo: () => Promise.resolve({ adapter: "duckdb", databaseTerm: "database" }),
  fetchWarehouseDatabases: () =>
    Promise.resolve([
      {
        id: "db-1",
        databaseName: "md:demo",
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
  listSchemas: () => Promise.resolve([{ schema: "authco", tables: 2 }]),
  listTablesInSchema: () =>
    Promise.resolve([{ schema: "authco", table: "authco.users", columns: ["country"] }]),
  fetchColumns: () => Promise.resolve([{ name: "country", type: "VARCHAR" }]),
}));
afterEach(() => vi.restoreAllMocks());

describe("useCatalogTree", () => {
  it("builds a connection root with registered databases", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots.length).toBe(1));
    expect(result.current.roots[0].kind).toBe("connection");
    expect(result.current.roots[0].children[0].name).toBe("md:demo");
  });

  it("lazily loads schema children on expand", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots.length).toBe(1));
    await act(async () => result.current.toggle("conn/db-1"));
    await waitFor(() =>
      expect(result.current.roots[0].children[0].children[0].name).toBe("authco"),
    );
  });

  it("marks database node as unreachable when lastProbeError is set", async () => {
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots[0].children.length).toBe(2));
    const reachable = result.current.roots[0].children.find((c) => c.name === "md:demo");
    const unreachable = result.current.roots[0].children.find((c) => c.name === "dead:db");
    expect(reachable?.unreachable).toBeFalsy();
    expect(unreachable?.unreachable).toBe(true);
  });
});
