import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MapValuesBody } from "./MapValuesBody";
import type { MappingRefTable } from "../../data";
import type { Cluster } from "../../lib/use-ref-table-clusters";

const CLUSTERS: Cluster[] = [
  {
    key: "de",
    rep: "Deutschland",
    rows: 1204,
    mappedCount: 0,
    members: [
      {
        raw: "Deutschland",
        rows: 1204,
        isMapped: false,
        mappedLabel: null,
        occurrences: [{ table: "geo.customers", column: "country", rows: 1204 }],
      },
    ],
  },
  {
    key: "us",
    rep: "U.S.A.",
    rows: 880,
    mappedCount: 0,
    members: [
      {
        raw: "U.S.A.",
        rows: 880,
        isMapped: false,
        mappedLabel: null,
        occurrences: [{ table: "geo.orders", column: "ship_country", rows: 880 }],
      },
    ],
  },
];

vi.mock("../../lib/use-ref-table-clusters", () => ({
  useRefTableClusters: () => ({
    clusters: CLUSTERS,
    coverage: { resolvedRows: 0, atRiskRows: 2084, pct: 0 },
    truncated: false,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../store", () => ({
  listDrafts: () => [],
  commit: vi.fn(),
  useDrafts: () => ({}),
  useCanEdit: () => true,
  saveDraft: vi.fn(),
  discardDraft: vi.fn(),
  useSources: () => [],
  scanSources: vi.fn(),
  slug: (s: string) => s,
  dkey: (id: string, raw: string) => `${id}::${raw}`,
}));

const REF = {
  id: "t1",
  refTable: "country",
  record: [{ key: "germany", label: "Germany", version: 1 }],
} as unknown as MappingRefTable;

describe("MapValuesBody", () => {
  it("renders one row per cluster with the map-values kicker and count", () => {
    render(<MapValuesBody refTable={REF} isActive />);
    expect(screen.getByText(/map values ·/i)).toBeInTheDocument();
    expect(screen.getByText("Deutschland")).toBeInTheDocument();
    expect(screen.getByText("U.S.A.")).toBeInTheDocument();
    expect(screen.getByText(/2 to map/i)).toBeInTheDocument();
  });

  it("shows an Open as grid escape hatch, not a Focused/Grid toggle", () => {
    render(<MapValuesBody refTable={REF} isActive />);
    expect(screen.getByRole("button", { name: /open as grid/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^focused$/i })).not.toBeInTheDocument();
  });
});
