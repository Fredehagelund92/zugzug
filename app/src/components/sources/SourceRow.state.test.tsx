/**
 * A scan that failed (timeout, warehouse blip, auth) is not evidence the column
 * is gone. It used to render as "⚠ column not found" — the same red verdict a
 * genuinely vanished column gets.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SourceRow } from "./SourceRow";
import type { SourceInfo } from "../../store";

const base: SourceInfo = {
  databaseId: "db-1",
  databaseName: "analytics",
  refTableId: "t1",
  refTable: "Region",
  table: "sales.orders",
  column: "region",
  scanned: true,
  present: true,
  scanError: null,
  scannedAt: "2026-07-17T10:00:00Z",
  unmapped: 0,
  values: 3,
  rows: 100,
};

function renderRow(over: Partial<SourceInfo>, props: { showDatabase?: boolean } = {}) {
  cleanup();
  render(
    <MemoryRouter>
      <SourceRow
        row={{ ...base, ...over }}
        mapValuesHref="/map"
        onDerive={vi.fn()}
        onRemove={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("SourceRow connection state", () => {
  it("a failed scan reads as a retryable failure, not a missing column", () => {
    renderRow({ present: false, scanError: "scan timed out" });
    expect(screen.getByText(/scan failed — will retry/i)).toBeInTheDocument();
    expect(screen.queryByText(/column not found/i)).toBeNull();
    expect(screen.getByTitle("scan timed out")).toBeInTheDocument();
  });

  it("a column the warehouse answered about, and doesn't have, is still 'not found'", () => {
    renderRow({ present: false, scanError: null });
    expect(screen.getByText(/column not found/i)).toBeInTheDocument();
  });

  it("names the database only when the workspace reads from more than one", () => {
    renderRow({}, { showDatabase: true });
    expect(screen.getByText("analytics.")).toBeInTheDocument();
    renderRow({});
    expect(screen.queryByText("analytics.")).toBeNull();
  });
});
