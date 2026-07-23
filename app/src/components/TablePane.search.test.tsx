/**
 * TablePane scoped search — tests that the scope selector narrows record
 * filtering to a single column instead of searching across all columns.
 *
 * Strategy: mock the DataGrid (heavy grid, not under test here) to simply
 * render one `[data-testid="row"]` element per row so we can assert counts,
 * and stub all store / router hooks so RecordsBody mounts cleanly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MappingDimension, CanonicalValue } from "../data";

// ── Store mock ────────────────────────────────────────────────────────────────
vi.mock("../store", () => ({
  useSources: () => [],
  useDimensions: () => [],
  useDrafts: () => [],
  useCanEdit: () => false,
  useCurrentUser: () => null,
  fetchPublishState: () => Promise.resolve(null),
  getGridLayout: () => Promise.resolve({}),
  getCachedGridLayout: () => ({}),
  setGridLayout: vi.fn(),
  slug: (s: string) => s,
  // action stubs — none are triggered in this test
  discardDraft: vi.fn(),
  addCanonical: vi.fn(),
  renameCanonical: vi.fn(),
  getCanonical: vi.fn(),
  importRows: vi.fn(),
  mergeCanonical: vi.fn(),
  retireCanonical: vi.fn(),
  fetchVariants: vi.fn(),
  deriveCanonical: vi.fn(),
  addField: vi.fn(),
  setFieldValue: vi.fn(),
  addColumnOption: vi.fn(),
  renameColumn: vi.fn(),
  changeColumnType: vi.fn(),
  deleteColumn: vi.fn(),
  updateFieldRules: vi.fn(),
  updateFieldValidation: vi.fn(),
  updateFieldDescription: vi.fn(),
  updateFieldDisplayFields: vi.fn(),
  insertCanonicalAt: vi.fn(),
  reorderCanonical: vi.fn(),
  patchDimension: vi.fn(),
  rebalancePositions: vi.fn(),
  refreshDimAndNotify: vi.fn(),
  commit: vi.fn(),
  revertChanges: vi.fn(),
  ConflictError: class extends Error {},
  ApiCodeError: class extends Error {},
}));

// ── Library hook stubs ────────────────────────────────────────────────────────
vi.mock("../lib/use-presence", () => ({
  usePresence: () => ({ peers: [] }),
}));
vi.mock("../lib/use-row-activity", () => ({
  useRowActivity: () => ({ recentKeys: new Set() }),
}));
vi.mock("../lib/use-linked-candidates", () => ({
  useLinkedCandidates: () => new Map(),
}));
vi.mock("../lib/open-tabs", () => ({
  useOpenTabs: () => ({ openTab: vi.fn() }),
}));
vi.mock("../lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ table: () => "/" }),
  useNavigate: () => vi.fn(),
}));

// ── Toast stub ────────────────────────────────────────────────────────────────
vi.mock("./Toast", () => ({ toast: vi.fn() }));

// ── DataGrid stub — renders one [data-testid="row"] per row ──────────────────
vi.mock("./datagrid", () => ({
  DataGrid: ({ rows, empty }: { rows: CanonicalValue[]; empty?: React.ReactNode }) =>
    rows.length === 0 ? (
      <div data-testid="empty-state">{empty}</div>
    ) : (
      <div>
        {rows.map((r) => (
          <div key={r.key} data-testid="row">
            {r.label}
          </div>
        ))}
      </div>
    ),
  UndoStackProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUndoStack: () => ({
    push: vi.fn(),
    undo: vi.fn(),
    canUndo: false,
  }),
}));

// ── Heavyweight child stubs ───────────────────────────────────────────────────
vi.mock("./AddFieldPopover", () => ({ AddFieldPopover: () => null }));
vi.mock("./linked/ManageLinkedFieldsPopover", () => ({
  ManageLinkedFieldsPopover: () => null,
}));
vi.mock("./OwnerPicker", () => ({ OwnerPicker: () => null }));
vi.mock("./PublishPreviewDialog", () => ({ PublishPreviewDialog: () => null }));
vi.mock("./VersionHistory", () => ({ VersionHistory: () => null }));
vi.mock("./ImportPreviewDialog", () => ({ ImportPreviewDialog: () => null }));
vi.mock("./RecordHistoryDrawer", () => ({ RecordHistoryDrawer: () => null }));
vi.mock("./ConflictBanner", () => ({ ConflictBanner: () => null }));
vi.mock("./RenameConfirmation", () => ({ RenameConfirmation: () => null }));
vi.mock("./modes/MapValuesBody", () => ({ MapValuesBody: () => null }));
vi.mock("./modes/SourcesMonitorBody", () => ({ SourcesMonitorBody: () => null }));
vi.mock("../hooks/use-add-queue", () => ({ useAddQueue: () => ({ queue: [], flush: vi.fn() }) }));

// Import after mocks
import { TablePane } from "./TablePane";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────
/** Two records: "northern" is in the Name field of record A, and in the
 *  Region field of record B. A global search for "north" returns both.
 *  A scope-to-Region search should return only B. */
const RECORDS: CanonicalValue[] = [
  {
    key: "a",
    label: "Northern Lights Co",
    version: 1,
    fields: { region: "South", name: "northern" },
  },
  {
    key: "b",
    label: "Acme Corp",
    version: 1,
    fields: { region: "northern", name: "Acme" },
  },
];

const DIM: MappingDimension = {
  id: "d1",
  dimension: "Company",
  dimTable: "zz.dim_company",
  mapTable: "zz.map_company",
  keyCol: "company_key",
  rows: 2,
  canonical: RECORDS,
  counts: {
    newCount: 0,
    mappedCount: 2,
    totalDistinct: 2,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 2,
    scannedAt: null,
  },
  fields: [
    { field: "region", label: "Region", type: "text" },
    { field: "name", label: "Name", type: "text" },
  ],
};

function renderPane() {
  return render(
    <MemoryRouter>
      <TablePane dim={DIM} isActive mode="records" />
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("scoped search", () => {
  beforeEach(() => {
    // Reset localStorage so grid layout is clean between tests
    localStorage.clear();
  });

  it("searching 'north' in all columns shows both records", () => {
    renderPane();
    const input = screen.getByPlaceholderText("Search records…");
    fireEvent.change(input, { target: { value: "north" } });
    expect(screen.getAllByTestId("row")).toHaveLength(2);
  });

  it("scoping to Region column narrows matches to only the Region-matching record", async () => {
    renderPane();
    const input = screen.getByPlaceholderText("Search records…");
    fireEvent.change(input, { target: { value: "north" } });

    // Both records visible before scoping
    expect(screen.getAllByTestId("row")).toHaveLength(2);

    // Open the scope selector
    const scopeButton = screen.getByText(/in all columns/i);
    fireEvent.click(scopeButton);

    // Click "Region" in the dropdown
    const regionOption = screen.getByRole("menuitem", { name: /Region/i });
    fireEvent.click(regionOption);

    // Only record B (region = "northern") should remain
    const rows = screen.getAllByTestId("row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Acme Corp");
  });

  it("scoping then clearing scope returns to all-column results", () => {
    renderPane();
    const input = screen.getByPlaceholderText("Search records…");
    fireEvent.change(input, { target: { value: "north" } });

    // Scope to Region
    fireEvent.click(screen.getByText(/in all columns/i));
    fireEvent.click(screen.getByRole("menuitem", { name: /Region/i }));
    expect(screen.getAllByTestId("row")).toHaveLength(1);

    // Open again and select "All columns"
    // The button label now shows "in Region"
    fireEvent.click(screen.getByText(/in Region/i));
    fireEvent.click(screen.getByRole("menuitem", { name: /All columns/i }));
    expect(screen.getAllByTestId("row")).toHaveLength(2);
  });
});
