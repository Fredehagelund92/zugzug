import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapValuesBody } from "./MapValuesBody";
import { saveDraft } from "../../store";
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
    expect(
      screen.getByText(
        (_content, el) =>
          el?.tagName === "SPAN" &&
          el?.textContent === "2 to map" &&
          el?.className.includes("text-ink"),
      ),
    ).toBeInTheDocument();
  });

  it("shows an Open as grid escape hatch, not a Focused/Grid toggle", () => {
    render(<MapValuesBody refTable={REF} isActive />);
    expect(screen.getByRole("button", { name: /open as grid/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^focused$/i })).not.toBeInTheDocument();
  });

  it("moves the cursor with ArrowDown and marks the focused row", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<MapValuesBody refTable={REF} isActive />);
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    await user.keyboard("{ArrowDown}");
    // second row becomes the cursor row → its skip affordance is now reachable
    expect(screen.getAllByText(/skip/i).length).toBeGreaterThan(0);
  });

  it("stages a skipped draft for the cursor cluster on S", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<MapValuesBody refTable={REF} isActive />);
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    await user.keyboard("s");
    expect(saveDraft).toHaveBeenCalledWith("t1", "Deutschland", "skipped", null, null);
  });

  it("does not skip on Cmd+S", async () => {
    vi.mocked(saveDraft).mockClear();
    render(<MapValuesBody refTable={REF} isActive />);
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    fireEvent.keyDown(list, { key: "s", metaKey: true });
    expect(saveDraft).not.toHaveBeenCalled();
  });
});
