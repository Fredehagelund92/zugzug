import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

describe("useWorkspaceInfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test("returns workspace info after fetch", async () => {
    const mockInfo = {
      adapter: "duckdb",
      writable: false,
      recordMode: "postgres-export" as const,
      warehouseDb: "analytics",
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => mockInfo,
    })) as unknown as typeof fetch;

    const { useWorkspaceInfo } = await import("../src/store");
    const { result } = renderHook(() => useWorkspaceInfo());

    await waitFor(() => {
      expect(result.current).toEqual(mockInfo);
    });
  });

  test("returns null while loading", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const { useWorkspaceInfo } = await import("../src/store");
    const { result } = renderHook(() => useWorkspaceInfo());
    expect(result.current).toBeNull();
  });
});
