import { describe, it, expect } from "vitest";
import { renderGrid } from "./test-kit/render-grid";
import type { ColumnDef } from "./types";
import type { Row } from "./test-kit/fixtures";

function makeRequiredColumn(): ColumnDef<Row> {
  return {
    field: "name",
    label: "Manager",
    config: { type: "text", required: true },
    editable: true,
  };
}

describe("validation rendering", () => {
  it("shows a REQ badge on a required column header", () => {
    const columns: ColumnDef<Row>[] = [makeRequiredColumn()];
    const rows: Row[] = [{ id: "r0", name: "", count: 0, active: false, region: "" }];
    const { container } = renderGrid({ columns, rows });

    const header = container.querySelector('[role="columnheader"]');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain("REQ");
  });

  it("renders 'Needs a value' in an empty required cell", () => {
    const columns: ColumnDef<Row>[] = [makeRequiredColumn()];
    const rows: Row[] = [{ id: "r0", name: "", count: 0, active: false, region: "" }];
    const { container } = renderGrid({ columns, rows });

    const cell = container.querySelector('[data-cell="r0::name"]');
    expect(cell).not.toBeNull();
    expect(cell!.textContent).toContain("Needs a value");
  });
});
