import { describe, test, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import type { MappingRefTable } from "../src/data";
import type { Draft } from "../src/store";

// ── fixtures ──────────────────────────────────────────────────────────────────

const refTableA: MappingRefTable = {
  id: "country",
  refTable: "Country",
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  rows: 300,
  record: [],
  counts: {
    newCount: 1,
    mappedCount: 2,
    totalDistinct: 3,
    unmappedRowsTotal: 100,
    mappedRowsTotal: 200,
    scannedAt: null,
  },
};

const refTableB: MappingRefTable = {
  id: "region",
  refTable: "Region",
  dimTable: "zugzug.dim_region",
  mapTable: "zugzug.map_region",
  keyCol: "region_code",
  rows: 200,
  record: [],
  counts: {
    newCount: 0,
    mappedCount: 3,
    totalDistinct: 3,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 200,
    scannedAt: null,
  },
};

const refTableC: MappingRefTable = {
  id: "channel",
  refTable: "Channel",
  dimTable: "zugzug.dim_channel",
  mapTable: "zugzug.map_channel",
  keyCol: "channel_id",
  rows: 150,
  record: [],
  counts: {
    newCount: 0,
    mappedCount: 3,
    totalDistinct: 3,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 150,
    scannedAt: null,
  },
};

const remapDraft: Draft = {
  refTableId: "channel",
  raw: "fb",
  status: "mapped",
  targetLabel: "facebook-paid",
  targetKey: "facebook_paid",
  user: { id: "u1", name: "Ada Berg", initials: "AB" },
  at: "1m ago",
  source: "user",
  confidence: "high",
  reasoning: null,
};

const refTablesFixture: MappingRefTable[] = [refTableA, refTableB, refTableC];
const draftsFixture: Record<string, Draft> = {
  "channel::fb": remapDraft,
};

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/store", () => ({
  useRefTables: () => refTablesFixture,
  useAudit: () => [],
  useDrafts: () => draftsFixture,
  useWorkspaceInfo: () => ({ adapter: "motherduck", warehouseDb: "md:demo", writable: true }),
  useStoreLoading: () => false,
  useConnectionHealth: () => ({
    warehouse: { status: "ok", lastCheckedAt: new Date().toISOString() },
    postgres: { status: "ok", lastCheckedAt: new Date().toISOString() },
  }),
  refreshConnectionHealth: vi.fn(async () => undefined),
  usePreferences: () => ({ scanSchedule: null }),
  setPreferences: vi.fn(),
  scanSources: vi.fn(async () => 0),
  invalidate: {
    currentUser: vi.fn(),
    tenant: vi.fn(),
    memberships: vi.fn(),
    members: vi.fn(),
    scans: vi.fn(),
    audit: vi.fn(),
    warehouses: vi.fn(),
    tenantList: vi.fn(),
    adminUsers: vi.fn(),
  },
  subscribeInvalidate: vi.fn(() => () => undefined),
}));

vi.mock("../src/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  authFetch: vi.fn(async () => new Response("", { status: 200 })),
  fetchWarehouseDatabases: vi.fn(async () => []),
}));

import { Dashboard } from "../src/routes/Dashboard";

function renderDashboard() {
  const value: TenantContextValue = {
    id: "t1",
    slug: "acme",
    label: "Acme",
    role: "editor",
    isSuperAdmin: false,
  };
  return render(
    <MemoryRouter>
      <TenantProvider value={value}>
        <Dashboard />
      </TenantProvider>
    </MemoryRouter>,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Dashboard — staged remap detection", () => {
  test("page meta shows '0 to publish' when no refTables have publish data", () => {
    renderDashboard();
    // Header meta now shows "to publish" figure (no drafts concept at this level).
    // RefTables in this fixture have no publish field → toPublishTotal = 0.
    const headerSpan = screen
      .getAllByText((_, el) => el?.textContent?.replace(/\s+/g, " ").trim() === "0 to publish")
      .find((el) => !el.closest("tr"));
    expect(headerSpan).toBeDefined();
  });

  test("'Needs attention' toolbar pill counts only refTables with unmapped values (1)", () => {
    renderDashboard();
    // With no publish summaries, toPublishCount=0 for all refTables.
    // Only Country (newCount=1) triggers attention; Channel's staged draft no longer counts.
    const pill = screen.getByText("Needs attention").closest("button");
    expect(pill).not.toBeNull();
    expect(within(pill as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  test("'Clean' toolbar pill counts refTables with no in-review and no to-publish (2)", () => {
    renderDashboard();
    // Region (newCount=0, no publish) and Channel (newCount=0, no publish) are both clean.
    const pill = screen.getByText("Clean").closest("button");
    expect(pill).not.toBeNull();
    expect(within(pill as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  test("RefTable C (remap-only, no publish data) row shows '—' in To publish column", () => {
    renderDashboard();
    const rows = screen.getAllByRole("row");
    const channelRow = rows.find((r) => within(r).queryByText("Channel"));
    expect(channelRow).toBeDefined();
    // No publish summary → toPublishCount = 0 → "—" in To publish column
    const dashes = within(channelRow as HTMLElement).getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  test("RefTable B (no drafts, all mapped) row shows '—' placeholders for in-review and to-publish", () => {
    renderDashboard();
    const rows = screen.getAllByRole("row");
    const regionRow = rows.find((r) => within(r).queryByText("Region"));
    expect(regionRow).toBeDefined();
    // Clean rows show '—' in In review and To publish columns
    const dashes = within(regionRow as HTMLElement).getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  test("Default sort (In review desc): RefTable A (unmapped) comes first", () => {
    renderDashboard();
    const rows = screen.getAllByRole("row");
    // First row is the header; body rows follow. Country (newCount=1) should be first.
    const bodyRefTableNames = rows
      .map((r) => {
        if (within(r).queryByText("Country")) return "Country";
        if (within(r).queryByText("Channel")) return "Channel";
        if (within(r).queryByText("Region")) return "Region";
        return null;
      })
      .filter((x): x is string => x !== null);
    expect(bodyRefTableNames[0]).toBe("Country");
  });
});
