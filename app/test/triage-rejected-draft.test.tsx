import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

// This file uses vi.resetModules() + vi.doMock() + await import() on a heavy
// component (Triage.tsx, ~1100 lines) per test. Under the full parallel suite
// each cycle can approach 12 s; scope the extended timeout here rather than
// globally so other files use the 5 s default.
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
  dimension: "Country",
  record: [],
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
        recordMode: "postgres-export",
        warehouseDb: null,
        allowedDomain: null,
      }),
      useStoreLoading: () => false,
      useCanEdit: () => true,
      // Return current user matching the rejected-draft author so Re-stage button renders.
      useCurrentUser: () => ({
        id: "u_reviewer",
        name: "Reviewer",
        email: "r@example.com",
        role: "admin" as const,
      }),
      useDimensions: () => [stubDim],
      useDrafts: () => ({ "country::USA": stubRejectedDraft }),
      saveDraft: vi.fn().mockResolvedValue(undefined),
      discardDraft: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn(async () => ({
        committed: 0,
        rowsRecovered: 0,
        warehouseSynced: "n/a" as const,
      })),
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
      const rowEl = document.querySelector('[data-row-key="country::USA"]') ?? document.body;
      expect(
        within(rowEl as HTMLElement).getByRole("button", { name: /re-stage/i }),
      ).toBeInTheDocument();
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
    await waitFor(() => {
      const rowEl = document.querySelector('[data-row-key="country::USA"]') ?? document.body;
      within(rowEl as HTMLElement).getByRole("button", { name: /re-stage/i });
    });
    const rowEl = document.querySelector('[data-row-key="country::USA"]') ?? document.body;
    fireEvent.click(within(rowEl as HTMLElement).getByRole("button", { name: /re-stage/i }));
    // saveDraft should be called to re-stage the draft (clearing rejection on server)
    await waitFor(() => {
      expect(saveDraftMock).toHaveBeenCalledWith("country", "USA", "mapped", "United States", "us");
    });
  });

  test("Re-stage button is hidden for a non-author of the rejected draft", async () => {
    // Override useCurrentUser to return a different user than the draft author
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          recordMode: "postgres-export",
          warehouseDb: null,
          allowedDomain: null,
        }),
        useStoreLoading: () => false,
        useCanEdit: () => true,
        // Different user — not the draft author
        useCurrentUser: () => ({
          id: "u_other",
          name: "Other",
          email: "o@example.com",
          role: "admin" as const,
        }),
        useDimensions: () => [stubDim],
        useDrafts: () => ({ "country::USA": stubRejectedDraft }),
        saveDraft: vi.fn().mockResolvedValue(undefined),
        discardDraft: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn(async () => ({
          committed: 0,
          rowsRecovered: 0,
          warehouseSynced: "n/a" as const,
        })),
        dkey: (dimId: string, raw: string) => `${dimId}::${raw}`,
      };
    });
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
    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );
    // Wait for the rejected badge to appear, then confirm Re-stage is absent
    await waitFor(() => {
      expect(screen.getByTitle("does not match our naming convention")).toBeInTheDocument();
    });
    const rowEl = document.querySelector('[data-row-key="country::USA"]') ?? document.body;
    expect(within(rowEl as HTMLElement).queryByRole("button", { name: /re-stage/i })).toBeNull();
  });
});

describe("Match mode — rejected draft guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("accept on a rejected row is a no-op — saveDraft is not called", async () => {
    setupMocks();
    // Override the AI hint so `accept` has a suggestion to act on — the guard,
    // not a missing suggestion, must be what stops the write.
    vi.doMock("../src/lib/use-ai-hint", () => ({
      useAiHint: () => ({
        hint: { suggestion: "United States" },
        loading: false,
        error: false,
      }),
    }));
    const storeMod = await import("../src/store");
    const saveDraftMock = vi.mocked(storeMod.saveDraft);
    const { MatchModeBody } = await import("../src/components/modes/MatchModeBody");
    const { UndoStackProvider } = await import("../src/components/datagrid");
    const { fireEvent } = await import("@testing-library/react");
    render(
      <MemoryRouter>
        <UndoStackProvider>
          <MatchModeBody dim={stubDim as never} isActive />
        </UndoStackProvider>
      </MemoryRouter>,
    );
    // Wait for the row cell, set the cursor on it, then press `a` (accept).
    await waitFor(() => {
      expect(document.querySelector('[data-cell="USA::value"]')).toBeInTheDocument();
    });
    const cell = document.querySelector('[data-cell="USA::value"]') as HTMLElement;
    fireEvent.pointerDown(cell, { button: 0 });
    const grid = document.querySelector('[role="grid"]') as HTMLElement;
    fireEvent.keyDown(grid, { key: "a" });
    // The rejected guard in stageMap must swallow the action entirely.
    expect(saveDraftMock).not.toHaveBeenCalled();
    // Row still presents as rejected.
    expect(screen.getByTitle("does not match our naming convention")).toBeInTheDocument();
  });
});
