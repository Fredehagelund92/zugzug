import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// Same shape as the other Triage suites: vi.resetModules() + vi.doMock() +
// await import() on a ~1500-line route, which is slow under the parallel run.
vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter } from "react-router-dom";
import React from "react";

/* Review's write paths are all optimistic — the row moves, the draft
 * disappears — so a rejected request has to be reported or the user believes
 * work landed that didn't. These cover the four places that report: the draft
 * error banner, the publish-outcome banner, the published toast, and the
 * "AI isn't set up here" note that replaces a retry button which could only
 * ever fail. */

const stubDim = {
  id: "country",
  refTable: "Country",
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

const me = { id: "u_me", name: "Ada", email: "ada@example.com", role: "admin" as const };

const mappedDraft = {
  refTableId: "country",
  raw: "USA",
  status: "mapped" as const,
  targetLabel: "United States",
  targetKey: "us",
  user: { id: "u_me", name: "Ada", initials: "A" },
  at: "1m ago",
  createdAt: "2026-01-01T00:00:00Z",
  source: "user" as const,
  confidence: null,
  reasoning: null,
  rejectedReason: null,
  rejectedBy: null,
};

const rejectedDraft = { ...mappedDraft, status: "rejected" as const, rejectedBy: "u_other" };

const scanRow = {
  raw: "USA",
  totalRows: 100,
  isMapped: false,
  mappedLabel: null,
  occurrences: [{ table: "sales.orders", column: "country", rows: 100 }],
};

const saveDraft = vi.fn();
const discardDraft = vi.fn();
const commit = vi.fn();
const fetchPublishState = vi.fn();
const toast = vi.fn();
const apiFetch = vi.fn();

interface Opts {
  drafts?: Record<string, unknown>;
  aiConfigured?: boolean;
}

function setupMocks({ drafts = {}, aiConfigured = false }: Opts = {}) {
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
      useCurrentUser: () => me,
      useRefTables: () => [stubDim],
      useDraftsByValue: () => drafts,
      saveDraft,
      discardDraft,
      commit,
      fetchPublishState,
      dkey: (refTableId: string, raw: string) => `${refTableId}::${raw}`,
    };
  });
  vi.doMock("../src/lib/create-table-modal", () => ({
    useCreateTableModal: () => ({ open: vi.fn() }),
    CreateTableModalProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
  vi.doMock("../src/lib/use-ref-table-values-page", () => ({
    useRefTableValuesPage: () => ({
      items: [scanRow],
      hasMore: false,
      loading: false,
      error: null,
      loadMore: vi.fn(),
      refetch: vi.fn(),
    }),
  }));
  vi.doMock("../src/lib/use-ai-hint", () => ({ useAiConfigured: () => aiConfigured }));
  vi.doMock("../src/api", () => ({ apiFetch }));
  vi.doMock("../src/components/Toast", () => ({ toast }));
  vi.doMock("../src/components/AwaitingReview", () => ({ AwaitingReview: () => null }));
}

async function renderTriage() {
  const { Triage } = await import("../src/routes/Triage");
  return render(
    <MemoryRouter>
      <Triage />
    </MemoryRouter>,
  );
}

/** Open the publish preview from the footer's Publish button. */
async function openPreview() {
  fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
  await screen.findByText(/Publish v4 of Country\?/);
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fetchPublishState.mockResolvedValue({
    version: 3,
    publishedAt: null,
    publishedByName: null,
    pendingDrafts: 1,
    changedKeys: [],
    canRevert: false,
  });
  discardDraft.mockResolvedValue(undefined);
  saveDraft.mockResolvedValue(undefined);
});

describe("Review — draft write failures", () => {
  test("a refused restore names the value it couldn't restore", async () => {
    saveDraft.mockRejectedValue(new Error("draft was already published"));
    setupMocks({ drafts: { "country::USA": rejectedDraft } });
    await renderTriage();
    const row = await waitFor(() => {
      const el = document.querySelector('[data-row-key="country::USA"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(within(row).getByRole("button", { name: /restore/i }));
    expect(
      await screen.findByText(`Couldn't restore "USA": draft was already published`),
    ).toBeInTheDocument();
  });

  test("a refused discard from the ready-to-publish list is reported", async () => {
    discardDraft.mockRejectedValue(new Error("not yours to discard"));
    setupMocks({ drafts: { "country::USA": mappedDraft } });
    await renderTriage();
    fireEvent.click(await screen.findByRole("button", { name: /preview 1/i }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(
      await screen.findByText(`Couldn't discard "USA": not yours to discard`),
    ).toBeInTheDocument();
  });
});

describe("Review — publish preview", () => {
  test("dropping a draft from the preview reports a refusal", async () => {
    discardDraft.mockRejectedValue(new Error("already published"));
    setupMocks({ drafts: { "country::USA": mappedDraft } });
    await renderTriage();
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Don't publish mapping for USA" }));
    expect(
      await screen.findByText(`Couldn't discard "USA": already published`),
    ).toBeInTheDocument();
  });

  test("a failed publish keeps the reason on screen instead of toasting it away", async () => {
    commit.mockRejectedValue(new Error("warehouse locked"));
    setupMocks({ drafts: { "country::USA": mappedDraft } });
    await renderTriage();
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    expect(await screen.findByText(/Country failed \(warehouse locked\)/)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  test("a publish whose warehouse copy failed says so — it is not a plain success", async () => {
    commit.mockResolvedValue({ committed: 2, rowsRecovered: 5, warehouseSynced: "failed" });
    setupMocks({ drafts: { "country::USA": mappedDraft } });
    await renderTriage();
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    expect(
      await screen.findByText(/the warehouse copy of Country wasn't updated/),
    ).toBeInTheDocument();
  });

  test("a clean publish toasts the count", async () => {
    commit.mockResolvedValue({ committed: 2, rowsRecovered: 5, warehouseSynced: "n/a" });
    setupMocks({ drafts: { "country::USA": mappedDraft } });
    await renderTriage();
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("✓ 2 changes published · 5 rows recovered"),
    );
  });
});

describe("Review — AI suggestions", () => {
  test("offers a suggestion only when a provider is configured", async () => {
    setupMocks({ aiConfigured: false });
    await renderTriage();
    await waitFor(() => expect(document.querySelector("[data-row-key]")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /suggest with ai/i })).toBeNull();
  });

  test("a 503 says AI isn't set up instead of offering an endless retry", async () => {
    apiFetch.mockResolvedValue({ status: 503, ok: false });
    setupMocks({ aiConfigured: true });
    await renderTriage();
    fireEvent.click(await screen.findByRole("button", { name: /suggest with ai/i }));
    expect(
      await screen.findByText(/AI suggestions aren’t set up for this workspace\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try ai again/i })).toBeNull();
  });

  test("a transport failure leaves a retry, because retrying can work", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));
    setupMocks({ aiConfigured: true });
    await renderTriage();
    fireEvent.click(await screen.findByRole("button", { name: /suggest with ai/i }));
    expect(await screen.findByRole("button", { name: /try ai again/i })).toBeInTheDocument();
  });
});
