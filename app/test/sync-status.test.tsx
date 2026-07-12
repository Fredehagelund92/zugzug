import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

describe("useSyncStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("idle → saving while a write is in flight → saved after it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts?: RequestInit) => {
        if (opts?.method && opts.method !== "GET") await gate;
        if (!opts?.method || opts.method === "GET")
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        return new Response(null, { status: 204 });
      }),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());
    expect(result.current).toBe("idle");

    let done!: Promise<void>;
    act(() => {
      done = discardDraft("country", "usa").catch(() => undefined);
    });
    await waitFor(() => expect(result.current).toBe("saving"));

    release();
    await act(() => done);
    await waitFor(() => expect(result.current).toBe("saved"));
  });

  test("failed when a write rejects; the pill state does not report saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts?: RequestInit) => {
        if (opts?.method && opts.method !== "GET") return new Response("boom", { status: 500 });
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());

    let done!: Promise<void>;
    act(() => {
      done = discardDraft("country", "usa").catch(() => undefined);
    });
    await act(async () => {
      await done;
    });
    expect(result.current).toBe("failed");
  });

  test("saved decays back to idle after ~1.5s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts?: RequestInit) => {
        if (!opts?.method || opts.method === "GET")
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        return new Response(null, { status: 204 });
      }),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());
    await act(async () => {
      await discardDraft("country", "usa").catch(() => undefined);
    });
    await waitFor(() => expect(result.current).toBe("saved"));
    await waitFor(() => expect(result.current).toBe("idle"), { timeout: 3000 });
  });
});
