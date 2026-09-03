/**
 * TablePane failure surfaces — every one of these used to be a swallowed
 * rejection: a column rename that silently didn't stick, a delete that looked
 * as if it took, a rebalance that failed on a 429, a "don't publish this
 * draft" ✕ that did nothing. The user must be told.
 *
 * Also covers the undo entry pushed by a record removal, whose inverse has to
 * restore the record's stored cells (and only those — not computed columns).
 *
 * Strategy: mirror the mount pattern from TablePane.validation.test.tsx —
 * stub the heavy DataGrid but expose its callbacks, and leave the dialogs
 * real so the confirm → failure → notice path is exercised end to end.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MappingRefTable, RecordValue } from "../data";
import type { UndoEntry } from "./datagrid/UndoStack";

// ── Store mock ────────────────────────────────────────────────────────────────
const {
  renameColumn,
  deleteColumn,
  rebalancePositions,
  discardDraft,
  retireRecord,
  addRecord,
  setFieldValue,
  toast,
} = vi.hoisted(() => ({
  renameColumn: vi.fn(),
  deleteColumn: vi.fn(),
  rebalancePositions: vi.fn(),
  discardDraft: vi.fn(),
  retireRecord: vi.fn(),
  addRecord: vi.fn(),
  setFieldValue: vi.fn(),
  toast: vi.fn(),
}));

const DRAFT = {
  refTableId: "d1",
  raw: "n. america",
  status: "mapped" as const,
  targetLabel: "NAMR",
  targetKey: "namr",
  user: { id: "u1", name: "Ada", initials: "A" },
  at: "2m ago",
  createdAt: "2026-01-01T00:00:00Z",
  source: "user" as const,
  confidence: null,
  reasoning: null,
  rejectedReason: null,
  rejectedBy: null,
};

vi.mock("../store", () => ({
  useSources: () => [],
  useRefTables: () => [],
  useDrafts: () => [],
  useDraftsByValue: () => ({ "d1::n. america": DRAFT }),
  useCanEdit: () => true,
  useCurrentUser: () => ({ id: "u1", name: "Ada", email: "ada@example.com", role: "admin" }),
  fetchPublishState: () =>
    Promise.resolve({
      version: 3,
      publishedAt: null,
      publishedByName: null,
      pendingDrafts: 1,
      changedKeys: [],
      canRevert: false,
    }),
  getGridLayout: () => Promise.resolve({}),
  getCachedGridLayout: () => ({}),
  setGridLayout: vi.fn(),
  slug: (s: string) => s,
  discardDraft,
  addRecord,
  renameRecord: vi.fn(),
  getRecord: vi.fn(() => ({ version: 1 })),
  importRows: vi.fn(),
  mergeRecord: vi.fn(),
  retireRecord,
  fetchVariants: vi.fn(),
  deriveRecord: vi.fn(),
  addField: vi.fn(),
  setFieldValue,
  validateFormula: vi.fn(),
  updateFieldFormula: vi.fn(),
  addColumnOption: vi.fn(),
  renameColumn,
  changeColumnType: vi.fn(),
  deleteColumn,
  updateFieldRules: vi.fn(),
  updateFieldValidation: vi.fn(),
  updateFieldDescription: vi.fn(),
  updateFieldDisplayFields: vi.fn(),
  insertRecordAt: vi.fn(),
  reorderRecord: vi.fn(),
  patchRefTable: vi.fn(),
  rebalancePositions,
  refreshRefTableAndNotify: vi.fn(),
  commit: vi.fn(),
  revertChanges: vi.fn(),
  ConflictError: class extends Error {},
  ApiCodeError: class extends Error {},
}));

vi.mock("../api", () => ({ apiFetch: vi.fn(() => Promise.resolve({ ok: false })) }));

// ── Library hook stubs ────────────────────────────────────────────────────────
vi.mock("../lib/use-presence", () => ({ usePresence: () => ({ peers: [] }) }));
vi.mock("../lib/use-row-activity", () => ({ useRowActivity: () => ({ recentKeys: new Set() }) }));
vi.mock("../lib/use-linked-candidates", () => ({ useLinkedCandidates: () => new Map() }));
vi.mock("../lib/open-tabs", () => ({ useOpenTabs: () => ({ openTab: vi.fn() }) }));
vi.mock("../lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ table: () => "/" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("./Toast", () => ({ toast }));

// ── DataGrid stub — captures the column/row callbacks under test ──────────────
let onRenameColumn: ((field: string, label: string) => void) | undefined;
let onDeleteColumn: ((field: string) => void) | undefined;
let onDeleteRow: ((key: string) => void) | undefined;
const { pushed } = vi.hoisted(() => ({ pushed: [] as import("./datagrid/UndoStack").UndoEntry[] }));

vi.mock("./datagrid", () => ({
  DataGrid: (p: {
    rows: RecordValue[];
    onRenameColumn?: (field: string, label: string) => void;
    onDeleteColumn?: (field: string) => void;
    onDeleteRow?: (key: string) => void;
  }) => {
    onRenameColumn = p.onRenameColumn;
    onDeleteColumn = p.onDeleteColumn;
    onDeleteRow = p.onDeleteRow;
    return <div data-testid="grid">{p.rows.length}</div>;
  },
  UndoStackProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUndoStack: () => ({
    push: (e: UndoEntry) => pushed.push(e),
    undo: vi.fn(),
    canUndo: false,
  }),
}));

// ── Heavyweight child stubs (dialogs stay real — they are the surface) ────────
vi.mock("./AddFieldPopover", () => ({ AddFieldPopover: () => null }));
vi.mock("./linked/ManageLinkedFieldsPopover", () => ({ ManageLinkedFieldsPopover: () => null }));
vi.mock("./OwnerPicker", () => ({ OwnerPicker: () => null }));
vi.mock("./VersionHistory", () => ({ VersionHistory: () => null }));
vi.mock("./ImportPreviewDialog", () => ({ ImportPreviewDialog: () => null }));
vi.mock("./RecordHistoryDrawer", () => ({ RecordHistoryDrawer: () => null }));
vi.mock("./ConflictBanner", () => ({ ConflictBanner: () => null }));
vi.mock("./RenameConfirmation", () => ({ RenameConfirmation: () => null }));
vi.mock("./modes/MapValuesBody", () => ({ MapValuesBody: () => null }));
vi.mock("../hooks/use-add-queue", () => ({ useAddQueue: () => ({ queue: [], flush: vi.fn() }) }));

import { TablePane } from "./TablePane";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pushed.length = 0;
  onRenameColumn = onDeleteColumn = onDeleteRow = undefined;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
const RECORDS: RecordValue[] = [
  {
    key: "namr",
    label: "NAMR",
    version: 1,
    fields: { ticker: "NAMR", headcount: "12", rank: "1" },
  },
];

const REF_TABLE: MappingRefTable = {
  id: "d1",
  refTable: "Region",
  dimTable: "zz.dim_region",
  mapTable: "zz.map_region",
  keyCol: "region_key",
  rows: 1,
  record: RECORDS,
  counts: {
    newCount: 0,
    mappedCount: 1,
    totalDistinct: 1,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 1,
    scannedAt: null,
  },
  fields: [
    { field: "ticker", label: "Ticker", type: "text" },
    { field: "headcount", label: "Headcount", type: "number" },
    { field: "rank", label: "Rank", type: "formula", formula: { expr: "1", resultType: "number" } },
    {
      field: "owner",
      label: "Owner",
      type: "linked",
      referencedRefTableId: "d2",
      displayFields: ["label", "email"],
    },
  ],
};

function renderPane(overrides: Partial<MappingRefTable> = {}) {
  return render(
    <MemoryRouter>
      <TablePane refTable={{ ...REF_TABLE, ...overrides }} isActive mode="records" />
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("TablePane surfaces failed column edits", () => {
  it("toasts when a column rename is refused", async () => {
    renderPane();
    renameColumn.mockRejectedValue(new Error("editor required"));
    await act(async () => {
      onRenameColumn!("ticker", "Symbol");
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't rename: editor required", "error"),
    );
  });

  it("toasts when deleting a plain column fails", async () => {
    renderPane();
    deleteColumn.mockRejectedValue(new Error("column is in use"));
    await act(async () => {
      onDeleteColumn!("headcount");
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't delete: column is in use", "error"),
    );
  });

  it("asks before deleting a linked column and shows the failure in the pane", async () => {
    renderPane();
    deleteColumn.mockRejectedValue(new Error("referenced elsewhere"));
    await act(async () => {
      onDeleteColumn!("owner");
    });
    // The linked column carries one lookup column (displayFields minus "label").
    expect(screen.getByRole("dialog").textContent).toContain("1 linked column");
    expect(deleteColumn).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(deleteColumn).toHaveBeenCalledWith("d1", "owner");
    expect(await screen.findByText("referenced elsewhere")).toBeInTheDocument();
  });
});

describe("TablePane surfaces a failed rebalance", () => {
  it("shows the server's reason when rebalancing is refused", async () => {
    renderPane({ orderingMode: "manual" });
    rebalancePositions.mockRejectedValue(new Error("Too many rebalances — try again in a minute."));
    fireEvent.click(screen.getByTitle("Sort & order rows"));
    fireEvent.click(screen.getByRole("button", { name: "Rebalance positions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rebalance" }));
    });
    expect(
      await screen.findByText("Too many rebalances — try again in a minute."),
    ).toBeInTheDocument();
  });
});

describe("TablePane publish preview", () => {
  it("toasts when dropping a draft from the publish set fails", async () => {
    renderPane();
    discardDraft.mockRejectedValue(new Error("already published"));
    const publish = await screen.findByTestId("publish-button");
    fireEvent.click(publish);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Don't publish mapping for n. america" }));
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("already published", "error"));
  });
});

describe("TablePane record removal", () => {
  it("pushes an undo whose inverse restores the stored cells but not computed ones", async () => {
    retireRecord.mockResolvedValue({ ok: true });
    renderPane();
    await act(async () => {
      onDeleteRow!("namr");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(retireRecord).toHaveBeenCalledWith("d1", "namr", 1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.label).toBe('remove "NAMR"');

    await act(async () => {
      await pushed[0]!.inverse();
    });
    expect(addRecord).toHaveBeenCalledWith("d1", "NAMR", "namr");
    expect(setFieldValue).toHaveBeenCalledWith("d1", "namr", "ticker", "NAMR");
    expect(setFieldValue).toHaveBeenCalledWith("d1", "namr", "headcount", "12");
    // "rank" is a formula column — the server computes it, so undo must not
    // try to write it back.
    expect(setFieldValue).not.toHaveBeenCalledWith("d1", "namr", "rank", "1");
  });

  it("explains why a record still mapped to source values can't be removed", async () => {
    retireRecord.mockResolvedValue({ ok: false, variants: 3 });
    renderPane();
    await act(async () => {
      onDeleteRow!("namr");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(await screen.findByText(/3 source values still map here/)).toBeInTheDocument();
    expect(pushed).toHaveLength(0);
  });

  it("shows the reason when the remove request itself fails", async () => {
    retireRecord.mockRejectedValue(new Error("network error"));
    renderPane();
    await act(async () => {
      onDeleteRow!("namr");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(await screen.findByText("Remove failed — network error")).toBeInTheDocument();
  });
});

/* A rejection that isn't an Error (a bare string from a stray throw, a
 * DOMException) must still produce a readable message rather than "undefined"
 * or a blank bar. */
describe("TablePane falls back to a readable message for a non-Error failure", () => {
  it("on rename", async () => {
    renderPane();
    renameColumn.mockRejectedValue("boom");
    await act(async () => {
      onRenameColumn!("ticker", "Symbol");
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't rename.", "error"));
  });

  it("on column delete", async () => {
    renderPane();
    deleteColumn.mockRejectedValue("boom");
    await act(async () => {
      onDeleteColumn!("headcount");
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't delete.", "error"));
  });

  it("on rebalance", async () => {
    renderPane({ orderingMode: "manual" });
    rebalancePositions.mockRejectedValue("boom");
    fireEvent.click(screen.getByTitle("Sort & order rows"));
    fireEvent.click(screen.getByRole("button", { name: "Rebalance positions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rebalance" }));
    });
    expect(await screen.findByText("Couldn't rebalance — please try again.")).toBeInTheDocument();
  });

  it("on dropping a draft from the publish set", async () => {
    renderPane();
    discardDraft.mockRejectedValue("boom");
    fireEvent.click(await screen.findByTestId("publish-button"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Don't publish mapping for n. america" }));
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't discard that draft.", "error"),
    );
  });
});
