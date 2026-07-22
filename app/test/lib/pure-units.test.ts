import { describe, test, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { readServerError } from "../../src/lib/api-errors";
import { formatNumber } from "../../src/components/datagrid/cells/NumberCell";
import { useAddQueue } from "../../src/hooks/use-add-queue";
import { useAsyncAction } from "../../src/hooks/useAsyncAction";

// ---------------------------------------------------------------------------
// readServerError
// ---------------------------------------------------------------------------

describe("readServerError", () => {
  test("extracts .error from JSON body", async () => {
    const res = new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    expect(await readServerError(res)).toBe("not found");
  });

  test("falls back to .message when .error is absent", async () => {
    const res = new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
    expect(await readServerError(res)).toBe("forbidden");
  });

  test("returns status code string when JSON has no error/message fields", async () => {
    const res = new Response(JSON.stringify({ ok: false }), { status: 500 });
    expect(await readServerError(res)).toBe("500");
  });

  test("returns status code string when body is not JSON", async () => {
    const res = new Response("Internal Server Error", { status: 500 });
    expect(await readServerError(res)).toBe("500");
  });

  test("returns status code string when JSON error field is empty string", async () => {
    const res = new Response(JSON.stringify({ error: "" }), { status: 422 });
    expect(await readServerError(res)).toBe("422");
  });
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

describe("formatNumber", () => {
  test("null value returns em dash", () => {
    expect(formatNumber(null, undefined)).toBe("—");
  });

  test("NaN value returns em dash", () => {
    expect(formatNumber(NaN, { format: "integer" })).toBe("—");
  });

  test("no format: returns plain string", () => {
    expect(formatNumber(42, undefined)).toBe("42");
  });

  test("integer format: thousands separator, no decimals", () => {
    expect(formatNumber(1234567, { format: "integer" })).toBe("1,234,567");
  });

  test("decimal format: fixed precision", () => {
    expect(formatNumber(42, { format: "decimal", precision: 2 })).toBe("42.00");
  });

  test("percent format: normalized (0.5 → 50%)", () => {
    expect(formatNumber(0.5, { format: "percent", precision: 0 })).toBe("50%");
  });

  test("currency prefix: symbol before digits", () => {
    expect(
      formatNumber(42, { format: "currency", symbol: "$", position: "prefix", precision: 2 }),
    ).toBe("$42.00");
  });

  test("currency suffix: space then symbol after digits", () => {
    expect(
      formatNumber(42, { format: "currency", symbol: "kr", position: "suffix", precision: 2 }),
    ).toBe("42.00 kr");
  });

  test("currency negative: minus sign is leftmost", () => {
    expect(
      formatNumber(-42, { format: "currency", symbol: "$", position: "prefix", precision: 2 }),
    ).toBe("-$42.00");
  });

  test("compact format: abbreviates large numbers", () => {
    expect(formatNumber(45000, { format: "compact", precision: 0 })).toBe("45K");
  });

  test("duration hms: zero-padded H:MM:SS", () => {
    expect(formatNumber(90, { format: "duration", display: "hms" })).toBe("0:01:30");
  });

  test("duration hm: < 1m for sub-minute", () => {
    expect(formatNumber(30, { format: "duration", display: "hm" })).toBe("< 1m");
  });
});

// ---------------------------------------------------------------------------
// useAddQueue
// ---------------------------------------------------------------------------

describe("useAddQueue", () => {
  test("runs jobs serially — second starts only after first resolves", async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];

    const run = vi.fn((label: string) => {
      order.push(`start:${label}`);
      return new Promise<void>((resolve) =>
        gates.push(() => {
          order.push(`end:${label}`);
          resolve();
        }),
      );
    });

    const { result } = renderHook(() => useAddQueue(run, () => {}));

    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
    });

    expect(result.current.pending).toBe(2);

    // Only first job started
    await waitFor(() => expect(order).toEqual(["start:a"]));

    // Resolve first; second should now start
    await act(async () => gates[0]!());
    await waitFor(() => expect(order).toEqual(["start:a", "end:a", "start:b"]));

    // Resolve second; pending drops to 0
    await act(async () => gates[1]!());
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("pending counter increments on enqueue and decrements on completion", async () => {
    const gates: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    );
    const { result } = renderHook(() => useAddQueue(run, () => {}));

    act(() => result.current.enqueue("x"));
    expect(result.current.pending).toBe(1);

    // Wait for the job to start (gate populated), then release it
    await waitFor(() => expect(gates).toHaveLength(1));
    await act(async () => gates[0]!());
    await waitFor(() => expect(result.current.pending).toBe(0));
  });

  test("a failing job surfaces via onError and does not block subsequent jobs", async () => {
    const errors: string[] = [];
    const run = vi.fn((label: string) =>
      label === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    const { result } = renderHook(() => useAddQueue(run, (label) => errors.push(label)));

    act(() => {
      result.current.enqueue("good1");
      result.current.enqueue("bad");
      result.current.enqueue("good2");
    });

    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(errors).toEqual(["bad"]);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// useAsyncAction
// ---------------------------------------------------------------------------

describe("useAsyncAction", () => {
  test("isPending is true while fn is in-flight, false after", async () => {
    let resolve: () => void = () => {};
    const fn = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { result } = renderHook(() => useAsyncAction(fn));

    expect(result.current.isPending).toBe(false);
    act(() => {
      void result.current.run();
    });
    expect(result.current.isPending).toBe(true);

    act(() => resolve());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.error).toBeNull();
  });

  test("re-entry WHILE the first call is in-flight is dropped, and the guard resets after", async () => {
    let resolve: () => void = () => {};
    const fn = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { result } = renderHook(() => useAsyncAction(fn));

    // Start the first call; it stays in-flight because the promise isn't resolved.
    act(() => {
      void result.current.run();
    });
    expect(result.current.isPending).toBe(true); // genuinely in-flight
    expect(fn).toHaveBeenCalledTimes(1);

    // A second call attempted while isPending is true must be dropped by the guard.
    act(() => {
      void result.current.run();
    });
    expect(result.current.isPending).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // still once — the re-entry was guarded

    // Finish the first call; the guard resets.
    act(() => resolve());
    await waitFor(() => expect(result.current.isPending).toBe(false));

    // Now a fresh call is allowed through.
    act(() => {
      void result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("rejected promise captures error and clears pending", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("boom")));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.error?.message).toBe("boom");
  });

  test("reset() clears error and pending", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("boom")));
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).not.toBeNull();

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });
});
