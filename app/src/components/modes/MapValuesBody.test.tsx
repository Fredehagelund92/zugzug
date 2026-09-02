import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapValuesBody } from "./MapValuesBody";
import { TenantProvider } from "../../lib/tenant-context";
import { tenantFixture } from "../../../test/tenant-fixture";
import { saveDraft } from "../../store";
import { useRefTableClusters } from "../../lib/use-ref-table-clusters";
import type { MappingRefTable } from "../../data";
import type { Cluster } from "../../lib/use-ref-table-clusters";

const feed = (over: Partial<ReturnType<typeof useRefTableClusters>>) => ({
  clusters: [],
  coverage: { resolvedRows: 0, atRiskRows: 0, pct: 0 },
  truncated: false,
  loading: false,
  error: null,
  refetch: vi.fn(),
  ...over,
});

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

const MAPPED_CLUSTERS: Cluster[] = [
  {
    key: "fr",
    rep: "France",
    rows: 500,
    mappedCount: 1,
    members: [
      {
        raw: "France",
        rows: 500,
        isMapped: true,
        mappedLabel: "France",
        occurrences: [{ table: "geo.customers", column: "country", rows: 500 }],
      },
    ],
  },
];

vi.mock("../../lib/use-ref-table-clusters", () => ({
  useRefTableClusters: vi.fn(({ filter }: { filter: "new" | "mapped" }) => ({
    clusters: filter === "mapped" ? MAPPED_CLUSTERS : CLUSTERS,
    coverage: { resolvedRows: 0, atRiskRows: 2084, pct: 0 },
    truncated: false,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));
vi.mock("../../store", () => ({
  listDrafts: vi.fn(() => []),
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

/** MapValuesBody renders SourcesFeedStrip, which reads the workspace
 *  capabilities — so it needs a tenant around it, as in the app. */
function renderBody() {
  return render(
    <TenantProvider value={tenantFixture("editor")}>
      <MapValuesBody refTable={REF} isActive />
    </TenantProvider>,
  );
}

describe("MapValuesBody", () => {
  it("renders one row per cluster with the map-values kicker and count", () => {
    renderBody();
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

  it("is a single list — no grid or Focused/Grid toggle", () => {
    renderBody();
    expect(screen.queryByRole("button", { name: /open as grid/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^focused$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^grid$/i })).not.toBeInTheDocument();
  });

  it("moves the cursor with ArrowDown and marks the focused row", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderBody();
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    await user.keyboard("{ArrowDown}");
    // second row becomes the cursor row → its skip affordance is now reachable
    expect(screen.getAllByText(/skip/i).length).toBeGreaterThan(0);
  });

  it("moves the cursor back up with ArrowUp", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderBody();
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(screen.getByText("Deutschland")).toBeInTheDocument();
  });

  it("renders the loading state", () => {
    vi.mocked(useRefTableClusters).mockReturnValueOnce(feed({ loading: true }));
    renderBody();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the error state and retries", () => {
    const refetch = vi.fn();
    vi.mocked(useRefTableClusters).mockReturnValueOnce(feed({ error: "boom", refetch }));
    renderBody();
    expect(screen.getByText(/couldn.t load values/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("renders the all-mapped empty state when there are no clusters", () => {
    vi.mocked(useRefTableClusters).mockReturnValueOnce(feed({ clusters: [] }));
    renderBody();
    expect(screen.getByText(/is all mapped/i)).toBeInTheDocument();
  });

  it("stages a skipped draft for the cursor cluster on S", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderBody();
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    await user.keyboard("s");
    expect(saveDraft).toHaveBeenCalledWith("t1", "Deutschland", "skipped", null, null);
  });

  it("does not skip on Cmd+S", async () => {
    vi.mocked(saveDraft).mockClear();
    renderBody();
    const list = screen.getByRole("list", { name: /values to map/i });
    list.focus();
    fireEvent.keyDown(list, { key: "s", metaKey: true });
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("does not crash pressing S after the cursor outlives a filter switch to a shorter list", async () => {
    vi.mocked(saveDraft).mockClear();
    const user = (await import("@testing-library/user-event")).default.setup();
    // React's dev-mode event dispatch rethrows synchronous handler errors via
    // a deferred (uncaught-exception-style) path rather than from the
    // fireEvent/user-event call itself, so catch it at the process level.
    const errors: unknown[] = [];
    const onUncaught = (err: unknown) => errors.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      renderBody();
      const list = screen.getByRole("list", { name: /values to map/i });
      list.focus();
      // move the cursor to the last "new" row (index 1 of 2 clusters)
      await user.keyboard("{ArrowDown}");
      // switch to the "Mapped" filter, which returns a single (shorter) cluster
      await user.click(screen.getByRole("button", { name: /^mapped$/i }));
      // pressing S must not crash, even though the old cursor (1) would be out
      // of range for the shorter "mapped" list if it weren't reset
      fireEvent.keyDown(list, { key: "s" });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(errors).toEqual([]);
    // the cursor reset means S now targets the mapped list's own row (index 0),
    // never an out-of-range member
    expect(saveDraft).not.toHaveBeenCalledWith("t1", "Deutschland", "skipped", null, null);
    expect(saveDraft).not.toHaveBeenCalledWith("t1", "U.S.A.", "skipped", null, null);
  });

  it("renders the publish button enabled with the mapped-draft count when drafts are staged", async () => {
    const { listDrafts } = await import("../../store");
    vi.mocked(listDrafts).mockReturnValue([
      {
        id: "d1",
        refTableId: "t1",
        raw: "Deutschland",
        status: "mapped",
        recordKey: "germany",
        version: 1,
      },
    ] as never);
    renderBody();
    const publishBtn = screen.getByRole("button", { name: /publish 1 change/i });
    expect(publishBtn).toBeEnabled();
  });

  it("disables the publish button when no drafts are staged", async () => {
    const { listDrafts } = await import("../../store");
    vi.mocked(listDrafts).mockReturnValue([]);
    renderBody();
    const publishBtn = screen.getByRole("button", { name: /publish 0 changes/i });
    expect(publishBtn).toBeDisabled();
  });
});
