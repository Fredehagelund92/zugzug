import { describe, test, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import type { MappingRefTable } from "../src/data";

// ── fixtures ──────────────────────────────────────────────────────────────────

const refTableAlpha: MappingRefTable = {
  id: "alpha",
  refTable: "Alpha",
  dimTable: "zugzug.dim_alpha",
  mapTable: "zugzug.map_alpha",
  keyCol: "alpha_id",
  rows: 100,
  record: [],
  counts: {
    newCount: 5,
    mappedCount: 2,
    totalDistinct: 7,
    unmappedRowsTotal: 100,
    mappedRowsTotal: 200,
    scannedAt: null,
  },
  publish: {
    version: 3,
    publishedAt: "2026-07-21T12:00:00Z",
    publishedByName: "Alice",
    pendingDrafts: 1,
    changedRecords: 2,
  },
};

const refTableBravo: MappingRefTable = {
  id: "bravo",
  refTable: "Bravo",
  dimTable: "zugzug.dim_bravo",
  mapTable: "zugzug.map_bravo",
  keyCol: "bravo_id",
  rows: 50,
  record: [],
  counts: {
    newCount: 0,
    mappedCount: 3,
    totalDistinct: 3,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 50,
    scannedAt: null,
  },
  publish: {
    version: 2,
    publishedAt: "2026-07-20T10:00:00Z",
    publishedByName: "Bob",
    pendingDrafts: 0,
    changedRecords: 0,
  },
};

const refTableCharlie: MappingRefTable = {
  id: "charlie",
  refTable: "Charlie",
  dimTable: "zugzug.dim_charlie",
  mapTable: "zugzug.map_charlie",
  keyCol: "charlie_id",
  rows: 75,
  record: [],
  counts: {
    newCount: 2,
    mappedCount: 1,
    totalDistinct: 3,
    unmappedRowsTotal: 50,
    mappedRowsTotal: 75,
    scannedAt: null,
  },
  publish: {
    version: 0,
    publishedAt: null,
    publishedByName: null,
    pendingDrafts: 0,
    changedRecords: 2,
  },
};

const refTablesFixture: MappingRefTable[] = [refTableAlpha, refTableBravo, refTableCharlie];

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/store", () => ({
  useRefTables: () => refTablesFixture,
  useAudit: () => [],
  useDrafts: () => ({}),
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

describe("Dashboard header counts", () => {
  test("the map-table total is labelled mappings, not records", () => {
    // rows = 100 + 50 + 75 map rows; every table has zero approved records.
    // Calling that "225 records" contradicted the Records column on the same
    // page (CONTEXT.md: a record is an approved row, a mapping is the link).
    const { container } = renderDashboard();
    expect(container.textContent).toContain("225 mappings");
    expect(container.textContent).not.toContain("225 records");
  });
});

describe("Dashboard header sorting", () => {
  test("defaults to In review descending and re-sorts when a header is clicked", async () => {
    renderDashboard();

    const bodyRows = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[0].textContent);

    // Default: In review desc → Alpha (5), Charlie (2), Bravo (0)
    expect(bodyRows()[0]).toMatch(/Alpha/);

    // Click "Published" → newest first, never-published last
    fireEvent.click(screen.getByRole("button", { name: /Published/i }));
    expect(bodyRows().at(-1)).toMatch(/Charlie/); // null publishedAt sinks to the bottom

    // "Charlie" (never published) shows "Never" in its Published cell
    expect(screen.getByText("Never")).toBeInTheDocument();
  });
});
