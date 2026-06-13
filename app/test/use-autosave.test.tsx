import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutosave } from "../src/hooks/useAutosave";

describe("useAutosave", () => {
  it("debounces save calls", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 500), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    rerender({ v: "abc" });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc");
    expect(result.current.status).toBe("saved");
    vi.useRealTimers();
  });

  it("does not save if value matches initial", async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    renderHook(({ v }) => useAutosave(v, save, 500), { initialProps: { v: "a" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports error status when save throws", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValue(new Error("network"));
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 100), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("network");
    vi.useRealTimers();
  });
});
