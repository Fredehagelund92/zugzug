/**
 * With nothing left to map and nothing awaiting approval, Review used to
 * replace the whole pane with the celebration state — leaving the values
 * already mapped reachable only by hand-editing the URL.
 *
 * Covers: app/src/routes/Triage.tsx
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter } from "react-router-dom";
import React from "react";

const cleanDim = {
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
    newCount: 0,
    mappedCount: 4,
    totalDistinct: 4,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 400,
    scannedAt: null,
  },
};

function setupMocks() {
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
        adapter: "duckdb",
        writable: false,
        recordMode: "postgres-export",
        warehouseDb: "analytics",
        allowedDomain: null,
      }),
      useStoreLoading: () => false,
      useCanEdit: () => true,
      useRefTables: () => [cleanDim],
      useDrafts: () => ({}),
      saveDraft: vi.fn(),
      discardDraft: vi.fn(),
      dkey: (refTableId: string, raw: string) => `${refTableId}::${raw}`,
    };
  });
  vi.doMock("../src/lib/create-table-modal", () => ({
    useCreateTableModal: () => ({ open: vi.fn() }),
    CreateTableModalProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
}

describe("Review — nothing left to map", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("offers a way to the values already mapped", async () => {
    setupMocks();
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter initialEntries={["/app/test-ws/review"]}>
        <Triage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/nothing left to review/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /review mapped values/i }));

    await waitFor(() => {
      expect(screen.queryByText(/nothing left to review/i)).not.toBeInTheDocument();
      expect(screen.getByText(/already mapped/i)).toBeInTheDocument();
    });
  });
});
