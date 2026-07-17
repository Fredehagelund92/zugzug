import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { UseClusterMapper } from "../../lib/use-cluster-mapper";

const { mapperRef } = vi.hoisted(() => ({
  mapperRef: { current: null as unknown as UseClusterMapper },
}));
vi.mock("../../lib/use-cluster-mapper", () => ({ useClusterMapper: () => mapperRef.current }));

import { ClusterMapperCard } from "./ClusterMapperCard";
import type { MappingDimension } from "../../data";

const DIM = { id: "d1", dimension: "Country" } as unknown as MappingDimension;

function baseMapper(over: Partial<UseClusterMapper> = {}): UseClusterMapper {
  return {
    loading: false,
    error: null,
    current: {
      key: "usa",
      rep: "USA",
      rows: 12405,
      mappedCount: 1,
      members: [
        { raw: "USA", rows: 12000, isMapped: false, mappedLabel: null, occurrences: [] },
        { raw: "U.S.A.", rows: 405, isMapped: true, mappedLabel: "United States", occurrences: [] },
      ],
    },
    candidates: [
      { kind: "record", key: "us", label: "United States", closest: true },
      { kind: "create", label: "USA" },
    ],
    suggestion: { key: "us", label: "United States" },
    coverage: { resolvedRows: 400, atRiskRows: 12405, pct: 3 },
    truncated: false,
    staged: 0,
    done: false,
    position: { index: 0, total: 5 },
    query: "",
    setQuery: vi.fn(),
    mapCluster: vi.fn(),
    skipCluster: vi.fn(),
    undo: vi.fn(),
    jumpTo: vi.fn(),
    refetch: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mapperRef.current = baseMapper();
});

describe("ClusterMapperCard", () => {
  it("renders the current cluster: rep, members, and the suggested record", () => {
    const { getByText, getAllByText } = render(<ClusterMapperCard dim={DIM} />);
    expect(getAllByText("USA").length).toBeGreaterThanOrEqual(1); // rep + member chip
    expect(getByText("U.S.A.")).toBeTruthy(); // a member chip (unique)
    expect(getByText("United States")).toBeTruthy(); // the candidate record (unique)
    expect(getByText("Suggested")).toBeTruthy(); // the mapped-sibling pill
  });

  it("Enter maps the pre-highlighted suggested record", () => {
    const map = vi.fn();
    mapperRef.current = baseMapper({ mapCluster: map });
    const { getByLabelText } = render(<ClusterMapperCard dim={DIM} />);
    fireEvent.keyDown(getByLabelText("Map values"), { key: "Enter" });
    expect(map).toHaveBeenCalledWith("us", "United States");
  });

  it("Skip button calls skipCluster", () => {
    const skip = vi.fn();
    mapperRef.current = baseMapper({ skipCluster: skip });
    const { getByText } = render(<ClusterMapperCard dim={DIM} />);
    fireEvent.click(getByText("Skip"));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("guards against a double map before the cluster advances", () => {
    const map = vi.fn();
    mapperRef.current = baseMapper({ mapCluster: map });
    const { getByLabelText } = render(<ClusterMapperCard dim={DIM} />);
    const card = getByLabelText("Map values");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(map).toHaveBeenCalledTimes(1); // second Enter is swallowed
  });

  it("shows the done state when the queue is worked", () => {
    mapperRef.current = baseMapper({ current: null, done: true, staged: 7 });
    const { getByText } = render(<ClusterMapperCard dim={DIM} />);
    expect(getByText(/all mapped/i)).toBeTruthy();
  });

  it("shows an error with a retry", () => {
    const refetch = vi.fn();
    mapperRef.current = baseMapper({ error: "HTTP 500", current: null, refetch });
    const { getByText } = render(<ClusterMapperCard dim={DIM} />);
    fireEvent.click(getByText("retry"));
    expect(refetch).toHaveBeenCalled();
  });
});
