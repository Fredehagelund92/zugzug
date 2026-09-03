import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter } from "react-router-dom";
import React from "react";

const stubTenant = {
  id: "test-ws",
  slug: "test-ws",
  label: "Test Workspace",
  role: "admin" as const,
  isSuperAdmin: false,
};

const stubDim = {
  id: "country",
  refTable: "Country",
  record: [],
  fields: [],
  rows: 0,
  color: null,
  description: null,
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  keyKind: "slug",
  counts: {
    newCount: 1,
    mappedCount: 0,
    totalDistinct: 1,
    unmappedRowsTotal: 100,
    mappedRowsTotal: 0,
    scannedAt: null,
  },
};

const stubDraft = {
  refTableId: "country",
  raw: "USA",
  status: "mapped" as const,
  targetLabel: "United States",
  targetKey: "us",
  user: { id: "u_test", name: "Test", initials: "T" },
  at: "1m ago",
};

function setupMocks(writable: boolean) {
  vi.doMock("../src/lib/use-tenant-navigate", () => ({
    useTenantNavigate: () => () => {},
    useNavLinks: () => ({
      base: "/app/test-ws",
      dashboard: "/app/test-ws",
      review: "/app/test-ws/review",
      sources: "/app/test-ws/sources",
      tables: "/app/test-ws/tables",
      settings: "/app/test-ws/settings",
      table: (refTableId: string) => `/app/test-ws/tables?open=${refTableId}`,
      tablesFocus: (key: string) => `/app/test-ws/tables?focus=${key}`,
    }),
  }));
  vi.doMock("../src/store", async (orig) => {
    const real = await orig<typeof import("../src/store")>();
    return {
      ...real,
      useWorkspaceInfo: () => ({
        adapter: writable ? "snowflake" : "duckdb",
        writable,
        recordMode: writable ? "warehouse" : "postgres-export",
        warehouseDb: "analytics",
        allowedDomain: null,
      }),
      useStoreLoading: () => false,
      useCanEdit: () => true,
      useRefTables: () => [stubDim],
      useDrafts: () => ({ "country::USA": stubDraft }),
      saveDraft: vi.fn(),
      discardDraft: vi.fn(),
      commit: vi.fn(async () => ({
        committed: 0,
        rowsRecovered: 0,
        warehouseSynced: "n/a" as const,
      })),
      dkey: (refTableId: string, raw: string) => `${refTableId}::${raw}`,
    };
  });
  vi.doMock("../src/lib/create-table-modal", () => ({
    useCreateTableModal: () => ({ open: vi.fn() }),
    CreateTableModalProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
}

describe("Review publish affordance copy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("writable mode: button says 'Publish to warehouse'", async () => {
    setupMocks(true);
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/publish to warehouse/i)).toBeInTheDocument();
    });
  });

  test("postgres-export mode: button says 'Publish'", async () => {
    setupMocks(false);
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/^Publish$/)).toBeInTheDocument();
    });
  });
});
