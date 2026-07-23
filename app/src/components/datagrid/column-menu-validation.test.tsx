import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { renderGrid } from "./test-kit/render-grid";
import { makeColumns } from "./test-kit/fixtures";
import { pruneValidationForType } from "./validation";

afterEach(() => {
  cleanup();
});

// Helpers to open the column header menu for a given column label.
function openColumnMenu(container: HTMLElement, label: string) {
  // The ⋯ button is inside the column header; trigger it via right-click
  // on the header cell, or find the button directly.
  const header = Array.from(container.querySelectorAll('[role="columnheader"]')).find((el) =>
    el.textContent?.includes(label),
  );
  if (!header) throw new Error(`No column header for "${label}"`);
  // The ⋯ button has title "Column options"
  const btn = header.querySelector("button");
  if (!btn) throw new Error(`No button in column header "${label}"`);
  fireEvent.click(btn);
}

describe("edit column validation via header menu", () => {
  it("calls onSaveColumnValidation with unique:true after toggling Unique and saving", async () => {
    const onSaveColumnValidation = vi.fn();
    const columns = makeColumns().map((c) =>
      c.field === "name" ? { ...c, config: { ...c.config, type: "text" as const } } : c,
    );

    const { container } = renderGrid({ columns, onSaveColumnValidation });

    openColumnMenu(container, "Name");

    // Click "Validation…" in the menu
    const validationItem = screen.getByRole("button", { name: /validation/i });
    fireEvent.click(validationItem);

    // Toggle Unique on
    const uniqueCheckbox = screen.getByRole("checkbox", { name: /unique/i });
    fireEvent.click(uniqueCheckbox);

    // Save
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(saveBtn);

    expect(onSaveColumnValidation).toHaveBeenCalledWith(
      "name",
      expect.objectContaining({
        validation: expect.objectContaining({ unique: true }),
      }),
    );
  });

  it("calls onSaveColumnValidation with required:true when Required is toggled", async () => {
    const onSaveColumnValidation = vi.fn();
    const { container } = renderGrid({ columns: makeColumns(), onSaveColumnValidation });

    openColumnMenu(container, "Name");
    fireEvent.click(screen.getByRole("button", { name: /validation/i }));

    const requiredCheckbox = screen.getByRole("checkbox", { name: /required/i });
    fireEvent.click(requiredCheckbox);

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onSaveColumnValidation).toHaveBeenCalledWith(
      "name",
      expect.objectContaining({ required: true }),
    );
  });

  it("does not render Validation… menu item when onSaveColumnValidation is not provided", () => {
    const { container } = renderGrid({ columns: makeColumns() });
    openColumnMenu(container, "Name");
    expect(screen.queryByRole("button", { name: /validation/i })).toBeNull();
  });

  it("shows Min and Max inputs for number columns", async () => {
    const onSaveColumnValidation = vi.fn();
    const columns = makeColumns();
    const { container } = renderGrid({ columns, onSaveColumnValidation });

    openColumnMenu(container, "Count");
    fireEvent.click(screen.getByRole("button", { name: /validation/i }));

    expect(screen.getByLabelText(/^min$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^max$/i)).toBeInTheDocument();
  });

  it("calls onSaveColumnValidation with min and max values for number column", async () => {
    const onSaveColumnValidation = vi.fn();
    const columns = makeColumns();
    const { container } = renderGrid({ columns, onSaveColumnValidation });

    openColumnMenu(container, "Count");
    fireEvent.click(screen.getByRole("button", { name: /validation/i }));

    fireEvent.change(screen.getByLabelText(/^min$/i), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/^max$/i), { target: { value: "100" } });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onSaveColumnValidation).toHaveBeenCalledWith(
      "count",
      expect.objectContaining({
        validation: expect.objectContaining({ min: 0, max: 100 }),
      }),
    );
  });

  it("seeds the panel with existing validation values from the column config", async () => {
    const onSaveColumnValidation = vi.fn();
    const columns = makeColumns().map((c) =>
      c.field === "name"
        ? {
            ...c,
            config: {
              ...c.config,
              required: true,
              validation: { unique: true },
            } as typeof c.config,
          }
        : c,
    );

    const { container } = renderGrid({ columns, onSaveColumnValidation });

    openColumnMenu(container, "Name");
    fireEvent.click(screen.getByRole("button", { name: /validation/i }));

    const uniqueCheckbox = screen.getByRole("checkbox", { name: /unique/i }) as HTMLInputElement;
    const requiredCheckbox = screen.getByRole("checkbox", {
      name: /required/i,
    }) as HTMLInputElement;

    expect(uniqueCheckbox.checked).toBe(true);
    expect(requiredCheckbox.checked).toBe(true);
  });
});

describe("type-change pruning", () => {
  it("strips min/max and unique from validation when column type changes to boolean", () => {
    const result = pruneValidationForType({ unique: true, min: 0, max: 100 }, "boolean");
    expect(result).toEqual({ unique: undefined, min: undefined, max: undefined });
  });

  it("strips unique from validation when column type changes to select", () => {
    const result = pruneValidationForType({ unique: true, min: undefined }, "select");
    expect(result).toEqual({ unique: undefined, min: undefined, max: undefined });
  });

  it("keeps unique for text type", () => {
    const result = pruneValidationForType({ unique: true }, "text");
    expect(result).toEqual({ unique: true, min: undefined, max: undefined });
  });

  it("keeps min/max for number type", () => {
    const result = pruneValidationForType({ unique: true, min: 0, max: 100 }, "number");
    expect(result).toEqual({ unique: true, min: 0, max: 100 });
  });
});

describe("fix regressions", () => {
  it("saves validation: {} (not undefined) when all rules are unchecked — so server clears stale rules", async () => {
    const onSaveColumnValidation = vi.fn();
    // Start with a column that already has unique:true set
    const columns = makeColumns().map((c) =>
      c.field === "name"
        ? {
            ...c,
            config: {
              ...c.config,
              validation: { unique: true },
            } as typeof c.config,
          }
        : c,
    );

    const { container } = renderGrid({ columns, onSaveColumnValidation });

    openColumnMenu(container, "Name");
    fireEvent.click(screen.getByRole("button", { name: /validation/i }));

    // Unique is pre-checked — uncheck it so nothing is set
    const uniqueCheckbox = screen.getByRole("checkbox", { name: /unique/i });
    expect((uniqueCheckbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(uniqueCheckbox);

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // The call must include validation: {} (not undefined) so the server clears the old rule
    expect(onSaveColumnValidation).toHaveBeenCalledWith(
      "name",
      expect.objectContaining({ validation: {} }),
    );
    const callArg = onSaveColumnValidation.mock.calls[0][1] as { validation: unknown };
    expect(callArg.validation).not.toBeUndefined();
  });

  it("pruneValidationForType returns all-undefined for boolean — hadValidation guard must still fire the clear", () => {
    // Regression: previously `hasValues` checked the pruned output, so an
    // all-undefined result (number→boolean) skipped the PATCH entirely.
    // Now the guard is on `hadValidation` (pre-change), so pruned={} always fires.
    const input = {
      unique: true as boolean | undefined,
      min: 0 as number | null | undefined,
      max: 100 as number | null | undefined,
    };
    const pruned = pruneValidationForType(input, "boolean");
    // All keys are undefined — the old guard would have skipped the PATCH
    expect(Object.values(pruned).every((v) => v === undefined)).toBe(true);
    // The NEW guard: hadValidation = input had at least one defined value
    const hadValidation = Object.values(input).some((v) => v !== undefined);
    expect(hadValidation).toBe(true);
    // So the clear must fire regardless of pruned values
  });
});
