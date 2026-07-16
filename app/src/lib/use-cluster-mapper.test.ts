import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { DimClusterFeed } from "./use-dim-clusters";

type FeedState = DimClusterFeed & { loading: boolean; error: string | null; refetch: () => void };

// The hook reads the feed and the store; mock both. `vi.hoisted` lets the
// hoisted mock factory safely reference this shared ref.
const { feedRef } = vi.hoisted(() => ({ feedRef: { current: null as unknown as FeedState } }));
vi.mock("./use-dim-clusters", () => ({ useDimClusters: () => feedRef.current }));
vi.mock("../store", () => ({ saveDraft: vi.fn(), discardDraft: vi.fn() }));

import { saveDraft, discardDraft } from "../store";
import { useClusterMapper } from "./use-cluster-mapper";
import type { MappingDimension } from "../data";

const saveMock = saveDraft as unknown as ReturnType<typeof vi.fn>;
const discardMock = discardDraft as unknown as ReturnType<typeof vi.fn>;

function makeFeedState(feed: DimClusterFeed): FeedState {
  return { ...feed, loading: false, error: null, refetch: vi.fn() };
}
function loadedFeed(): DimClusterFeed {
  return {
    clusters: [
      // pending: one unmapped + one mapped sibling (United States)
      { key: "usa", rep: "USA", rows: 150, mappedCount: 1, members: [
        { raw: "USA", rows: 100, isMapped: false, mappedLabel: null, occurrences: [] },
        { raw: "U.S.A.", rows: 50, isMapped: true, mappedLabel: "United States", occurrences: [] },
      ] },
      // fully mapped → excluded from the queue
      { key: "ger", rep: "Germany", rows: 30, mappedCount: 1, members: [
        { raw: "Germany", rows: 30, isMapped: true, mappedLabel: "Germany", occurrences: [] },
      ] },
    ],
    coverage: { resolvedRows: 80, atRiskRows: 100, pct: 44 },
    truncated: false,
  };
}

const DIM = {
  id: "d1",
  canonical: [
    { key: "us", label: "United States" },
    { key: "de", label: "Germany" },
  ],
} as unknown as MappingDimension;

beforeEach(() => {
  saveMock.mockReset();
  discardMock.mockReset();
  feedRef.current = makeFeedState(loadedFeed());
});

describe("useClusterMapper", () => {
  it("exposes the first pending cluster, its coverage, and the mapped-sibling suggestion", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));
    expect(result.current.position).toEqual({ index: 0, total: 1 }); // only "usa" is pending
    expect(result.current.coverage.pct).toBe(44);
    expect(result.current.suggestion).toEqual({ key: "us", label: "United States" });
    expect(result.current.candidates.some((c) => c.kind === "create")).toBe(true);
  });

  it("mapCluster stages a draft for every member and advances to done", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.mapCluster("us", "United States"));

    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock).toHaveBeenCalledWith("d1", "USA", "mapped", "United States", "us");
    expect(saveMock).toHaveBeenCalledWith("d1", "U.S.A.", "mapped", "United States", "us");
    expect(result.current.staged).toBe(1);
    expect(result.current.current).toBeNull();
    expect(result.current.done).toBe(true);
  });

  it("skipCluster stages a skipped draft for every member", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.skipCluster());

    expect(saveMock).toHaveBeenCalledWith("d1", "USA", "skipped", null, null);
    expect(saveMock).toHaveBeenCalledWith("d1", "U.S.A.", "skipped", null, null);
    expect(result.current.staged).toBe(0); // skipped is not staged
  });

  it("undo discards the drafts of the last decided cluster's members", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.mapCluster("us", "United States"));
    act(() => result.current.undo());

    expect(discardMock).toHaveBeenCalledWith("d1", "USA");
    expect(discardMock).toHaveBeenCalledWith("d1", "U.S.A.");
    expect(result.current.current?.key).toBe("usa"); // back on the cluster
    expect(result.current.staged).toBe(0);
  });
});
