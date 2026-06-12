import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  dimension: "Country",
  values: [
    {
      value: "USA",
      status: "new",
      current: null,
      suggestion: null,
      confidence: 0,
      sources: [{ table: "raw.users", column: "country", rows: 100 }],
    },
  ],
  canonical: [],
  fields: [],
  rows: 0,
  color: null,
  description: null,
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  keyKind: "slug",
};

const stubDraft = {
  dimId: "country",
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
      triage: "/app/test-ws/triage",
      sources: "/app/test-ws/sources",
      tables: "/app/test-ws/tables",
      settings: "/app/test-ws/settings",
      table: (dimId: string) => `/app/test-ws/tables?open=${dimId}`,
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
        canonicalMode: writable ? "warehouse" : "postgres-export",
        warehouseDb: "analytics",
        defaultEngineerMode: true,
        allowedDomain: null,
      }),
      useDimensions: () => [stubDim],
      useDrafts: () => ({ "country::USA": stubDraft }),
      saveDraft: vi.fn(),
      discardDraft: vi.fn(),
      commit: vi.fn(async () => ({ committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" as const })),
      dkey: (dimId: string, raw: string) => `${dimId}::${raw}`,
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

  test("postgres-export mode: button says 'Publish' + 'Download snapshot' link", async () => {
    setupMocks(false);
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/^Publish$/)).toBeInTheDocument();
      expect(screen.getByText(/download snapshot/i)).toBeInTheDocument();
    });
  });
});
