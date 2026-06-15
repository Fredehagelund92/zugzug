import { describe, it, expect } from "bun:test";
import { runWithConcurrency } from "./concurrency.ts";

describe("runWithConcurrency", () => {
  it("returns results in input order", async () => {
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // sanity: not sequential
  });

  it("errors in a work item resolve that slot to null", async () => {
    const out = await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(out).toEqual([1, null, 3]);
  });

  it("empty input returns empty array", async () => {
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("max=1 runs strictly sequentially", async () => {
    const order: number[] = [];
    await runWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      return n;
    });
    // Strict sequencing means start-end pairs never interleave.
    expect(order).toEqual([1, 1, 2, 2, 3, 3]);
  });
});
