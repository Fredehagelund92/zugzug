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
