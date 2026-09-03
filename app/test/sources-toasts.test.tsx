import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SourceInfo } from "../src/store";

/* Every action on this page is fire-and-forget from the button's point of view
 * — the only feedback is the toast. A re-scan that found nothing, a remove of a
 * wiring someone else already deleted, and an outright failure must each say
 * something different, or the page looks identical whatever happened. */

const SOURCES: SourceInfo[] = [
  {
    databaseId: "db-1",
    databaseName: "analytics",
    scanError: null,
    table: "authco.users",
    column: "plan_type",
    refTable: "Plan",
    refTableId: "d1",
    present: true,
    rows: 1000,
    values: 10,
    unmapped: 8,
    scanned: true,
    scannedAt: "2026-07-17T10:00:00Z",
  },
];

const { scanSources, deriveRecord, removeSource, toast } = vi.hoisted(() => ({
  scanSources: vi.fn(),
  deriveRecord: vi.fn(),
  removeSource: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../src/store", () => ({
  useSources: () => SOURCES,
  useRefTables: () => [],
  useCanEdit: () => true,
  useStoreLoading: () => false,
  scanSources,
  deriveRecord,
  removeSource,
}));
vi.mock("../src/components/Toast", () => ({ toast }));
vi.mock("../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({
    table: (id: string) => `/app/default/tables?open=${id}`,
    settings: "/app/default/settings",
    sources: "/app/default/sources",
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

async function renderPage() {
  const { Sources } = await import("../src/routes/Sources");
  return render(
    <MemoryRouter>
      <Sources />
    </MemoryRouter>,
  );
}

/** Expand the "authco" system group and open the Plan row's action menu. */
function openRowMenu() {
  fireEvent.click(screen.getByRole("button", { name: /authco/i }));
  const planRow = screen.getByText("Plan").closest("div.grid")!;
  fireEvent.click(within(planRow).getByLabelText(/more actions/i));
}

describe("Sources — scan all", () => {
  it("reports how many sources were scanned", async () => {
    scanSources.mockResolvedValue(3);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /scan all/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Scanned 3 sources."));
  });

  it("uses the singular for one source", async () => {
    scanSources.mockResolvedValue(1);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /scan all/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Scanned 1 source."));
  });

  it("says so when the scan fails", async () => {
    scanSources.mockRejectedValue(new Error("warehouse unreachable"));
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /scan all/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("warehouse unreachable", "error"));
  });
});

describe("Sources — re-scan one column", () => {
  it("summarises what the re-scan found", async () => {
    deriveRecord.mockResolvedValue({ mode: "connect", matched: 4, unmatched: 2 });
    await renderPage();
    openRowMenu();
    fireEvent.click(screen.getByText(/re-scan/i));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Re-scanned authco.users.plan_type · 4 matched, 2 to review",
      ),
    );
    expect(deriveRecord).toHaveBeenCalledWith("d1", "authco.users", "plan_type", undefined, {
      databaseId: "db-1",
    });
  });

  it("names the column that failed", async () => {
    deriveRecord.mockRejectedValue(new Error("permission denied"));
    await renderPage();
    openRowMenu();
    fireEvent.click(screen.getByText(/re-scan/i));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Couldn't re-scan authco.users.plan_type: permission denied",
        "error",
      ),
    );
  });
});

describe("Sources — remove a wiring", () => {
  it("confirms the removal", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    removeSource.mockResolvedValue(true);
    await renderPage();
    openRowMenu();
    fireEvent.click(screen.getByText(/remove source/i));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Removed authco.users.plan_type.", "success"),
    );
  });

  it("says the wiring was already gone rather than claiming a removal", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    removeSource.mockResolvedValue(false);
    await renderPage();
    openRowMenu();
    fireEvent.click(screen.getByText(/remove source/i));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "authco.users.plan_type was already gone — nothing to remove.",
        "error",
      ),
    );
  });

  it("does nothing when the confirm is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderPage();
    openRowMenu();
    fireEvent.click(screen.getByText(/remove source/i));
    expect(removeSource).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
