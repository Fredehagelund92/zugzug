/**
 * Adding a record whose key is already taken.
 *
 * The server refuses with ALREADY_EXISTS instead of silently no-op'ing, so the
 * pane must say so plainly and must NOT push an undo entry — the undo inverse
 * retires the key, which would delete the record that already holds it.
 *
 * Mount pattern mirrors TablePane.validation.test.tsx, except useAddQueue is
 * left real (it is the thing under test) and useUndoStack's push is captured.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MappingRefTable, RecordValue } from "../data";

const addRecord = vi.hoisted(() => vi.fn());
const toastSpy = vi.hoisted(() => vi.fn());
const undoPush = vi.hoisted(() => vi.fn());

vi.mock("../store", async () => {
  class ApiCodeError extends Error {
    constructor(
      msg: string,
      public code: string,
    ) {
      super(msg);
    }
  }
  return {
    useSources: () => [],
    useRefTables: () => [],
    useDrafts: () => [],
    useDraftsByValue: () => ({}),
    useCanEdit: () => true,
    useCurrentUser: () => null,
    fetchPublishState: () => Promise.resolve(null),
    getGridLayout: () => Promise.resolve({}),
    getCachedGridLayout: () => ({}),
    setGridLayout: vi.fn(),
    slug: (s: string) => s,
    discardDraft: vi.fn(),
    addRecord,
    renameRecord: vi.fn(),
    getRecord: vi.fn(),
    importRows: vi.fn(),
    mergeRecord: vi.fn(),
    retireRecord: vi.fn(),
    fetchVariants: vi.fn(),
    deriveRecord: vi.fn(),
    addField: vi.fn(),
    setFieldValue: vi.fn(),
    validateFormula: vi.fn(),
    updateFieldFormula: vi.fn(),
    addColumnOption: vi.fn(),
    renameColumn: vi.fn(),
    changeColumnType: vi.fn(),
    deleteColumn: vi.fn(),
    updateFieldRules: vi.fn(),
    updateFieldValidation: vi.fn(),
    updateFieldDescription: vi.fn(),
    updateFieldDisplayFields: vi.fn(),
    insertRecordAt: vi.fn(),
    reorderRecord: vi.fn(),
    patchRefTable: vi.fn(),
    rebalancePositions: vi.fn(),
    refreshRefTableAndNotify: vi.fn(),
    commit: vi.fn(),
    revertChanges: vi.fn(),
    ConflictError: class extends Error {},
    ApiCodeError,
  };
});

vi.mock("../lib/use-presence", () => ({ usePresence: () => ({ peers: [] }) }));
vi.mock("../lib/use-row-activity", () => ({
  useRowActivity: () => ({ recentKeys: new Set() }),
}));
vi.mock("../lib/use-linked-candidates", () => ({ useLinkedCandidates: () => new Map() }));
vi.mock("../lib/open-tabs", () => ({ useOpenTabs: () => ({ openTab: vi.fn() }) }));
vi.mock("../lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ table: () => "/" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("./Toast", () => ({ toast: toastSpy }));
vi.mock("./datagrid", () => ({
  DataGrid: () => <div data-testid="grid" />,
  UndoStackProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUndoStack: () => ({ push: undoPush, undo: vi.fn(), canUndo: false }),
}));
vi.mock("./AddFieldPopover", () => ({ AddFieldPopover: () => null }));
vi.mock("./linked/ManageLinkedFieldsPopover", () => ({ ManageLinkedFieldsPopover: () => null }));
vi.mock("./OwnerPicker", () => ({ OwnerPicker: () => null }));
vi.mock("./PublishPreviewDialog", () => ({ PublishPreviewDialog: () => null }));
vi.mock("./VersionHistory", () => ({ VersionHistory: () => null }));
vi.mock("./ImportPreviewDialog", () => ({ ImportPreviewDialog: () => null }));
vi.mock("./RecordHistoryDrawer", () => ({ RecordHistoryDrawer: () => null }));
vi.mock("./ConflictBanner", () => ({ ConflictBanner: () => null }));
vi.mock("./RenameConfirmation", () => ({ RenameConfirmation: () => null }));
vi.mock("./modes/MapValuesBody", () => ({ MapValuesBody: () => null }));

import { TablePane } from "./TablePane";
import { ApiCodeError } from "../store";

const RECORDS: RecordValue[] = [{ key: "norway", label: "Norway", version: 3, fields: {} }];
const REF_TABLE: MappingRefTable = {
  id: "d1",
  refTable: "Country",
  dimTable: "zz.dim_country",
  mapTable: "zz.map_country",
  keyCol: "country_key",
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
  fields: [],
};

afterEach(() => {
  cleanup();
  addRecord.mockReset();
  toastSpy.mockReset();
  undoPush.mockReset();
});

async function typeAndAdd(label: string) {
  render(
    <MemoryRouter>
      <TablePane refTable={REF_TABLE} isActive mode="records" />
    </MemoryRouter>,
  );
  const input = screen.getByPlaceholderText("new country record…");
  await act(async () => {
    fireEvent.change(input, { target: { value: label } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add record/i }));
  });
}

describe("adding a record whose key is taken", () => {
  it("says the key is taken and pushes no undo entry", async () => {
    addRecord.mockRejectedValue(new ApiCodeError("already exists", "ALREADY_EXISTS"));
    await typeAndAdd("Norway");

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(toastSpy.mock.calls[0][0]).toMatch(
      /wasn't added — a record with this key already exists/i,
    );
    // Nothing to undo — a Cmd-Z inverse here would retire the existing record.
    expect(undoPush).not.toHaveBeenCalled();
  });

  it("still pushes an undo entry when the add succeeds", async () => {
    addRecord.mockResolvedValue(undefined);
    await typeAndAdd("Sweden");

    await waitFor(() => expect(undoPush).toHaveBeenCalled());
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
