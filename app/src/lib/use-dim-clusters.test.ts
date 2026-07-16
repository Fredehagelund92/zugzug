import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../api";
import { useDimClusters, type DimClusterFeed } from "./use-dim-clusters";

const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const FEED: DimClusterFeed = {
  clusters: [
    { key: "usa", rep: "USA", rows: 1500, mappedCount: 0, members: [
      { raw: "USA", rows: 1000, isMapped: false, mappedLabel: null, occurrences: [] },
      { raw: "U.S.A.", rows: 500, isMapped: false, mappedLabel: null, occurrences: [] },
    ] },
  ],
  coverage: { resolvedRows: 300, atRiskRows: 1500, pct: 17 },
  truncated: false,
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());

describe("useDimClusters", () => {
  it("loads the cluster feed and calls the clusters endpoint", async () => {
    mockFetch.mockResolvedValue(okResponse(FEED));
    const { result } = renderHook(() => useDimClusters({ dimId: "d1", filter: "new" }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.clusters).toHaveLength(1);
    expect(result.current.clusters[0].key).toBe("usa");
    expect(result.current.coverage.pct).toBe(17);
    expect(result.current.truncated).toBe(false);
    expect(result.current.error).toBeNull();

    const calledPath = mockFetch.mock.calls[0][0] as string;
    expect(calledPath).toContain("/dimensions/d1/clusters");
    expect(calledPath).toContain("filter=new");
  });

  it("surfaces an error on a non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { result } = renderHook(() => useDimClusters({ dimId: "d1", filter: "new" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.clusters).toEqual([]);
  });

  it("does not fetch when dimId is null", async () => {
    const { result } = renderHook(() => useDimClusters({ dimId: null, filter: "new" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
