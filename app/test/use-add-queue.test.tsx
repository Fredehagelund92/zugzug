import { describe, test, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAddQueue } from "../src/hooks/use-add-queue";

describe("useAddQueue", () => {
  test("runs adds serially in order and tracks pending count", async () => {
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
      result.current.enqueue("one");
      result.current.enqueue("two");
      result.current.enqueue("three");
    });
    expect(result.current.pending).toBe(3);
    // Only the first has started — the rest wait their turn.
    await waitFor(() => expect(order).toEqual(["start:one"]));

    await act(async () => gates[0]());
    await waitFor(() => expect(order).toEqual(["start:one", "end:one", "start:two"]));

    await act(async () => gates[1]());
    await act(async () => gates[2]());
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(order).toEqual([
      "start:one",
      "end:one",
      "start:two",
      "end:two",
      "start:three",
      "end:three",
    ]);
  });

  test("a failure surfaces via onError with its label and does not block later adds", async () => {
    const failed: string[] = [];
    const run = vi.fn((label: string) =>
      label === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    const { result } = renderHook(() => useAddQueue(run, (label) => failed.push(label)));
    act(() => {
      result.current.enqueue("good1");
      result.current.enqueue("bad");
      result.current.enqueue("good2");
    });
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(failed).toEqual(["bad"]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith("good2");
  });
});
