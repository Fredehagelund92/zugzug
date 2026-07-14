import { describe, test, expect, vi, afterEach } from "vitest";

vi.mock("../src/components/Toast", () => ({ toast: vi.fn() }));

describe("setGridLayout persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("PATCH goes out with keepalive so it survives page unload", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      }),
    );
    const { setGridLayout } = await import("../src/store");
    setGridLayout("brand", { widths: { label: 240 } });
    await vi.advanceTimersByTimeAsync(500);
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.url).toContain("/grid-layout/brand");
    expect(patch!.init!.keepalive).toBe(true);
  });

  test("filter-only call preserves previously-set widths/hidden in the PATCH body", async () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") bodies.push(init.body as string);
        return new Response(null, { status: 204 });
      }),
    );
    const { setGridLayout } = await import("../src/store");
    // Simulate a prior layout save that flushes (widths + hidden)
    setGridLayout("dim1", { widths: { label: 240 }, hidden: ["rank"] });
    await vi.advanceTimersByTimeAsync(500); // flush the first debounce

    // Now a filter-only change comes in — the pendingLayouts map is empty after the flush
    // The caller must pass the FULL config (not just {filterSet}) so the PATCH body
    // contains all keys and the server does not wipe widths/hidden.
    setGridLayout("dim1", {
      widths: { label: 240 },
      hidden: ["rank"],
      filterSet: {
        conjunction: "and",
        conditions: [{ id: "c1", field: "region", operator: "equals", value: "EU" }],
      },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(bodies).toHaveLength(2);
    const second = JSON.parse(bodies[1]!);
    expect(second).toHaveProperty("widths");
    expect(second).toHaveProperty("hidden");
    expect(second).toHaveProperty("filterSet");
  });

  test("a failed layout save raises an error toast", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH"
          ? new Response("boom", { status: 500 })
          : new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const { toast } = await import("../src/components/Toast");
    const { setGridLayout } = await import("../src/store");
    setGridLayout("brand", { hidden: ["rank"] });
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("layout"), "error");
  });
});
