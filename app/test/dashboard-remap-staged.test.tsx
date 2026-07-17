import { describe, test, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import type { MappingDimension } from "../src/data";
import type { Draft } from "../src/store";

// ── fixtures ──────────────────────────────────────────────────────────────────

const dimA: MappingDimension = {
  id: "country",
  dimension: "Country",
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  rows: 300,
  canonical: [],
  counts: { newCount: 1, mappedCount: 2, totalDistinct: 3, unmappedRowsTotal: 100, mappedRowsTotal: 200, scannedAt: null },
};

const dimB: MappingDimension = {
  id: "region",
  dimension: "Region",
  dimTable: "zugzug.dim_region",
  mapTable: "zugzug.map_region",
  keyCol: "region_code",
  rows: 200,
  canonical: [],
  counts: { newCount: 0, mappedCount: 3, totalDistinct: 3, unmappedRowsTotal: 0, mappedRowsTotal: 200, scannedAt: null },
};

const dimC: MappingDimension = {
  id: "channel",
  dimension: "Channel",
  dimTable: "zugzug.dim_channel",
  mapTable: "zugzug.map_channel",
  keyCol: "channel_id",
  rows: 150,
  canonical: [],
  counts: { newCount: 0, mappedCount: 3, totalDistinct: 3, unmappedRowsTotal: 0, mappedRowsTotal: 150, scannedAt: null },
};

const remapDraft: Draft = {
  dimId: "channel",
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

const dimensionsFixture: MappingDimension[] = [dimA, dimB, dimC];
const draftsFixture: Record<string, Draft> = {
  "channel::fb": remapDraft,
};

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/store", () => ({
  useDimensions: () => dimensionsFixture,
  useAudit: () => [],
  useDrafts: () => draftsFixture,
  useWorkspaceInfo: () => ({ adapter: "motherduck", warehouseDb: "md:demo", writable: true }),
  useStoreLoading: () => false,
  useConnectionHealth: () => ({
    warehouse: { status: "ok", lastCheckedAt: new Date().toISOString() },
    postgres: { status: "ok", lastCheckedAt: new Date().toISOString() },
  }),
  refreshConnectionHealth: vi.fn(async () => undefined),
  usePreferences: () => ({ scanSchedule: null, publishThreshold: 0.9, suggestThreshold: 0.6 }),
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

vi.mock("../src/lib/engineer-mode", () => ({ useEngineerMode: () => ({ engineer: false }) }));

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
  test("page meta shows '1 drafts staged' for the remap-only dim", () => {
    renderDashboard();
    // Status chip now renders the count in a nested <span>, so match on the
    // parent span's full text content using a function matcher.
    expect(
      screen.getByText((_, el) => el?.textContent?.replace(/\s+/g, " ").trim() === "1 drafts staged"),
    ).toBeInTheDocument();
  });

  test("'Needs attention' toolbar pill counts dims with unmapped OR staged drafts (2)", () => {
    renderDashboard();
    const pill = screen.getByText("Needs attention").closest("button");
    expect(pill).not.toBeNull();
    expect(within(pill as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  test("'Clean' toolbar pill counts only the truly clean dim (1)", () => {
    renderDashboard();
    const pill = screen.getByText("Clean").closest("button");
    expect(pill).not.toBeNull();
    expect(within(pill as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  test("Dim C (remap-only) row shows the 'staged' status badge", () => {
    renderDashboard();
    const rows = screen.getAllByRole("row");
    const channelRow = rows.find((r) => within(r).queryByText("Channel"));
    expect(channelRow).toBeDefined();
    expect(within(channelRow as HTMLElement).getByText(/^staged$/i)).toBeInTheDocument();
  });

  test("Dim B (no drafts, all mapped) row shows the 'clean' status badge", () => {
    renderDashboard();
    const rows = screen.getAllByRole("row");
    const regionRow = rows.find((r) => within(r).queryByText("Region"));
    expect(regionRow).toBeDefined();
    expect(within(regionRow as HTMLElement).getByText(/^clean$/i)).toBeInTheDocument();
  });

  test("Urgency sort order: Dim A (unmapped) → Dim C (staged) → Dim B (clean)", () => {
    renderDashboard();
    const rows = screen.getAllByRole("row");
    // First row is the header; body rows follow.
    const bodyDimNames = rows
      .map((r) => {
        if (within(r).queryByText("Country")) return "Country";
        if (within(r).queryByText("Channel")) return "Channel";
        if (within(r).queryByText("Region")) return "Region";
        return null;
      })
      .filter((x): x is string => x !== null);
    expect(bodyDimNames).toEqual(["Country", "Channel", "Region"]);
  });
});
