/**
 * Wiring a column from the catalog must carry the database it was browsed in,
 * and the ✕ on a wired chip must actually unwire the column — it used to drop
 * local component state only, leaving the source registered and scanned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TableDetail } from "./TableDetail";
import type { MappingRefTable } from "../../data";

vi.mock("../../store", () => ({
  useCanEdit: () => true,
  deriveRecord: vi.fn(),
  removeSource: vi.fn(),
  fetchColumnValues: vi.fn(),
  fetchColumns: vi.fn(),
}));

const store = await import("../../store");
const deriveRecord = vi.mocked(store.deriveRecord);
const removeSource = vi.mocked(store.removeSource);
const fetchColumns = vi.mocked(store.fetchColumns);
const fetchColumnValues = vi.mocked(store.fetchColumnValues);

const refTables = [{ id: "t_region", refTable: "Region" } as unknown as MappingRefTable];

async function renderDetail() {
  render(
    <TableDetail
      database="db-2"
      tablePath="sales.orders"
      connectionLabel="🦆 MotherDuck"
      refTables={refTables}
    />,
  );
  await waitFor(() => expect(screen.getByText("region")).toBeInTheDocument());
}

async function wireRegion() {
  fireEvent.click(screen.getByRole("button", { name: /connect…/i }));
  fireEvent.click(screen.getByText("Region"));
  await waitFor(() => expect(deriveRecord).toHaveBeenCalled());
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  fetchColumns.mockResolvedValue([{ name: "region", type: "VARCHAR" }]);
  fetchColumnValues.mockResolvedValue([]);
  removeSource.mockResolvedValue(true);
  deriveRecord.mockResolvedValue({ derived: 3, mode: "seed", matched: 0, unmatched: 0 });
});

describe("TableDetail wiring", () => {
  it("registers the column against the database the tree browsed", async () => {
    await renderDetail();
    await wireRegion();
    expect(deriveRecord).toHaveBeenCalledWith("t_region", "sales.orders", "region", undefined, {
      databaseId: "db-2",
    });
  });

  it("the ✕ unwires the column for real, in that same database", async () => {
    await renderDetail();
    await wireRegion();
    fireEvent.click(await screen.findByLabelText(/disconnect this column/i));
    await waitFor(() =>
      expect(removeSource).toHaveBeenCalledWith("t_region", "sales.orders", "region", "db-2"),
    );
  });

  it("an unreachable table is not reported as an empty one", async () => {
    fetchColumns.mockRejectedValueOnce(new Error("connection refused"));
    render(
      <TableDetail
        database="db-2"
        tablePath="sales.orders"
        connectionLabel="🦆 MotherDuck"
        refTables={refTables}
      />,
    );
    await waitFor(() => expect(screen.getByText(/connection refused/)).toBeInTheDocument());
    expect(screen.queryByText("No columns.")).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
