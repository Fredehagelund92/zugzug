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
  canonical: [],
  fields: [],
  rows: 1000,
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

const stubRejectedDraft = {
  dimId: "country",
  raw: "USA",
  status: "rejected" as const,
  targetLabel: "United States",
  targetKey: "us",
  user: { id: "u_reviewer", name: "Reviewer", initials: "R" },
  at: "2m ago",
  source: "user" as const,
  confidence: null,
  reasoning: null,
  rejectedReason: "does not match our naming convention",
  rejectedBy: "u_reviewer",
};

const stubScanValueRow = {
  raw: "USA",
  totalRows: 100,
  isMapped: false,
  mappedLabel: null,
  occurrences: [{ table: "sales.orders", column: "country", rows: 100 }],
};

function setupMocks() {
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
        adapter: "duckdb",
        writable: false,
        canonicalMode: "postgres-export",
        warehouseDb: null,
        defaultEngineerMode: false,
        allowedDomain: null,
      }),
      useStoreLoading: () => false,
      useCanEdit: () => true,
      useDimensions: () => [stubDim],
      useDrafts: () => ({ "country::USA": stubRejectedDraft }),
      saveDraft: vi.fn().mockResolvedValue(undefined),
      discardDraft: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn(async () => ({ committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" as const })),
      dkey: (dimId: string, raw: string) => `${dimId}::${raw}`,
    };
  });
  vi.doMock("../src/lib/create-table-modal", () => ({
    useCreateTableModal: () => ({ open: vi.fn() }),
    CreateTableModalProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
  vi.doMock("../src/lib/use-dim-values-page", () => ({
    useDimValuesPage: () => ({
      items: [stubScanValueRow],
      hasMore: false,
      loading: false,
      error: null,
      loadMore: vi.fn(),
      refetch: vi.fn(),
    }),
  }));
  vi.doMock("../src/lib/use-ai-hint", () => ({
    useAiHint: () => ({ hint: null, loading: false, error: false }),
  }));
  vi.doMock("../src/api", () => ({
    apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })),
  }));
  vi.doMock("../src/components/AwaitingReview", () => ({
    AwaitingReview: () => null,
  }));
}

describe("Triage — rejected draft presentation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("rejected draft shows danger-tinted badge with the reason", async () => {
    setupMocks();
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      // The rejected badge should contain the word "rejected" and the reason
      const badge = screen.getByTitle("does not match our naming convention");
      expect(badge).toBeInTheDocument();
      expect(badge.textContent).toMatch(/rejected.*does not match/i);
    });
  });

  test("rejected draft shows Re-stage button", async () => {
    setupMocks();
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /re-stage/i })).toBeInTheDocument();
    });
  });

  test("Re-stage button calls saveDraft to clear the rejection", async () => {
    setupMocks();
    const storeMod = await import("../src/store");
    const saveDraftMock = vi.mocked(storeMod.saveDraft);
    const { Triage } = await import("../src/routes/Triage");
    const { fireEvent } = await import("@testing-library/react");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    await waitFor(() => screen.getByRole("button", { name: /re-stage/i }));
    fireEvent.click(screen.getByRole("button", { name: /re-stage/i }));
    // saveDraft should be called to re-stage the draft (clearing rejection on server)
    await waitFor(() => {
      expect(saveDraftMock).toHaveBeenCalledWith(
        "country",
        "USA",
        "mapped",
        "United States",
        "us",
      );
    });
  });
});
