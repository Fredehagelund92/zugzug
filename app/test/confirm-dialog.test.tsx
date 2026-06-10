import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

describe("ConfirmDialog", () => {
  test("renders title and body when open", () => {
    render(
      <ConfirmDialog
        open
        title="Revoke token?"
        body={'Token "prod" will stop working immediately.'}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText(/revoke token\?/i)).toBeInTheDocument();
    expect(screen.getByText(/will stop working/i)).toBeInTheDocument();
  });

  test("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="Revoke?"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("clicking confirm fires onConfirm", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  test("clicking cancel fires onCancel", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("Escape key fires onCancel", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("backdrop click fires onCancel", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    const backdrop = screen.getByTestId("confirm-dialog-backdrop");
    await userEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("danger variant adds danger styling to confirm button", () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        confirmLabel="Delete"
        danger
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: /^delete$/i });
    expect(confirmBtn.className).toMatch(/danger/);
  });

  test("autofocus lands on cancel button (so Enter doesn't accidentally confirm)", async () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /cancel/i })),
    );
  });

  test("Tab from confirm button wraps back to cancel (focus trap)", async () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const confirm = screen.getByRole("button", { name: /^delete$/i });
    confirm.focus();
    expect(document.activeElement).toBe(confirm);
    // Tab from confirm (last focusable) wraps to cancel (first).
    // fireEvent.keyDown dispatches directly to the document listener — no
    // userEvent focus arbitration to race with our handler's preventDefault.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
  });

  test("Shift+Tab from cancel button wraps to confirm", () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const confirm = screen.getByRole("button", { name: /^delete$/i });
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });
});
