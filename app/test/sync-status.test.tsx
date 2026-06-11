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
        if (opts?.method) await gate;
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

  test("saved decays back to idle after ~1.5s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
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
