import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

describe("useAuthConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test("returns config after fetch", async () => {
    const cfg = {
      mode: "password" as const,
      signupOpen: false,
      allowedDomain: null,
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => cfg,
    })) as unknown as typeof fetch;

    const { useAuthConfig } = await import("../src/store");
    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => {
      expect(result.current).toEqual(cfg);
    });
  });

  test("returns null on invalid shape", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ mode: "saml" }),
    })) as unknown as typeof fetch;

    const { useAuthConfig } = await import("../src/store");
    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});
