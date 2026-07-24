import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SourceRow } from "../src/components/sources/SourceRow";
import type { SourceInfo } from "../src/store";

const base: SourceInfo = {
  table: "authco.users",
  column: "plan_type",
  refTable: "Plan",
  refTableId: "refTable-1",
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
        mapValuesHref="/app/default/tables?open=refTable-1&active=refTable-1&mode=match"
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
    const { container } = renderRow({ present: false });
    // All three parts (schema., table, .column) must appear in the rendered output.
    expect(container.textContent).toContain("authco.users.plan_type");
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/column not found/i)).toBeInTheDocument();
  });

  it("shows 'never scanned' when not yet scanned", () => {
    renderRow({ scanned: false, scannedAt: null });
    expect(screen.getByText(/never scanned/i)).toBeInTheDocument();
  });

  it("Remove source in the menu calls onRemove and closes menu", () => {
    const onRemove = vi.fn();
    renderRow({}, { onRemove });
    fireEvent.click(screen.getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/remove source/i));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/remove source/i)).toBeNull();
  });

  it("disables Re-scan and Remove source when canEdit is false", () => {
    const { container: _c } = render(
      <MemoryRouter>
        <SourceRow
          row={{ ...base }}
          mapValuesHref="/app/default/tables?open=refTable-1&active=refTable-1&mode=match"
          canEdit={false}
          onDerive={vi.fn()}
          onRemove={vi.fn()}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText(/more actions/i));
    const rescan = screen.getByText(/re-scan/i).closest("button");
    const remove = screen.getByText(/remove source/i).closest("button");
    expect(rescan).toBeDisabled();
    expect(remove).toBeDisabled();
  });

  it("links Open in Map values to mapValuesHref", () => {
    renderRow({});
    fireEvent.click(screen.getByLabelText(/more actions/i));
    const link = screen.getByText(/open in map values/i).closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("mode=match"));
  });
});
