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

  test("a concurrent success does not mask a failure — pill stays at failed", async () => {
    let releaseSuccess!: () => void;
    const gateSuccess = new Promise<void>((r) => (releaseSuccess = r));
    // W1 → fails immediately (500), W2 → held until after W1 rejects
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(async (_url: string, _opts?: RequestInit) => {
          // W1: fail immediately
          return new Response("boom", { status: 500 });
        })
        .mockImplementationOnce(async (_url: string, _opts?: RequestInit) => {
          // W2: block until released
          await gateSuccess;
          return new Response(null, { status: 204 });
        })
        // GET calls for the initial load
        .mockImplementation(
          async () =>
            new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
        ),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());

    let w1!: Promise<void>;
    let w2!: Promise<void>;
    act(() => {
      w1 = discardDraft("country", "usa").catch(() => undefined);
      w2 = discardDraft("country", "gbr").catch(() => undefined);
    });

    // Wait for W1 to reject
    await act(async () => {
      await w1;
    });

    // Now release W2 so writeSettled runs last
    releaseSuccess();
    await act(async () => {
      await w2;
    });

    // Pill must stay on failed — success must not mask the failure
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
