import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { RefTableClusterFeed } from "./use-ref-table-clusters";

type FeedState = RefTableClusterFeed & {
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

// The hook reads the feed and the store; mock both. `vi.hoisted` lets the
// hoisted mock factory safely reference this shared ref.
const { feedRef } = vi.hoisted(() => ({ feedRef: { current: null as unknown as FeedState } }));
vi.mock("./use-ref-table-clusters", () => ({ useRefTableClusters: () => feedRef.current }));
vi.mock("../store", () => ({ saveDraft: vi.fn(), discardDraft: vi.fn() }));

import { saveDraft, discardDraft } from "../store";
import { useClusterMapper } from "./use-cluster-mapper";
import type { MappingRefTable } from "../data";

const saveMock = saveDraft as unknown as ReturnType<typeof vi.fn>;
const discardMock = discardDraft as unknown as ReturnType<typeof vi.fn>;

function makeFeedState(feed: RefTableClusterFeed): FeedState {
  return { ...feed, loading: false, error: null, refetch: vi.fn() };
}
function loadedFeed(): RefTableClusterFeed {
  return {
    clusters: [
      // pending: one unmapped + one mapped sibling (United States)
      {
        key: "usa",
        rep: "USA",
        rows: 150,
        mappedCount: 1,
        members: [
          { raw: "USA", rows: 100, isMapped: false, mappedLabel: null, occurrences: [] },
          {
            raw: "U.S.A.",
            rows: 50,
            isMapped: true,
            mappedLabel: "United States",
            occurrences: [],
          },
        ],
      },
      // fully mapped → excluded from the queue
      {
        key: "ger",
        rep: "Germany",
        rows: 30,
        mappedCount: 1,
        members: [
          { raw: "Germany", rows: 30, isMapped: true, mappedLabel: "Germany", occurrences: [] },
        ],
      },
    ],
    coverage: { resolvedRows: 80, atRiskRows: 100, pct: 44 },
    truncated: false,
  };
}

const REF_TABLE = {
  id: "d1",
  record: [
    { key: "us", label: "United States" },
    { key: "de", label: "Germany" },
  ],
} as unknown as MappingRefTable;

beforeEach(() => {
  saveMock.mockReset();
  discardMock.mockReset();
  feedRef.current = makeFeedState(loadedFeed());
});

describe("useClusterMapper", () => {
  it("exposes the first pending cluster, its coverage, and the mapped-sibling suggestion", async () => {
    const { result } = renderHook(() => useClusterMapper(REF_TABLE));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));
    expect(result.current.position).toEqual({ index: 0, total: 1 }); // only "usa" is pending
    expect(result.current.coverage.pct).toBe(44);
    expect(result.current.suggestion).toEqual({ key: "us", label: "United States" });
    expect(result.current.candidates.some((c) => c.kind === "create")).toBe(true);
  });

  it("mapCluster stages a draft for every member and advances to done", async () => {
    const { result } = renderHook(() => useClusterMapper(REF_TABLE));
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
    const { result } = renderHook(() => useClusterMapper(REF_TABLE));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.skipCluster());

    expect(saveMock).toHaveBeenCalledWith("d1", "USA", "skipped", null, null);
    expect(saveMock).toHaveBeenCalledWith("d1", "U.S.A.", "skipped", null, null);
    expect(result.current.staged).toBe(0); // skipped is not staged
  });

  it("undo discards the drafts of the last decided cluster's members", async () => {
    const { result } = renderHook(() => useClusterMapper(REF_TABLE));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.mapCluster("us", "United States"));
    act(() => result.current.undo());

    expect(discardMock).toHaveBeenCalledWith("d1", "USA");
    expect(discardMock).toHaveBeenCalledWith("d1", "U.S.A.");
    expect(result.current.current?.key).toBe("usa"); // back on the cluster
    expect(result.current.staged).toBe(0);
  });

  it("handles cluster keys containing NUL (punctuation-only source values) without mis-splitting", async () => {
    // The server folds a punctuation-only value to a NUL-prefixed key. A
    // delimiter join/split would corrupt the reducer's order and never reach done.
    feedRef.current = makeFeedState({
      clusters: [
        {
          key: "usa",
          rep: "USA",
          rows: 100,
          mappedCount: 0,
          members: [{ raw: "USA", rows: 100, isMapped: false, mappedLabel: null, occurrences: [] }],
        },
        {
          key: "\u0000junk",
          rep: "???",
          rows: 10,
          mappedCount: 0,
          members: [{ raw: "???", rows: 10, isMapped: false, mappedLabel: null, occurrences: [] }],
        },
      ],
      coverage: { resolvedRows: 0, atRiskRows: 110, pct: 0 },
      truncated: false,
    });
    const { result } = renderHook(() => useClusterMapper(REF_TABLE));
    await waitFor(() => expect(result.current.position.total).toBe(2));

    act(() => result.current.mapCluster("us", "United States"));
    await waitFor(() => expect(result.current.current?.key).toBe("\u0000junk"));
    act(() => result.current.mapCluster("us", "United States"));

    expect(result.current.done).toBe(true);
    expect(result.current.current).toBeNull();
  });
});
