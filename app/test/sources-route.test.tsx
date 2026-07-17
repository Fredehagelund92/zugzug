import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SourceInfo } from "../src/store";

const SOURCES: SourceInfo[] = [
  { table: "authco.users", column: "plan_type", dimension: "Plan", dimId: "d1", present: true, rows: 1000, values: 10, unmapped: 8, scanned: true, scannedAt: "2026-07-17T10:00:00Z" },
  { table: "billing.invoices", column: "currency", dimension: "Currency", dimId: "d2", present: true, rows: 50, values: 5, unmapped: 0, scanned: true, scannedAt: "2026-07-16T10:00:00Z" },
];
const removeSource = vi.fn().mockResolvedValue(undefined);
const useSources = vi.fn(() => SOURCES);

vi.mock("../src/store", () => ({
  useSources,
  useDimensions: () => [],
  useCanEdit: () => true,
  useStoreLoading: () => false,
  scanSources: vi.fn(),
  deriveCanonical: vi.fn(),
  removeSource,
}));

beforeEach(() => {
  useSources.mockImplementation(() => SOURCES);
});
vi.mock("../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({
    table: (id: string) => `/app/default/tables?open=${id}&active=${id}&mode=match`,
    settings: "/app/default/settings",
    sources: "/app/default/sources",
  }),
}));

async function renderPage() {
  const { Sources } = await import("../src/routes/Sources");
  return render(<MemoryRouter><Sources /></MemoryRouter>);
}

describe("Sources route", () => {
  it("empty state says 'connected', not 'wired'", async () => {
    useSources.mockImplementation(() => []);
    await renderPage();
    expect(screen.queryByText(/wired/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/No sources connected yet/i).length).toBeGreaterThan(0);
  });

  it("renders the connection lede without monitoring copy", async () => {
    await renderPage();
    expect(screen.getByText(/2 columns connected across 2 systems/i)).toBeInTheDocument();
    expect(screen.queryByText(/standing · today/i)).toBeNull();
  });

  it("shows the review pointer linking to the most-affected table", async () => {
    await renderPage();
    const link = screen.getByText(/review/i).closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("open=d1"));
  });

  it("collapsing a system hides its rows", async () => {
    await renderPage();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /authco/i }));
    expect(screen.queryByText("Plan")).toBeNull();
  });

  it("Remove source (with confirm) calls store.removeSource", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPage();
    // Scope to the Plan row (the grid container) so the "more actions" button
    // of that specific row is reachable. SourceRow wraps the target name in a
    // classed <span>, so we walk up to the row's grid rather than the target cell.
    const planRow = screen.getByText("Plan").closest("div.grid")!;
    fireEvent.click(within(planRow).getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/remove source/i));
    expect(removeSource).toHaveBeenCalledWith("d1", "authco.users", "plan_type");
  });
});
