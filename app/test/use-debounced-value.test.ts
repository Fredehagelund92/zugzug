import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "../src/lib/use-debounced-value";

// #158: the debounce hook that keeps the Review search input responsive while
// throttling the fetch it drives to one call per pause.
describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("returns the initial value immediately", () => {
    const { result } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: "a" },
    });
    expect(result.current).toBe("a");
  });

  test("delays updates until the value stops changing for the delay window", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: "a" },
    });

    rerender({ v: "ab" });
    rerender({ v: "abc" });
    // Still the old value — the window has not elapsed and each change reset it.
    expect(result.current).toBe("a");

    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe("a");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("abc"); // one update, to the latest value
  });

  test("a keystroke within the window resets the timer (no intermediate emit)", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: "" },
    });
    rerender({ v: "x" });
    act(() => vi.advanceTimersByTime(200));
    rerender({ v: "xy" });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(""); // never emitted the intermediate "x"
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("xy");
  });
});
