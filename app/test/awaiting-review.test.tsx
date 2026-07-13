import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { clearToasts } from "../src/components/Toast";

// Shared stub data
const ME = { id: "u_me", name: "Ada Berg", initials: "AB", email: "ada@example.com", isSuperAdmin: false };
const OTHER = { id: "u_other", name: "Max Thorn", initials: "MT" };
const SYSTEM_USER = { id: "u_system", name: "System", initials: "SY" };

const stubDraftOther = {
  dimId: "country",
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
  dimId: "city",
  raw: "NYC",
  targetLabel: "New York City",
  targetKey: "nyc",
};

const stubDim = {
  id: "country",
  dimension: "Country",
  canonical: [],
  fields: [],
  rows: 0,
  color: null,
  description: null,
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  keyKind: "slug",
  counts: { newCount: 1, mappedCount: 1, totalDistinct: 3, unmappedRowsTotal: 100, mappedRowsTotal: 50, scannedAt: null },
};

const stubCityDim = {
  ...stubDim,
  id: "city",
  dimension: "City",
  dimTable: "zugzug.dim_city",
  mapTable: "zugzug.map_city",
};

function setupMocks({
  drafts = {} as Record<string, typeof stubDraftOther>,
  canEdit = true,
  me = ME,
  dims = [stubDim],
}: {
  drafts?: Record<string, typeof stubDraftOther>;
  canEdit?: boolean;
  me?: typeof ME | null;
  dims?: typeof stubDim[];
} = {}) {
  vi.doMock("../src/store", async (orig) => {
    const real = await orig<typeof import("../src/store")>();
    return {
      ...real,
      useDrafts: () => drafts,
      useDimensions: () => dims,
      useCanEdit: () => canEdit,
      useCurrentUser: () => me,
      rejectDrafts: vi.fn(async () => {}),
      commit: vi.fn(async () => ({ committed: 1, rowsRecovered: 0 })),
      fetchPublishState: vi.fn(async () => ({ version: 1, publishedAt: null, publishedByName: null, pendingDrafts: 1, changedKeys: [] })),
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
      dims: [stubDim],
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    // Should show the other person's draft
    expect(screen.getByText("USA")).toBeInTheDocument();
    // My draft must NOT appear
    expect(screen.queryByText("GBR")).not.toBeInTheDocument();
    // Section header present
    expect(screen.getByText(/awaiting review/i)).toBeInTheDocument();
    // Grouped under Country table
    expect(screen.getByText("Country")).toBeInTheDocument();
    // Author name present (appears in group header and provenance column)
    expect(screen.getAllByText("Max Thorn").length).toBeGreaterThan(0);
  });

  test("renders nothing when all staged drafts are mine", async () => {
    setupMocks({
      drafts: {
        "country::GBR": stubDraftMine,
      },
      dims: [stubDim],
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
      dims: [stubDim],
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    // Select the row
    const checkbox = screen.getByRole("checkbox", { name: /select usa/i });
    await user.click(checkbox);

    // Click "Reject selected" to open inline reject UI
    await user.click(screen.getByRole("button", { name: /reject selected/i }));

    // The Reject button should now be disabled (no reason entered yet)
    const rejectBtn = screen.getAllByRole("button", { name: /reject selected/i })[0];
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
      dims: [stubDim],
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
      dims: [stubDim],
      canEdit: false,
    });
    const { AwaitingReview } = await import("../src/components/AwaitingReview");
    render(<AwaitingReview />);

    // Rows are visible
    expect(screen.getByText("USA")).toBeInTheDocument();
    // No checkboxes
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // No publish/reject buttons
    expect(screen.queryByRole("button", { name: /publish selected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject selected/i })).not.toBeInTheDocument();
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
        useDimensions: () => [stubDim, stubCityDim],
        useCanEdit: () => true,
        useCurrentUser: () => ME,
        rejectDrafts: vi.fn(async (dimId: string) => {
          if (dimId === "city") throw new Error("city table locked");
        }),
        commit: vi.fn(async () => ({ committed: 1, rowsRecovered: 0 })),
        fetchPublishState: vi.fn(async () => ({ version: 1, publishedAt: null, publishedByName: null, pendingDrafts: 1, changedKeys: [] })),
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
    await user.click(screen.getByRole("button", { name: /reject selected/i }));

    // Enter reason
    const reasonInput = screen.getByPlaceholderText(/reason \(required\)/i);
    await user.type(reasonInput, "test reason");

    // Submit
    await user.click(screen.getAllByRole("button", { name: /reject selected/i })[0]);

    // Partial-failure message appears
    await waitFor(() => {
      expect(screen.getByText(/city table locked/i)).toBeInTheDocument();
    });

    // Reason input is still present (reject UI stays open)
    expect(screen.getByPlaceholderText(/reason \(required\)/i)).toBeInTheDocument();
  });
});
