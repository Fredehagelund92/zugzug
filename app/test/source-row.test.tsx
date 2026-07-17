import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SourceRow } from "../src/components/sources/SourceRow";
import type { SourceInfo } from "../src/store";

const base: SourceInfo = {
  table: "authco.users",
  column: "plan_type",
  dimension: "Plan",
  dimId: "dim-1",
  present: true,
  rows: 1000,
  values: 10,
  unmapped: 2,
  scanned: true,
  scannedAt: "2026-07-17T10:00:00Z",
};

function renderRow(over: Partial<SourceInfo>, handlers = {}) {
  return render(
    <MemoryRouter>
      <SourceRow
        row={{ ...base, ...over }}
        mapValuesHref="/app/default/tables?open=dim-1&active=dim-1&mode=match"
        canEdit
        onDerive={vi.fn()}
        onRemove={vi.fn()}
        {...handlers}
      />
    </MemoryRouter>,
  );
}

describe("SourceRow", () => {
  it("shows column, target, and 'column not found' when scanned & absent", () => {
    renderRow({ present: false });
    expect(screen.getByText(/authco\.users\.plan_type|plan_type/)).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/column not found/i)).toBeInTheDocument();
  });

  it("shows 'never scanned' when not yet scanned", () => {
    renderRow({ scanned: false, scannedAt: null });
    expect(screen.getByText(/never scanned/i)).toBeInTheDocument();
  });

  it("Remove source in the menu calls onRemove", () => {
    const onRemove = vi.fn();
    renderRow({}, { onRemove });
    fireEvent.click(screen.getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/remove source/i));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("links Open in Map values to mapValuesHref", () => {
    renderRow({});
    fireEvent.click(screen.getByLabelText(/more actions/i));
    const link = screen.getByText(/open in map values/i).closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("mode=match"));
  });
});
