import { describe, test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DatabaseTable, type DatabaseRow } from "../src/components/warehouse/DatabaseTable";

const ROWS: DatabaseRow[] = [
  {
    id: "wd_1",
    databaseName: "analytics",
    label: "Sales DWH",
    sourceCount: 3,
    schemaCount: 3,
    addedAt: "2026-03-14T00:00:00Z",
    lastProbeAt: null,
    lastProbeError: null,
  },
  {
    id: "wd_2",
    databaseName: "hr",
    label: null,
    sourceCount: 0,
    schemaCount: null,
    addedAt: "2026-03-14T00:00:00Z",
    lastProbeAt: null,
    lastProbeError: "Catalog not found",
  },
];

describe("DatabaseTable", () => {
  test("renders one row per database with schemaCount", () => {
    const { container } = render(
      <DatabaseTable databases={ROWS} canAdd={true} onAdd={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(container.textContent).toContain("analytics");
    expect(container.textContent).toContain("Sales DWH");
    expect(container.textContent).toContain("3 schemas");
  });

  test("'unreachable' pill on rows with lastProbeError", () => {
    const { container } = render(
      <DatabaseTable databases={ROWS} canAdd={true} onAdd={vi.fn()} onRemove={vi.fn()} />,
    );
    const row = container.querySelector('[data-row="wd_2"]')!;
    expect(row.textContent).toContain("unreachable");
  });

  test("clicking + Add database fires onAdd", () => {
    const onAdd = vi.fn();
    const { getByText } = render(
      <DatabaseTable databases={ROWS} canAdd={true} onAdd={onAdd} onRemove={vi.fn()} />,
    );
    fireEvent.click(getByText("+ Add database"));
    expect(onAdd).toHaveBeenCalled();
  });

  test("empty state when no rows", () => {
    const { container } = render(
      <DatabaseTable databases={[]} canAdd={true} onAdd={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(container.textContent).toContain("No databases registered yet");
  });

  test("hides + Add when canAdd=false", () => {
    const { queryByText } = render(
      <DatabaseTable databases={ROWS} canAdd={false} onAdd={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(queryByText("+ Add database")).toBeNull();
  });
});
