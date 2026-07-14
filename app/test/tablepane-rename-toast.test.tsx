import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenameConfirmation } from "../src/components/RenameConfirmation";

describe("RenameConfirmation overlay toast", () => {
  const baseProps = {
    prev: "ACME Corp",
    next: "Acme Corporation",
    variants: 3,
    canUndo: true,
    onUndo: vi.fn(),
    onDismiss: vi.fn(),
  };

  test("root element has absolute positioning (does not shift layout)", () => {
    const { container } = render(<RenameConfirmation {...baseProps} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\babsolute\b/);
  });

  test("copy uses 'source value' and NOT 'raw'", () => {
    render(<RenameConfirmation {...baseProps} />);
    expect(screen.getByText(/source value/i)).toBeInTheDocument();
    expect(screen.queryByText(/raw/i)).toBeNull();
  });

  test("copy is singular for 1 variant", () => {
    render(<RenameConfirmation {...baseProps} variants={1} />);
    expect(screen.getByText(/1 source value re-pointed/i)).toBeInTheDocument();
  });

  test("copy is plural for multiple variants", () => {
    render(<RenameConfirmation {...baseProps} variants={5} />);
    expect(screen.getByText(/5 source values re-pointed/i)).toBeInTheDocument();
  });

  test("Undo button fires onUndo", async () => {
    const onUndo = vi.fn();
    render(<RenameConfirmation {...baseProps} onUndo={onUndo} />);
    await userEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  test("Dismiss button fires onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<RenameConfirmation {...baseProps} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("Undo button is disabled when canUndo is false", () => {
    render(<RenameConfirmation {...baseProps} canUndo={false} />);
    expect(screen.getByRole("button", { name: /undo/i })).toBeDisabled();
  });

  test("shows prev and next names in the message", () => {
    render(<RenameConfirmation {...baseProps} />);
    expect(screen.getByText(/ACME Corp/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corporation/)).toBeInTheDocument();
  });
});
