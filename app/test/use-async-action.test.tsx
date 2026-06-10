import { describe, test, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAsyncAction } from "../src/hooks/useAsyncAction";

describe("useAsyncAction", () => {
  test("run() invokes fn and reflects pending state", async () => {
    let resolve: (v: void) => void = () => undefined;
    const fn = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { result } = renderHook(() => useAsyncAction(fn));

    expect(result.current.isPending).toBe(false);
    act(() => { void result.current.run(); });
    expect(result.current.isPending).toBe(true);

    act(() => resolve());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  test("re-entry while pending is silently dropped", async () => {
    let resolve: (v: void) => void = () => undefined;
    const fn = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { result } = renderHook(() => useAsyncAction(fn));

    act(() => { void result.current.run(); });
    act(() => { void result.current.run(); });
    act(() => { void result.current.run(); });

    act(() => resolve());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("rejected promise surfaces error and clears pending", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("boom")));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => { await result.current.run(); });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error?.message).toBe("boom");
  });

  test("reset() clears error and pending", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("boom")));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => { await result.current.run(); });
    expect(result.current.error).not.toBeNull();
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });

  test("args are forwarded to fn", async () => {
    const fn = vi.fn((a: string, b: number) => Promise.resolve());
    const { result } = renderHook(() => useAsyncAction(fn));
    await act(async () => { await result.current.run("hello", 7); });
    expect(fn).toHaveBeenCalledWith("hello", 7);
  });
});
