import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlash, FLASH_DURATION_MS } from "../src/hooks/useFlash";

describe("useFlash", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test("show() sets message; clears after FLASH_DURATION_MS", () => {
    const { result } = renderHook(() => useFlash());
    expect(result.current.message).toBeNull();
    act(() => result.current.show("scanned 42"));
    expect(result.current.message).toBe("scanned 42");
    expect(result.current.variant).toBe("success");
    act(() => { vi.advanceTimersByTime(FLASH_DURATION_MS); });
    expect(result.current.message).toBeNull();
  });

  test("show() with 'error' variant", () => {
    const { result } = renderHook(() => useFlash());
    act(() => result.current.show("scan failed", "error"));
    expect(result.current.variant).toBe("error");
  });

  test("second show() replaces the first and resets timer", () => {
    const { result } = renderHook(() => useFlash());
    act(() => result.current.show("first"));
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => result.current.show("second"));
    expect(result.current.message).toBe("second");
    act(() => { vi.advanceTimersByTime(FLASH_DURATION_MS - 1); });
    expect(result.current.message).toBe("second");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.message).toBeNull();
  });

  test("FLASH_DURATION_MS is 2800", () => {
    expect(FLASH_DURATION_MS).toBe(2800);
  });
});
