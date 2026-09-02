/**
 * A warehouse that can't be reached used to render as an empty tree — the same
 * thing a warehouse with nothing registered renders as. Keep the failure and
 * offer a retry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const fetchWarehouseInfo = vi.fn();
const fetchWarehouseDatabases = vi.fn();

vi.mock("../../api", () => ({
  fetchWarehouseInfo: () => fetchWarehouseInfo(),
  fetchWarehouseDatabases: () => fetchWarehouseDatabases(),
}));
vi.mock("../../store", () => ({
  listSchemas: vi.fn(),
  listTablesInSchema: vi.fn(),
}));

const { useCatalogTree } = await import("./useCatalogTree");

beforeEach(() => {
  vi.clearAllMocks();
  fetchWarehouseInfo.mockResolvedValue({ adapter: "duckdb", engine: "duckdb" });
});

describe("useCatalogTree boot failure", () => {
  it("surfaces the error instead of an empty tree", async () => {
    fetchWarehouseDatabases.mockRejectedValue(new Error("connection refused"));
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.rootsError).toBe("connection refused"));
    expect(result.current.roots).toEqual([]);
  });

  it("retry() refetches and clears the error once the warehouse answers", async () => {
    fetchWarehouseDatabases.mockRejectedValueOnce(new Error("connection refused"));
    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.rootsError).not.toBeNull());

    fetchWarehouseDatabases.mockResolvedValue([
      { id: "db-1", databaseName: "analytics", label: null, lastProbeError: null },
    ]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.rootsError).toBeNull());
    expect(result.current.roots[0].children.map((c) => c.name)).toEqual(["analytics"]);
  });

  it("marks a schema whose tables failed to load, so it doesn't read as empty", async () => {
    fetchWarehouseDatabases.mockResolvedValue([
      { id: "db-1", databaseName: "analytics", label: null, lastProbeError: null },
    ]);
    const store = await import("../../store");
    vi.mocked(store.listSchemas).mockResolvedValue([{ schema: "sales", tables: 4 }]);
    vi.mocked(store.listTablesInSchema).mockRejectedValue(new Error("timeout"));

    const { result } = renderHook(() => useCatalogTree());
    await waitFor(() => expect(result.current.roots.length).toBe(1));
    await act(async () => result.current.toggle("conn/db-1"));
    await waitFor(() => expect(result.current.roots[0].children[0].children.length).toBe(1));
    await act(async () => result.current.toggle("conn/db-1/sales"));
    await waitFor(() =>
      expect(result.current.roots[0].children[0].children[0].loadFailed).toBe(true),
    );
  });
});
