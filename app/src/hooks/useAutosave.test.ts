import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutosave } from "./useAutosave";

describe("useAutosave", () => {
  it("calls onSaved after a successful save", async () => {
    const onSaved = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value }: { value: string }) => useAutosave(value, save, 0, onSaved),
      { initialProps: { value: "x" } },
    );

    // Trigger a save by changing the value.
    await act(async () => {
      rerender({ value: "y" });
    });

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it("swallows onSaved errors and stays in 'saved' status", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onSaved = vi.fn().mockRejectedValue(new Error("boom"));
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, result } = renderHook(
      ({ value }: { value: string }) => useAutosave(value, save, 0, onSaved),
      { initialProps: { value: "x" } },
    );

    await act(async () => {
      rerender({ value: "y" });
    });

    await waitFor(() => {
      expect(save).toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalled();
      expect(result.current.status).not.toBe("error");
    });

    consoleError.mockRestore();
  });
});
