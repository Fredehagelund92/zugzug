import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { toast, clearToasts, ToastStack, TOAST_DURATION_MS } from "../src/components/Toast";

describe("toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => clearToasts());
  });
  afterEach(() => {
    act(() => {
      vi.runAllTimers();
    });
    vi.useRealTimers();
  });

  test("success toast renders and auto-dismisses after TOAST_DURATION_MS", () => {
    render(<ToastStack />);
    act(() => toast("scanned 42"));
    expect(screen.getByText("scanned 42")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS);
    });
    expect(screen.queryByText("scanned 42")).not.toBeInTheDocument();
  });

  test("error toast persists past the auto-dismiss window", () => {
    render(<ToastStack />);
    act(() => toast("scan failed", "error"));
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS * 3);
    });
    expect(screen.getByText("scan failed")).toBeInTheDocument();
  });

  test("error toast dismisses on click", () => {
    render(<ToastStack />);
    act(() => toast("scan failed", "error"));
    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByText("scan failed")).not.toBeInTheDocument();
  });

  test("multiple toasts stack; each success dismisses on its own timer", () => {
    render(<ToastStack />);
    act(() => toast("first"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => toast("second"));
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS - 1000);
    });
    expect(screen.queryByText("first")).not.toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  test("TOAST_DURATION_MS is 2800", () => {
    expect(TOAST_DURATION_MS).toBe(2800);
  });
});
