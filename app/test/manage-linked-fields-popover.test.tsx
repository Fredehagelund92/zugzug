import { test, expect, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { ManageLinkedFieldsPopover } from "../src/components/linked/ManageLinkedFieldsPopover";

const targetFields = [
  { field: "label", label: "Label", type: "text" as const },
  { field: "iso_code", label: "ISO Code", type: "text" as const },
  { field: "region", label: "Region", type: "text" as const },
  { field: "continent", label: "Continent", type: "linked" as const },
];

const baseProps = {
  fkLabel: "Country",
  targetFields,
  current: ["label", "iso_code"],
  anchorRect: new DOMRect(0, 0, 100, 30),
  onCancel: vi.fn(),
  onApply: vi.fn(),
};

test("renders all target fields with label checked + disabled", () => {
  const { container } = render(<ManageLinkedFieldsPopover {...baseProps} />);
  const labelRow = container.querySelector('[data-field="label"] input') as HTMLInputElement;
  expect(labelRow.checked).toBe(true);
  expect(labelRow.disabled).toBe(true);
  const isoRow = container.querySelector('[data-field="iso_code"] input') as HTMLInputElement;
  expect(isoRow.checked).toBe(true);
  expect(isoRow.disabled).toBe(false);
  const continentRow = container.querySelector('[data-field="continent"] input') as HTMLInputElement;
  expect(continentRow.checked).toBe(false);
  expect(continentRow.disabled).toBe(true);
});

test("search filters by label (case-insensitive)", () => {
  const { container } = render(<ManageLinkedFieldsPopover {...baseProps} />);
  const search = container.querySelector('input[type="search"]') as HTMLInputElement;
  act(() => {
    fireEvent.input(search, { target: { value: "iso" } });
  });
  expect(container.querySelector('[data-field="iso_code"]')).not.toBeNull();
  expect(container.querySelector('[data-field="region"]')).toBeNull();
  expect(container.querySelector('[data-field="label"]')).not.toBeNull(); // always shown
});

test("Apply calls onApply with new array; Cancel calls onCancel", () => {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  const { container, getByText } = render(
    <ManageLinkedFieldsPopover {...baseProps} onApply={onApply} onCancel={onCancel} />,
  );
  const regionRow = container.querySelector('[data-field="region"] input') as HTMLInputElement;
  act(() => {
    fireEvent.click(regionRow);
  });
  act(() => {
    fireEvent.click(getByText("Apply"));
  });
  expect(onApply).toHaveBeenCalledWith(["label", "iso_code", "region"]);
  act(() => {
    fireEvent.click(getByText("Cancel"));
  });
  expect(onCancel).toHaveBeenCalled();
});

test("unchecking iso_code removes it from the applied array but keeps label", () => {
  const onApply = vi.fn();
  const { container, getByText } = render(
    <ManageLinkedFieldsPopover {...baseProps} onApply={onApply} />,
  );
  const isoRow = container.querySelector('[data-field="iso_code"] input') as HTMLInputElement;
  act(() => {
    fireEvent.click(isoRow);
  });
  act(() => {
    fireEvent.click(getByText("Apply"));
  });
  expect(onApply).toHaveBeenCalledWith(["label"]);
});
