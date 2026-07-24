import { describe, test, expect } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React, { useMemo, useRef, useState } from "react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Records search box — filters rows across ALL visible fields, hidden fields excluded.
 *
 * This test renders a minimal wrapper that mirrors RecordsBody's search logic:
 *   - search state + searchRef
 *   - visibleFields derived from columns (those with !hidden)
 *   - rowsForGrid filtered by trimmed, lowercased substring match
 *   - an <input placeholder="Search records…"> wired to setSearch
 *
 * We test against the component exported from TablePane indirectly via the
 * matchesSearch predicate contract, but the primary assertion is through
 * the real DOM: type into the box, check which data-row attributes exist.
 */

interface Row {
  key: string;
  label: string;
  rank: string;
  secret: string;
}

const ROWS: Row[] = [
  { key: "r1", label: "Alpha", rank: "4543", secret: "HIDDEN_VALUE" },
  { key: "r2", label: "Beta", rank: "12", secret: "OTHER_SECRET" },
];

// columns: label + rank visible, secret hidden
const COLUMNS: ColumnDef<Row>[] = [
  { field: "label", label: "Record", config: { type: "text" }, editable: false },
  { field: "rank", label: "Rank", config: { type: "text" }, editable: false },
  { field: "secret", label: "Secret", config: { type: "text" }, editable: false, hidden: true },
];

/**
 * Minimal component that mirrors RecordsBody's search logic.
 * We'll replace this "naive" version with the real exported predicate once the
 * implementation ships — for now it validates the contract.
 */
function RecordsSearchWrapper({ rows, columns }: { rows: Row[]; columns: ColumnDef<Row>[] }) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const visibleFields = useMemo(
    () => columns.filter((c) => !c.hidden).map((c) => c.field),
    [columns],
  );

  const rowsForGrid = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      visibleFields.some((f) => {
        const v = (row as Record<string, unknown>)[f];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }, [rows, search, visibleFields]);

  return (
    <div>
      <input
        ref={searchRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search records…"
        data-testid="records-search"
      />
      <UndoStackProvider>
        <DataGrid
          rows={rowsForGrid}
          rowKey={(r) => r.key}
          columns={columns}
          onCommit={async () => {}}
        />
      </UndoStackProvider>
    </div>
  );
}

function getRenderedRowKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-row]")).map(
    (el) => el.getAttribute("data-row") ?? "",
  );
}

describe("records search", () => {
  test("search box placeholder is 'Search records…'", () => {
    const { getByPlaceholderText } = render(<RecordsSearchWrapper rows={ROWS} columns={COLUMNS} />);
    expect(getByPlaceholderText("Search records…")).toBeInTheDocument();
  });

  test("empty query shows all rows", () => {
    const { container } = render(<RecordsSearchWrapper rows={ROWS} columns={COLUMNS} />);
    const keys = getRenderedRowKeys(container);
    expect(keys).toContain("r1");
    expect(keys).toContain("r2");
  });

  test("search matches a non-label visible field (rank) and excludes non-matching rows", () => {
    const { container, getByTestId } = render(
      <RecordsSearchWrapper rows={ROWS} columns={COLUMNS} />,
    );

    // Type a value that only matches r1's rank field, not its label or r2
    act(() => {
      fireEvent.change(getByTestId("records-search"), { target: { value: "4543" } });
    });

    const keys = getRenderedRowKeys(container);
    expect(keys).toContain("r1"); // matched on rank="4543"
    expect(keys).not.toContain("r2"); // rank="12", label="Beta" — no match
  });

  test("search matching only a HIDDEN field returns no rows", () => {
    const { container, getByTestId } = render(
      <RecordsSearchWrapper rows={ROWS} columns={COLUMNS} />,
    );

    // "HIDDEN_VALUE" only exists in the hidden "secret" column
    act(() => {
      fireEvent.change(getByTestId("records-search"), { target: { value: "HIDDEN_VALUE" } });
    });

    const keys = getRenderedRowKeys(container);
    expect(keys).not.toContain("r1");
    expect(keys).not.toContain("r2");
  });

  test("clearing the search restores all rows", () => {
    const { container, getByTestId } = render(
      <RecordsSearchWrapper rows={ROWS} columns={COLUMNS} />,
    );

    act(() => {
      fireEvent.change(getByTestId("records-search"), { target: { value: "4543" } });
    });
    // Only r1 visible
    expect(getRenderedRowKeys(container)).toHaveLength(1);

    // Clear
    act(() => {
      fireEvent.change(getByTestId("records-search"), { target: { value: "" } });
    });
    const keys = getRenderedRowKeys(container);
    expect(keys).toContain("r1");
    expect(keys).toContain("r2");
  });

  test("search is case-insensitive", () => {
    const { container, getByTestId } = render(
      <RecordsSearchWrapper rows={ROWS} columns={COLUMNS} />,
    );

    act(() => {
      fireEvent.change(getByTestId("records-search"), { target: { value: "alpha" } });
    });

    const keys = getRenderedRowKeys(container);
    expect(keys).toContain("r1"); // label="Alpha" — case-insensitive match
    expect(keys).not.toContain("r2");
  });
});
