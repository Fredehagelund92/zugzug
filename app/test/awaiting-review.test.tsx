import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Heavy vi.resetModules() + vi.doMock() + await import() cycle per test;
// scope the extended timeout here rather than globally.
vi.setConfig({ testTimeout: 15000 });
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { clearToasts } from "../src/components/Toast";

// Shared stub data
const ME = {
  id: "u_me",
  name: "Ada Berg",
  initials: "AB",
  email: "ada@example.com",
  isSuperAdmin: false,
};
const OTHER = { id: "u_other", name: "Max Thorn", initials: "MT" };
const SYSTEM_USER = { id: "u_system", name: "System", initials: "SY" };

const stubDraftOther = {
  refTableId: "country",
  raw: "USA",
  status: "mapped" as const,
  targetLabel: "United States",
  targetKey: "us",
  user: OTHER,
  at: new Date().toISOString(),
  source: "user" as const,
  confidence: null,
  reasoning: null,
  rejectedReason: null,
  rejectedBy: null,
};

const stubDraftMine = {
  ...stubDraftOther,
  raw: "GBR",
  user: ME,
};

const stubDraftSystem = {
  ...stubDraftOther,
  raw: "DEU",
  targetLabel: "Germany",
  targetKey: "de",
  user: SYSTEM_USER,
};

const stubDraftOtherDim = {
  ...stubDraftOther,
  refTableId: "city",
  raw: "NYC",
  targetLabel: "New York City",
  targetKey: "nyc",
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
    mappedCount: 1,
    totalDistinct: 3,
    unmappedRowsTotal: 100,
    mappedRowsTotal: 50,
    scannedAt: null,
  },
};

const stubCityDim = {
  ...stubDim,
  id: "city",
  refTable: "City",
  dimTable: "zugzug.dim_city",
  mapTable: "zugzug.map_city",
};

function setupMocks({
  drafts = {} as Record<string, typeof stubDraftOther>,
  canEdit = true,
  me = ME,
  refTables = [stubDim],
}: {
  drafts?: Record<string, typeof stubDraftOther>;
  canEdit?: boolean;
  me?: typeof ME | null;
  refTables?: (typeof stubDim)[];
} = {}) {
  vi.doMock("../src/store", async (orig) => {
    const real = await orig<typeof import("../src/store")>();
    return {
      ...real,
      useDrafts: () => drafts,
      useRefTables: () => refTables,
      useCanEdit: () => canEdit,
      useCurrentUser: () => me,
      rejectDrafts: vi.fn(async () => {}),
      commit: vi.fn(async () => ({ committed: 1, rowsRecovered: 0 })),
      fetchPublishState: vi.fn(async () => ({
        version: 1,
        publishedAt: null,
        publishedByName: null,
        pendingDrafts: 1,
        changedKeys: [],
      })),
    };
  });
}

describe("AwaitingReview", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearToasts();
  });

  test("lists only others' staged drafts, grouped by table and author", async () => {
    setupMocks({
      drafts: {
        "country::USA": stubDraftOther,
        "country::GBR": stubDraftMine,
      },
      refTables: [stubDim],
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    // Should show the other person's draft
    expect(screen.getByText("USA")).toBeInTheDocument();
    // My draft must NOT appear
    expect(screen.queryByText("GBR")).not.toBeInTheDocument();
    // Section header present
    expect(screen.getByText(/approve teammates/i)).toBeInTheDocument();
    // Grouped under Country table
    expect(screen.getByText("Country")).toBeInTheDocument();
    // Author name present (appears in group header and provenance column)
    expect(screen.getAllByText("Max Thorn").length).toBeGreaterThan(0);
  });

  test("Approve & publish opens the publish preview (#161)", async () => {
    setupMocks({ drafts: { "country::USA": stubDraftOther }, refTables: [stubDim] });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    const user = userEvent.setup();
    render(<AwaitingReview />);

    await user.click(screen.getByRole("checkbox", { name: /select usa/i }));
    await user.click(screen.getByRole("button", { name: /approve.*publish/i }));

    // handlePublishSelected fetched the state and opened the preview dialog.
    await waitFor(() => expect(screen.getByText(/Publish v\d+ of Country/i)).toBeInTheDocument());
  });

  test("surfaces a toast when the publish-preview fetch fails (#161)", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useDrafts: () => ({ "country::USA": stubDraftOther }),
        useRefTables: () => [stubDim],
        useCanEdit: () => true,
        useCurrentUser: () => ME,
        rejectDrafts: vi.fn(async () => {}),
        commit: vi.fn(async () => ({ committed: 1, rowsRecovered: 0 })),
        fetchPublishState: vi.fn(async () => {
          throw new Error("preview boom");
        }),
      };
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    const { ToastStack } = await import("../src/components/Toast");
    const user = userEvent.setup();
    render(
      <>
        <AwaitingReview />
        <ToastStack />
      </>,
    );

    await user.click(screen.getByRole("checkbox", { name: /select usa/i }));
    await user.click(screen.getByRole("button", { name: /approve.*publish/i }));

    await waitFor(() => expect(screen.getByText(/preview boom/i)).toBeInTheDocument());
  });

  test("renders nothing when all staged drafts are mine", async () => {
    setupMocks({
      drafts: {
        "country::GBR": stubDraftMine,
      },
      refTables: [stubDim],
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    const { container } = render(<AwaitingReview />);
    // Component renders null when nothing to show
    expect(container.firstChild).toBeNull();
  });

  test("reject requires a reason before the button enables", async () => {
    const user = userEvent.setup();
    setupMocks({
      drafts: {
        "country::USA": stubDraftOther,
      },
      refTables: [stubDim],
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    // Select the row
    const checkbox = screen.getByRole("checkbox", { name: /select usa/i });
    await user.click(checkbox);

    // Click "Reject selected" to open inline reject UI
    await user.click(screen.getByRole("button", { name: /send back/i }));

    // The Reject button should now be disabled (no reason entered yet)
    const rejectBtn = screen.getAllByRole("button", { name: /send back/i })[0];
    expect(rejectBtn).toBeDisabled();

    // Type a reason
    const reasonInput = screen.getByPlaceholderText(/reason \(required\)/i);
    await user.type(reasonInput, "Invalid mapping");

    // Now the button should be enabled
    await waitFor(() => {
      expect(rejectBtn).not.toBeDisabled();
    });
  });

  test("system drafts appear under System (rescan)", async () => {
    setupMocks({
      drafts: {
        "country::DEU": stubDraftSystem,
      },
      refTables: [stubDim],
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    expect(screen.getByText("DEU")).toBeInTheDocument();
    // "System (rescan)" appears in the author group header and provenance column
    expect(screen.getAllByText("System (rescan)").length).toBeGreaterThan(0);
  });

  test("viewers see the inbox read-only — no checkboxes or action buttons", async () => {
    setupMocks({
      drafts: {
        "country::USA": stubDraftOther,
      },
      refTables: [stubDim],
      canEdit: false,
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    // Rows are visible
    expect(screen.getByText("USA")).toBeInTheDocument();
    // No checkboxes
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // No publish/reject buttons
    expect(screen.queryByRole("button", { name: /approve .*publish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send back/i })).not.toBeInTheDocument();
  });

  test("reject with one table failing shows partial-failure message and keeps reason input open", async () => {
    const user = userEvent.setup();
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useDrafts: () => ({
          "country::USA": stubDraftOther,
          "city::NYC": stubDraftOtherDim,
        }),
        useRefTables: () => [stubDim, stubCityDim],
        useCanEdit: () => true,
        useCurrentUser: () => ME,
        rejectDrafts: vi.fn(async (refTableId: string) => {
          if (refTableId === "city") throw new Error("city table locked");
        }),
        commit: vi.fn(async () => ({ committed: 1, rowsRecovered: 0 })),
        fetchPublishState: vi.fn(async () => ({
          version: 1,
          publishedAt: null,
          publishedByName: null,
          pendingDrafts: 1,
          changedKeys: [],
        })),
      };
    });

    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    const { ToastStack } = await import("../src/components/Toast");
    render(
      <>
        <AwaitingReview />
        <ToastStack />
      </>,
    );

    // Select both rows via individual row checkboxes
    await user.click(screen.getByRole("checkbox", { name: /select usa/i }));
    await user.click(screen.getByRole("checkbox", { name: /select nyc/i }));

    // Open reject UI
    await user.click(screen.getByRole("button", { name: /send back/i }));

    // Enter reason
    const reasonInput = screen.getByPlaceholderText(/reason \(required\)/i);
    await user.type(reasonInput, "test reason");

    // Submit
    await user.click(screen.getAllByRole("button", { name: /send back/i })[0]);

    // Partial-failure message appears
    await waitFor(() => {
      expect(screen.getByText(/city table locked/i)).toBeInTheDocument();
    });

    // Reason input is still present (reject UI stays open)
    expect(screen.getByPlaceholderText(/reason \(required\)/i)).toBeInTheDocument();
  });
});

describe("Review empty states", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearToasts();
  });

  test("the settled empty state is one emoji + one directive", async () => {
    // RefTable with zero unmapped values — filter="new" → rankedDims is empty → EmptyState shown
    const refTableWithNoNew = {
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
        mappedCount: 5,
        totalDistinct: 5,
        unmappedRowsTotal: 0,
        mappedRowsTotal: 50,
        scannedAt: null,
      },
    };

    vi.doMock("../src/lib/use-tenant-navigate", () => ({
      useTenantNavigate: () => () => {},
      useNavLinks: () => ({
        base: "/app/test-ws",
        dashboard: "/app/test-ws",
        triage: "/app/test-ws/triage",
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
          warehouseDb: null,
          allowedDomain: null,
        }),
        useStoreLoading: () => false,
        useCanEdit: () => true,
        useRefTables: () => [refTableWithNoNew],
        useDrafts: () => ({}),
        saveDraft: vi.fn(),
        discardDraft: vi.fn(),
        commit: vi.fn(async () => ({ committed: 0, rowsRecovered: 0 })),
        fetchPublishState: vi.fn(async () => ({
          version: 1,
          publishedAt: null,
          publishedByName: null,
          pendingDrafts: 0,
          changedKeys: [],
        })),
        dkey: (refTableId: string, raw: string) => `${refTableId}::${raw}`,
      };
    });
    vi.doMock("../src/lib/create-table-modal", () => ({
      useCreateTableModal: () => ({ open: vi.fn() }),
      CreateTableModalProvider: ({ children }: { children: React.ReactNode }) => children,
    }));

    const { Triage } = await import("../src/routes/Triage");
    render(
      <MemoryRouter>
        <Triage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("🎉")).toBeInTheDocument();
    });
    const directive = screen.getByText(/Nothing left to review\./i);
    expect(directive).toBeInTheDocument();
    // The directive must not be wrapped in a <p> (no prose paragraph in the empty state)
    expect(directive.closest("p")).toBeNull();
  });
});
