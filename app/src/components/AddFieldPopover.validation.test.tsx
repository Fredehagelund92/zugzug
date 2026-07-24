import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AddFieldPopover } from "./AddFieldPopover";

let anchor: HTMLButtonElement | null = null;
afterEach(() => {
  cleanup();
  anchor?.remove();
  anchor = null;
});

function makeAnchor() {
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
  return anchor;
}

describe("AddFieldPopover validation", () => {
  it("includes unique + min in the submitted field for a number type", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={onSubmit}
        allDims={[]}
      />,
    );

    // Set the field name
    fireEvent.change(screen.getByPlaceholderText(/field name/i), {
      target: { value: "Population" },
    });

    // Switch to number type
    fireEvent.click(screen.getByText("Number"));

    // Toggle Unique on
    fireEvent.click(screen.getByLabelText(/unique/i));

    // Set Min = 0
    fireEvent.change(screen.getByLabelText(/^min$/i), { target: { value: "0" } });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /add field/i }));

    const call = onSubmit.mock.calls[0][0] as { label: string; config: Record<string, unknown> };
    expect(call.config).toMatchObject({ validation: { unique: true, min: 0 } });
  });

  it("includes max in the submitted field for a number type", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={onSubmit}
        allDims={[]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/field name/i), {
      target: { value: "Score" },
    });
    fireEvent.click(screen.getByText("Number"));
    fireEvent.change(screen.getByLabelText(/^max$/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /add field/i }));

    const call = onSubmit.mock.calls[0][0] as { label: string; config: Record<string, unknown> };
    expect(call.config).toMatchObject({ validation: { max: 100 } });
  });

  it("uses 'Min length'/'Max length' labels for text type", () => {
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        allDims={[]}
      />,
    );

    // Text is the default type
    expect(screen.getByLabelText(/min length/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/max length/i)).toBeInTheDocument();
  });

  it("omits validation from config when no validation options are set", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={onSubmit}
        allDims={[]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/field name/i), {
      target: { value: "Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add field/i }));

    const call = onSubmit.mock.calls[0][0] as { label: string; config: Record<string, unknown> };
    expect(call.config).not.toHaveProperty("validation");
  });

  it("does not show Unique control for boolean type", () => {
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        allDims={[]}
      />,
    );

    fireEvent.click(screen.getByText("Checkbox"));
    expect(screen.queryByLabelText(/unique/i)).not.toBeInTheDocument();
  });

  it("does not show Range inputs for boolean type", () => {
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        allDims={[]}
      />,
    );

    fireEvent.click(screen.getByText("Checkbox"));
    expect(screen.queryByLabelText(/min length/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^min$/i)).not.toBeInTheDocument();
  });

  it("floors a fractional text min-length to a non-negative integer before submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={onSubmit}
        allDims={[]}
      />,
    );

    // Text is the default type
    fireEvent.change(screen.getByPlaceholderText(/field name/i), {
      target: { value: "Code" },
    });
    // Enter a fractional min length
    fireEvent.change(screen.getByLabelText(/min length/i), { target: { value: "3.9" } });
    fireEvent.click(screen.getByRole("button", { name: /add field/i }));

    const call = onSubmit.mock.calls[0][0] as { label: string; config: Record<string, unknown> };
    expect(call.config).toMatchObject({ validation: { min: 3 } });
  });

  it("includes unique true in the submitted field for text type", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AddFieldPopover
        anchorRef={{ current: makeAnchor() }}
        onClose={() => {}}
        onSubmit={onSubmit}
        allDims={[]}
      />,
    );

    // Text is default
    fireEvent.change(screen.getByPlaceholderText(/field name/i), {
      target: { value: "Code" },
    });
    fireEvent.click(screen.getByLabelText(/unique/i));
    fireEvent.click(screen.getByRole("button", { name: /add field/i }));

    const call = onSubmit.mock.calls[0][0] as { label: string; config: Record<string, unknown> };
    expect(call.config).toMatchObject({ validation: { unique: true } });
  });
});
