import { test, expect, vi, afterEach } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";
import { ManageLinkedFieldsPopover } from "../src/components/linked/ManageLinkedFieldsPopover";

// The popover portals to document.body (same pattern as AddFieldPopover), so
// the testing-library `container` won't contain its DOM. Query through
// `document.querySelector` / `screen.*` instead. afterEach(cleanup) prevents
// portaled nodes from leaking across tests.
afterEach(() => {
  cleanup();
});

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
  render(<ManageLinkedFieldsPopover {...baseProps} />);
  const labelRow = document.querySelector('[data-field="label"] input') as HTMLInputElement;
  expect(labelRow.checked).toBe(true);
  expect(labelRow.disabled).toBe(true);
  const isoRow = document.querySelector('[data-field="iso_code"] input') as HTMLInputElement;
  expect(isoRow.checked).toBe(true);
  expect(isoRow.disabled).toBe(false);
  const continentRow = document.querySelector('[data-field="continent"] input') as HTMLInputElement;
  expect(continentRow.checked).toBe(false);
  expect(continentRow.disabled).toBe(true);
});

test("search filters by label (case-insensitive)", () => {
  render(<ManageLinkedFieldsPopover {...baseProps} />);
  const search = document.querySelector('input[type="search"]') as HTMLInputElement;
  act(() => {
    fireEvent.input(search, { target: { value: "iso" } });
  });
  expect(document.querySelector('[data-field="iso_code"]')).not.toBeNull();
  expect(document.querySelector('[data-field="region"]')).toBeNull();
  expect(document.querySelector('[data-field="label"]')).not.toBeNull(); // always shown
});

test("Apply calls onApply with new array; Cancel calls onCancel", () => {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(<ManageLinkedFieldsPopover {...baseProps} onApply={onApply} onCancel={onCancel} />);
  const regionRow = document.querySelector('[data-field="region"] input') as HTMLInputElement;
  act(() => {
    fireEvent.click(regionRow);
  });
  act(() => {
    fireEvent.click(screen.getByText("Apply"));
  });
  expect(onApply).toHaveBeenCalledWith(["label", "iso_code", "region"]);
  act(() => {
    fireEvent.click(screen.getByText("Cancel"));
  });
  expect(onCancel).toHaveBeenCalled();
});

test("unchecking iso_code removes it from the applied array but keeps label", () => {
  const onApply = vi.fn();
  render(<ManageLinkedFieldsPopover {...baseProps} onApply={onApply} />);
  const isoRow = document.querySelector('[data-field="iso_code"] input') as HTMLInputElement;
  act(() => {
    fireEvent.click(isoRow);
  });
  act(() => {
    fireEvent.click(screen.getByText("Apply"));
  });
  expect(onApply).toHaveBeenCalledWith(["label"]);
});
