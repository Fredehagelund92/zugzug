import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRowActivity } from "../src/lib/use-row-activity";

/** Flush pending microtasks so async fetch Promises resolve without running timers. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRowActivity — push-driven", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries: [], serverTime: new Date().toISOString() }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("exactly one initial fetch, then a push schedules a single debounced refetch (~250ms)", async () => {
    const { rerender } = renderHook(
      ({ nonce }) => useRowActivity("d_country", { refetchNonce: nonce }),
      { initialProps: { nonce: 0 } },
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A push bumps the nonce. The refetch is debounced ~250ms.
    rerender({ nonce: 1 });
    // Not yet — still inside the debounce window.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Debounce fires.
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a burst of pushes coalesces into a single debounced refetch", async () => {
    const { rerender } = renderHook(
      ({ nonce }) => useRowActivity("d_country", { refetchNonce: nonce }),
      { initialProps: { nonce: 0 } },
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Three rapid bumps within the debounce window → one refetch.
    rerender({ nonce: 1 });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    rerender({ nonce: 2 });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    rerender({ nonce: 3 });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("no 5s poll: after 5s with no push, no extra fetch", async () => {
    renderHook(() => useRowActivity("d_country", { refetchNonce: 0 }));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("no refetch when the nonce does not change (binary frames never bump it)", async () => {
    const { rerender } = renderHook(
      ({ nonce }) => useRowActivity("d_country", { refetchNonce: nonce }),
      { initialProps: { nonce: 0 } },
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A binary yjs frame arrives at usePresence but never calls onRowTouched, so
    // the nonce is unchanged. Re-render with the same nonce → no refetch.
    rerender({ nonce: 0 });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("the 60s safety net still fires", async () => {
    renderHook(() => useRowActivity("d_country", { refetchNonce: 0 }));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
