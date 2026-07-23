/**
 * TablePane validation wiring — tests that the validate callback built from
 * columns + rows is passed to DataGrid so duplicate values in unique columns
 * are refused at edit-time and the reason surfaces via the flash/notice system.
 *
 * Strategy: mirror the mount pattern from TablePane.search.test.tsx — mock
 * DataGrid to expose validate + onInvalidCommit as callable props, stub all
 * store/router hooks. Drive validation directly through the stub.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MappingDimension, CanonicalValue } from "../data";

// ── Store mock ────────────────────────────────────────────────────────────────
vi.mock("../store", () => ({
  useSources: () => [],
  useDimensions: () => [],
  useDrafts: () => [],
  useCanEdit: () => true,
  useCurrentUser: () => null,
  fetchPublishState: () => Promise.resolve(null),
  getGridLayout: () => Promise.resolve({}),
  getCachedGridLayout: () => ({}),
  setGridLayout: vi.fn(),
  slug: (s: string) => s,
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

// ── DataGrid stub — captures validate + onInvalidCommit for inspection ────────
let capturedValidate:
  | ((field: string, value: unknown, rowKey: string) => string | null)
  | undefined;
let capturedOnInvalidCommit: ((rowKey: string, field: string, msg: string) => void) | undefined;

vi.mock("./datagrid", () => ({
  DataGrid: ({
    rows,
    validate,
    onInvalidCommit,
    empty,
  }: {
    rows: CanonicalValue[];
    validate?: (field: string, value: unknown, rowKey: string) => string | null;
    onInvalidCommit?: (rowKey: string, field: string, msg: string) => void;
    empty?: React.ReactNode;
  }) => {
    capturedValidate = validate;
    capturedOnInvalidCommit = onInvalidCommit;
    return rows.length === 0 ? (
      <div data-testid="empty-state">{empty}</div>
    ) : (
      <div>
        {rows.map((r) => (
          <div key={r.key} data-testid="row">
            {r.label}
          </div>
        ))}
      </div>
    );
  },
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

afterEach(() => {
  cleanup();
  capturedValidate = undefined;
  capturedOnInvalidCommit = undefined;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
const RECORDS: CanonicalValue[] = [
  {
    key: "namr",
    label: "NAMR",
    version: 1,
    fields: { ticker: "NAMR" },
  },
  {
    key: "apac",
    label: "APAC",
    version: 1,
    fields: { ticker: "APAC" },
  },
];

const DIM: MappingDimension = {
  id: "d1",
  dimension: "Region",
  dimTable: "zz.dim_region",
  mapTable: "zz.map_region",
  keyCol: "region_key",
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
    {
      field: "ticker",
      label: "Ticker",
      type: "text",
      validation: { unique: true },
    },
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
describe("table-view validation wiring", () => {
  it("passes a validate callback to DataGrid when canEdit is true", () => {
    renderPane();
    expect(capturedValidate).toBeTypeOf("function");
  });

  it("validate returns null for a non-duplicate value in a unique column", () => {
    renderPane();
    expect(capturedValidate).toBeDefined();
    const result = capturedValidate!("ticker", "EMEA", "namr");
    expect(result).toBeNull();
  });

  it("validate returns an error message for a duplicate value in a unique column", () => {
    renderPane();
    expect(capturedValidate).toBeDefined();
    // editing namr to "APAC" — already used by the apac row
    const result = capturedValidate!("ticker", "APAC", "namr");
    expect(result).toContain("Already used by");
  });

  it("onInvalidCommit routes to flash/notice when validate refuses a value", async () => {
    renderPane();
    expect(capturedOnInvalidCommit).toBeDefined();
    // Simulate DataGrid calling onInvalidCommit after validate refused the commit
    await act(async () => {
      capturedOnInvalidCommit!("namr", "ticker", "Already used by apac.");
    });
    // The notice should appear in the DOM
    expect(screen.getByText(/Already used by apac\./i)).toBeInTheDocument();
  });

  it("uniqueness is checked against the full list even when the duplicate row is filtered out of the visible grid", async () => {
    renderPane();
    expect(capturedValidate).toBeDefined();

    // Type into the search input so only "NAMR" is visible - this hides the
    // "apac" row from rowsForGrid, but validate must still catch the duplicate.
    const searchInput = screen.getByPlaceholderText("Search records…");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "NAMR" } });
    });

    // At this point the DataGrid only receives the "namr" row (apac is hidden).
    // Editing "namr" to "APAC" must still be refused because "APAC" is held
    // by a row currently outside the visible set.
    const result = capturedValidate!("ticker", "APAC", "namr");
    expect(result).toContain("Already used by");
  });
});
