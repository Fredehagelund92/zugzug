import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRowActivity } from "../src/lib/use-row-activity";

/** Flush pending microtasks so async fetch Promises resolve without running timers. */
async function flushMicrotasks() {
  // Three ticks: fetch → .json() → setState
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRowActivity", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            entries: [
              {
                rowKey: "dk",
                userId: "u_mia",
                displayName: "Mia Berg",
                op: "rename",
                at: new Date().toISOString(),
              },
            ],
            serverTime: new Date().toISOString(),
          }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("returns empty map when tableId is null", () => {
    const { result } = renderHook(() => useRowActivity(null));
    expect(result.current.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("polls and returns map of entries by rowKey", async () => {
    const { result } = renderHook(() => useRowActivity("d_country"));
    await flushMicrotasks();
    expect(result.current.size).toBe(1);
    expect(result.current.get("dk")?.displayName).toBe("Mia Berg");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/tables/d_country/row-activity"),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("does not poll every 5 seconds (push-driven now)", async () => {
    renderHook(() => useRowActivity("d_country"));
    // Flush initial fetch
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Advance 5s — no poll loop, so no extra fetch (see use-row-activity-push
    // for the debounced push refetch and the 60s safety net).
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cleans up safety-net interval on unmount", async () => {
    const { unmount } = renderHook(() => useRowActivity("d_country"));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("changing tableId restarts the poll for the new id", async () => {
    const { result, rerender } = renderHook(({ id }) => useRowActivity(id), {
      initialProps: { id: "d_a" as string | null },
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ id: "d_b" });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/tables/d_b/row-activity"),
      expect.objectContaining({ credentials: "include" }),
    );
    // Map is reset when tableId changes
    expect(result.current.size).toBeGreaterThanOrEqual(0);
  });
});
